import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	createEventBus,
	createExtensionRuntime,
	ExtensionRunner,
	SessionManager,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { loadExtensionFromFactory } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js";
import { bootstrapProfilesFile, createProfile, profilesFilePath, writeProfilesFileSync } from "../lib/agent-profiles.ts";
import { NativeReviewConsentRequiredError, type NativeReviewCli } from "../lib/native-review-cli.ts";
import { CandidateViewRegistry } from "../lib/review-candidate-view.ts";
import { decodeReviewConsentV3, type ReviewStatusV3 } from "../lib/review-integration-v2.ts";
import { captureReviewSessionIdentity, hasReviewSessionPermission } from "../lib/review-session-standing-permission.ts";
import { createGentleAiExtension, __testing } from "../extensions/gentle-ai.ts";

// Deterministic regression coverage for the fork-only YOLO loadout. Every
// scenario runs the real extension factory against a real temporary Git
// repository; only the terminal UI and the native review CLI are stubbed.

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;
type Command = { handler: (args: string, ctx: ExtensionContext) => Promise<void> };

const roots: string[] = [];
process.once("exit", () => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });

function gitRepository(t: test.TestContext): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "local-yolo-patch-")));
	roots.push(root);
	t.after(() => { try { execFileSync("chmod", ["-R", "u+w", root], { stdio: "ignore" }); } catch { /* best effort */ } });
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: root, encoding: "utf8" });
	git("init", "-q", "-b", "main");
	writeFileSync(join(root, "README.md"), "base\n");
	git("add", "README.md");
	git("commit", "-q", "-m", "base");
	return root;
}

function isolatedEnv(t: test.TestContext, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const home = mkdtempSync(join(tmpdir(), "local-yolo-patch-config-"));
	roots.push(home);
	t.after(() => rmSync(home, { recursive: true, force: true }));
	return { GENTLE_PI_CONFIG_HOME: home, GENTLE_AI_TELEMETRY: "0", ...extra };
}

function harness(t: test.TestContext, options: {
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	native?: NativeReviewCli;
} = {}) {
	const cwd = options.cwd ?? gitRepository(t);
	const env = options.env ?? isolatedEnv(t);
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, Command>();
	const notifications: Array<{ message: string; level?: string }> = [];
	const sent: Array<{ message: unknown; options: unknown }> = [];
	const entries: Array<{ type: string; customType?: string; data?: unknown }> = [];
	let confirms = 0;
	let selects = 0;
	let usage: { tokens: number | null; contextWindow: number; percent: number | null } | undefined;
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		sessionManager: {
			getSessionId: () => "session-a",
			getBranch: () => entries,
			getEntries: () => entries,
			getCwd: () => cwd,
		},
		model: { id: "fixture-model", provider: "fixture-provider" },
		getContextUsage: () => usage,
		ui: {
			notify: (message: string, level?: string) => notifications.push({ message, level }),
			setStatus() {},
			setWidget() {},
			confirm: async () => { confirms += 1; return false; },
			select: async () => { selects += 1; return undefined; },
			custom: async () => undefined,
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			getAllThemes: () => [{ name: "fixture" }],
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		registerTool(definition: { name: string }) { void definition; },
		registerMessageRenderer() {},
		registerFlag() {},
		appendEntry(type: string, data: unknown) { entries.push({ type: "custom", customType: type, data }); },
		sendMessage(message: unknown, sendOptions: unknown) { sent.push({ message, options: sendOptions }); },
		getActiveTools: () => [],
		getAllTools: () => [],
		getSettings: () => ({}),
		events: { on() {}, emit() {} },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: options.native ?? null,
		candidateViews: null,
		processEnv: env,
		resolveTelemetryTriggerBinary: () => { throw new Error("telemetry disabled in test"); },
	})(pi);
	const emit = async (name: string, event: unknown): Promise<unknown> => {
		let result: unknown;
		for (const handler of handlers.get(name) ?? []) {
			const next = await handler(event, ctx);
			if (next !== undefined) result = next;
		}
		return result;
	};
	const command = async (args: string) => {
		const definition = commands.get("gentle:yolo");
		assert.ok(definition, "/gentle:yolo registered");
		await definition.handler(args, ctx);
	};
	const start = async () => { await emit("session_start", { reason: "startup" }); };
	const prompt = async (toolGuidelines?: Record<string, string[]>) => {
		const options = { appendSystemPrompt: "base", toolGuidelines: toolGuidelines ?? {} } as {
			appendSystemPrompt: string;
			toolGuidelines: Record<string, string[]>;
		};
		await emit("before_agent_start", { prompt: "task", systemPromptOptions: options, systemPrompt: "base" });
		return options;
	};
	return {
		cwd, env, ctx, notifications, sent, entries, emit, command, start, prompt,
		confirms: () => confirms,
		selects: () => selects,
		setUsage: (tokens: number | null, contextWindow = 1_000_000) => {
			usage = { tokens, contextWindow, percent: tokens === null ? null : (tokens / contextWindow) * 100 };
		},
	};
}

const commandCall = (h: ReturnType<typeof harness>, command: string) =>
	h.emit("tool_call", { toolName: "bash", input: { command } });

test("primary YOLO gates the command path, prompt, backstop, delivery notice and review follow-up; Normal keeps them", async (t) => {
	let statusCalls = 0;
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: "on", source: "default" } }),
		targetStatus: async () => { statusCalls += 1; return undefined; },
	} as unknown as NativeReviewCli;
	const h = harness(t, { native });
	await h.start();
	const normalPrompt = await h.prompt();
	assert.match(normalPrompt.appendSystemPrompt, /Default workflow: Organic Driven Development/);
	assert.doesNotMatch(normalPrompt.appendSystemPrompt, /gentle-yolo-session/);
	h.setUsage(200_000);
	assert.match(((await h.emit("tool_result", { toolName: "read", toolCallId: "read-1", isError: false, input: { path: "a.ts" }, content: [{ type: "text", text: "body" }] })) as { content?: Array<{ text?: string }> } | undefined)?.content?.[1]?.text ?? "", /Context backstop/);

	await h.command("enable");
	await commandCall(h, "git push origin main");
	await h.command("status");
	const yoloPrompt = await h.prompt();
	assert.match(yoloPrompt.appendSystemPrompt, /gentle-yolo-session/, "the YOLO directive still accompanies the identity block");
	assert.doesNotMatch(yoloPrompt.appendSystemPrompt, /Default workflow: Organic Driven Development/);
	assert.doesNotMatch(yoloPrompt.appendSystemPrompt, /Spanish|español|voseo|Rioplatense/);
	assert.ok(yoloPrompt.appendSystemPrompt.length > "base".length, "identity and continuity text remain");
	assert.equal(await commandCall(h, "git push origin main && rm -rf ./data"), undefined, "primary YOLO skips the command gate, destructive included");
	const readResult = await h.emit("tool_result", { toolName: "read", toolCallId: "read-2", isError: false, input: { path: "a.ts" }, content: [{ type: "text", text: "body" }] });
	assert.equal(readResult, undefined, "no automatic context backstop notice in YOLO");

	writeFileSync(join(h.cwd, "app.ts"), "export const value = 1;\n");
	await h.emit("tool_result", { toolName: "write", toolCallId: "write-1", isError: false, input: { path: join(h.cwd, "app.ts") }, content: [{ type: "text", text: "Wrote app.ts" }] });
	h.setUsage(200_000);
	const beforeYoloEnd = statusCalls;
	await h.emit("agent_end", {});
	assert.equal(statusCalls, beforeYoloEnd, "YOLO never negotiates an automatic review follow-up");

	await h.command("disable");
	assert.match((await h.prompt()).appendSystemPrompt, /Default workflow: Organic Driven Development/);
	assert.doesNotMatch((await h.prompt()).appendSystemPrompt, /gentle-yolo-session/);
	assert.ok(await commandCall(h, "git push origin main && rm -rf ./data"), "Normal restores the command gate");
	const beforeNormalEnd = statusCalls;
	await h.emit("agent_end", {});
	assert.ok(statusCalls > beforeNormalEnd, "Normal still negotiates the review follow-up");
});

test("normal-mode agent_end reaches native STATUS while nested depth and children never inherit the bypass", async (t) => {
	let statusCalls = 0;
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: "on", source: "default" } }),
		targetStatus: async () => { statusCalls += 1; return undefined; },
	} as unknown as NativeReviewCli;
	const h = harness(t, { native });
	await h.start();
	await h.command("enable");
	writeFileSync(join(h.cwd, "app.ts"), "export const value = 1;\n");
	await h.emit("tool_result", { toolName: "write", toolCallId: "write-depth", isError: false, input: { path: join(h.cwd, "app.ts") }, content: [{ type: "text", text: "Wrote app.ts" }] });
	// A named agent start marks nested depth; the YOLO command bypass must fail closed.
	await h.emit("before_agent_start", { prompt: "child", agent: { name: "worker" }, systemPromptOptions: { appendSystemPrompt: "base" }, systemPrompt: "base" });
	assert.ok(await commandCall(h, "git push origin main && rm -rf ./data"), "a nested agent keeps the command gate");
	const beforeNestedEnd = statusCalls;
	await h.emit("agent_end", {});
	assert.equal(statusCalls, beforeNestedEnd, "the nested end only decrements depth");

	const child = harness(t, { native, env: isolatedEnv(t, { GENTLE_PI_AGENTS_CHILD: "1" }) });
	await child.start();
	await child.command("enable");
	assert.ok(await commandCall(child, "git push origin main"), "children never receive the YOLO command bypass");
	const childPrompt = await child.prompt();
	assert.doesNotMatch(childPrompt.appendSystemPrompt, /gentle-yolo-session/);
});

test("ASSESS guidance is advisory only in YOLO and returns to the registered text when YOLO ends", async (t) => {
	const h = harness(t);
	await h.start();
	const original = 'ASSESS (gentle-pi#662/#668) is read-only and needs no lineageId: registered wording.';
	const other = "KEEP: an unrelated guideline.";
	const normal = await h.prompt({ gentle_review: [original, other] });
	assert.deepEqual(normal.toolGuidelines.gentle_review, [original, other]);

	await h.command("enable");
	const yolo = await h.prompt({ gentle_review: [original, other] });
	assert.match(yolo.toolGuidelines.gentle_review[0], /^ASSESS is optional and read-only/);
	assert.match(yolo.toolGuidelines.gentle_review[0], /advisory/);
	assert.match(yolo.toolGuidelines.gentle_review[0], /never authorizes delivery/);
	assert.equal(yolo.toolGuidelines.gentle_review[1], other);

	await h.command("disable");
	const restored = await h.prompt({ gentle_review: [original, other] });
	assert.deepEqual(restored.toolGuidelines.gentle_review, [original, other], "normal mode keeps the original text");
});

test("a YOLO primary commit omits the delivery-slice notice while Normal still reports it", async (t) => {
	const h = harness(t);
	await h.start();
	execFileSync("git", ["switch", "-q", "-c", "feat/yolo"], { cwd: h.cwd });
	writeFileSync(join(h.cwd, "slice.ts"), "one\n");
	execFileSync("git", ["add", "slice.ts"], { cwd: h.cwd });
	const event = { toolName: "bash", toolCallId: "commit-1", isError: false, input: { command: "git commit -m 'feat: slice'" }, content: [{ type: "text", text: "[feat/yolo 1234567] feat: slice" }] };
	await h.command("enable");
	const yolo = (await h.emit("tool_result", event)) as { content?: Array<{ text?: string }> } | undefined;
	assert.doesNotMatch(JSON.stringify(yolo ?? {}), /Commit slice/);
	await h.command("disable");
	execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "feat: slice"], { cwd: h.cwd });
	writeFileSync(join(h.cwd, "slice.ts"), "two\n");
	execFileSync("git", ["add", "slice.ts"], { cwd: h.cwd });
	const normal = (await h.emit("tool_result", event)) as { content?: Array<{ text?: string }> } | undefined;
	assert.match(JSON.stringify(normal ?? {}), /Commit slice/);
});

test("profile routing confirmation is skipped with a warning only when the YOLO gate says so", async (t) => {
	const setup = () => {
		const env = isolatedEnv(t);
		const cwd = gitRepository(t);
		const previous = process.env.GENTLE_PI_CONFIG_HOME;
		process.env.GENTLE_PI_CONFIG_HOME = env.GENTLE_PI_CONFIG_HOME;
		t.after(() => {
			if (previous === undefined) delete process.env.GENTLE_PI_CONFIG_HOME;
			else process.env.GENTLE_PI_CONFIG_HOME = previous;
		});
		const filePath = profilesFilePath(env.GENTLE_PI_CONFIG_HOME!);
		const file = createProfile(bootstrapProfilesFile({}), "team", { worker: { model: "openai/alpha" } });
		writeProfilesFileSync(filePath, file);
		const notifications: Array<{ message: string; level?: string }> = [];
		let confirms = 0;
		const ctx = {
			cwd,
			hasUI: true,
			sessionManager: { getSessionId: () => "session-profile" },
			ui: { notify: (message: string, level?: string) => notifications.push({ message, level }), confirm: async () => { confirms += 1; return true; } },
		} as unknown as ExtensionContext;
		const live = { setModel: async () => true, setThinkingLevel() {}, getThinkingLevel: () => "medium" as const };
		return { ctx, live, filePath, file, notifications, confirms: () => confirms };
	};
	const action = { type: "apply-global" as const, name: "team" };

	const yolo = setup();
	await __testing.runProfilesPanelAction(yolo.ctx, yolo.live, yolo.filePath, yolo.file, action, {}, async () => true);
	assert.equal(yolo.confirms(), 0, "YOLO applies the global routing without a confirmation");
	assert.ok(yolo.notifications.some((entry) => entry.level === "warning" && entry.message.includes('Profile "team"')), `the disclosure stays visible: ${JSON.stringify(yolo.notifications)}`);

	const normal = setup();
	await __testing.runProfilesPanelAction(normal.ctx, normal.live, normal.filePath, normal.file, action, {}, async () => false);
	assert.equal(normal.confirms(), 1, "Normal keeps the confirmation dialog");
});

function reviewRepository(t: test.TestContext): string {
	const root = gitRepository(t);
	writeFileSync(join(root, "app.ts"), "export const value = 2;\n");
	return root;
}

function piConsent() {
	const raw = JSON.parse(readFileSync(join(process.cwd(), "tests", "fixtures", "devbinary", "consent-v3.captured.json"), "utf8")) as Record<string, unknown>;
	raw.agent = "pi";
	const decoded = decodeReviewConsentV3(raw, "pi");
	return {
		...decoded,
		choices: [
			{ ...decoded.choices[0], invocation: decoded.choices[0].invocation.replace(" --consent ", " --agent pi --consent ") },
			{ ...decoded.choices[1], invocation: decoded.choices[1].invocation.replace(" --consent ", " --agent pi --consent ") },
		] as const,
	};
}

function startStatus(cwd: string): ReviewStatusV3 {
	const views = new CandidateViewRegistry();
	const candidate = views.create({ contributorRoot: cwd });
	try {
		return {
			contract: "gentle-ai.review-integration/v2",
			applicability: "unrelated",
			action: "start",
			replayability: "not_replayable",
			targetIdentity: `sha256:${"a".repeat(64)}`,
			projection: {
				schema: "gentle-ai.review-candidate-projection/v1",
				kind: "current-changes",
				projection: "workspace",
				baseTree: candidate.baseTree,
				initialReviewTree: candidate.candidateTree,
				currentCandidateTree: candidate.candidateTree,
				pathsDigest: `sha256:${"a".repeat(64)}`,
				paths: [...candidate.paths],
				intendedUntracked: [],
				intendedUntrackedProof: `sha256:${"a".repeat(64)}`,
				initialSnapshotIdentity: `sha256:${"a".repeat(64)}`,
				currentSnapshotIdentity: `sha256:${"a".repeat(64)}`,
			},
			candidates: [],
			raw: { schema: "gentle-ai.review-integration.status/v5" },
		} as unknown as ReviewStatusV3;
	} finally {
		views.cleanup(candidate.token);
	}
}

function consentHarness(t: test.TestContext, authoriseYolo: boolean) {
	const cwd = reviewRepository(t);
	const consent = piConsent();
	const answers: string[] = [];
	let prompts = 0;
	const tools = new Map<string, { execute: (id: string, parameters: unknown, signal: undefined, update: undefined, ctx: ExtensionContext) => Promise<{ details: Record<string, unknown> }> }>();
	const commands = new Map<string, Command>();
	const handlers = new Map<string, Handler[]>();
	const native = {
		reviewMode: async () => ({ operation: "status", scope: "clone", status: { global: "", cloneLocal: "", effective: "on", source: "default" } }),
		targetStatus: async () => startStatus(cwd),
		start: async () => { throw new NativeReviewConsentRequiredError(consent); },
		answerConsent: async (request: { answer: "granted" | "declined" }) => {
			answers.push(request.answer);
			return { kind: "started", start: { lineageId: `lineage-${answers.length}`, state: "approved", riskLevel: "high", selectedLenses: [], changedFiles: 1, changedLines: 2, correctionBudget: 0, action: "closed", lensesRequired: false, riskReasons: [] } };
		},
	} as unknown as NativeReviewCli;
	const env = isolatedEnv(t);
	const ctx = {
		cwd,
		mode: "tui",
		hasUI: true,
		sessionManager: { getSessionId: () => "session-consent", getBranch: () => [], getCwd: () => cwd },
		ui: {
			notify() {}, setStatus() {},
			custom: async () => { prompts += 1; return undefined; },
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			getAllThemes: () => [{ name: "fixture" }],
		},
	} as unknown as ExtensionContext;
	const pi = {
		on(name: string, handler: Handler) { const list = handlers.get(name) ?? []; list.push(handler); handlers.set(name, list); },
		registerCommand(name: string, command: Command) { commands.set(name, command); },
		registerTool(definition: { name: string; execute: never }) { tools.set(definition.name, definition); },
		registerMessageRenderer() {}, registerFlag() {}, appendEntry() {}, sendMessage() {},
		getActiveTools: () => [], getAllTools: () => [], getSettings: () => ({}),
		events: { on() {}, emit() {} },
	} as unknown as ExtensionAPI;
	createGentleAiExtension({
		nativeReviewCli: native,
		candidateViews: new CandidateViewRegistry(),
		processEnv: env,
		resolveTelemetryTriggerBinary: () => { throw new Error("telemetry disabled in test"); },
	})(pi);
	return {
		cwd, ctx, consent,
		answers, prompts: () => prompts,
		start: async () => {
			for (const handler of handlers.get("session_start") ?? []) await handler({ reason: "startup" }, ctx);
			if (authoriseYolo) {
				const yolo = commands.get("gentle:yolo");
				assert.ok(yolo);
				await yolo!.handler("enable", ctx);
			}
			const controller = tools.get("gentle_review");
			assert.ok(controller);
			return await controller!.execute("start", { operation: "start", input: JSON.stringify({ mode: "ordinary" }) }, undefined, undefined, ctx);
		},
	};
}

test.skip("YOLO answers one validated review consent without a dialog and never creates standing permission", { skip: "candidate-view fixture drift rejects START before consent; track with a real native review fixture" }, async (t) => {
	const yolo = consentHarness(t, true);
	const details = (await yolo.start()).details;
	assert.equal(details.operation, "answer-consent", JSON.stringify(details));
	assert.deepEqual(yolo.answers, ["granted"], "the exact provider grant is relayed once");
	assert.equal(yolo.prompts(), 0, "no host consent dialog opens in YOLO");
	const identity = await captureReviewSessionIdentity(yolo.ctx, {});
	assert.ok(identity);
	assert.equal(hasReviewSessionPermission(identity), false, "no standing review permission is created");

	const normal = consentHarness(t, false);
	const unresolved = (await normal.start()).details;
	assert.equal(unresolved.outcome, "native-review-consent-required");
	assert.deepEqual(normal.answers, [], "Normal still asks the human");
	assert.equal(normal.prompts(), 1);
});

test("the actual SDK loader executes the YOLO gate and restores Normal after disable", async (t) => {
	const cwd = gitRepository(t);
	const env = isolatedEnv(t);
	const runtime = createExtensionRuntime();
	const extension = await loadExtensionFromFactory(
		createGentleAiExtension({
			nativeReviewCli: null,
			candidateViews: null,
			processEnv: env,
			resolveTelemetryTriggerBinary: () => { throw new Error("telemetry disabled in test"); },
		}),
		cwd,
		createEventBus(),
		runtime,
	);
	const runner = new ExtensionRunner([extension], runtime, cwd, SessionManager.inMemory(cwd), {} as never);
	t.after(() => runner.invalidate());
	const notifications: string[] = [];
	runner.setUIContext({
		notify: (text: string) => notifications.push(text),
		setStatus() {}, setWidget() {}, confirm: async () => false, select: async () => undefined,
		getAllThemes: () => [{ name: "fixture" }],
	} as unknown as ExtensionUIContext, "tui");
	runner.bindCommandContext();
	const ctx = runner.createCommandContext();
	if (ctx.mode === undefined) Object.defineProperty(ctx, "mode", { value: "tui" });
	await runner.emit({ type: "session_start", reason: "startup" });
	const command = runner.getCommand("gentle:yolo");
	assert.ok(command);
	const options = () => ({ appendSystemPrompt: "base" });
	const runPrompt = async () => {
		const value = options();
		await extension.handlers.get("before_agent_start")![0]({ type: "before_agent_start", prompt: "task", systemPromptOptions: value, systemPrompt: "base" } as never, ctx);
		return value.appendSystemPrompt;
	};
	await command!.handler("enable", ctx);
	assert.match(await runPrompt(), /gentle-yolo-session/);
	assert.doesNotMatch(await runPrompt(), /Default workflow: Organic Driven Development/);
	const toolCall = async (value: string) => await extension.handlers.get("tool_call")![0]({ toolName: "bash", input: { command: value } }, ctx);
	assert.equal(await toolCall("git push origin main && rm -rf ./data"), undefined);
	await command!.handler("disable", ctx);
	const restored = await runPrompt();
	assert.match(restored, /Default workflow: Organic Driven Development/);
	assert.doesNotMatch(restored, /gentle-yolo-session/);
	assert.ok(await toolCall("git push origin main && rm -rf ./data"), "Normal blocks again through the real SDK-loaded extension");
});
