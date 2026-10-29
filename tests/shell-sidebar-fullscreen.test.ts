import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, TuiAltScreen, type Component } from "@earendil-works/pi-tui";
import { getLayoutBoxesAt, renderLayoutFrame } from "@earendil-works/pi-tui/dist/layout.js";
import { createChatViewport } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/chat-viewport.js";
import { installSidebar } from "../lib/shell-sidebar-layout.ts";
import { sidebarHeader, sidebarPart } from "../lib/shell-sidebar.ts";

// End-to-end through pi-tui's real alt-screen renderer and Pi's real chat
// viewport: the unit fixtures elsewhere hand-build layout nodes, which is how
// two earlier attempts at this row passed their tests and still failed live.
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const strip = (text: string) => text.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\s+$/, "");
const lines = (rows: string[]): Component => ({ render: () => rows, invalidate() {} });

function viewport(columns: number, rows: number, sidebar: boolean) {
	const terminal = {
		start() {}, stop() {}, async drainInput() {}, write() {},
		get columns() { return columns; }, get rows() { return rows; },
		moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {}, clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
		kittyProtocolActive: false, getBufferedInput() { return ""; }, hasPendingInput() { return false; },
	} as never;
	const above = new Container();
	above.addChild(new Spacer(1)); // Pi adds a spacer above the editor when no widget is shown
	const footer = new Container();
	const viewport = createChatViewport({
		document: lines(Array.from({ length: 60 }, (_, i) => `transcript ${i + 1}`)),
		pendingMessages: new Container(), status: new Container(), widgetsAbove: above,
		editor: lines(["╭─ editor ─╮", "│ prompt   │", "╰──────────╯"]),
		widgetsBelow: new Container(), footer, scrollbar: "auto",
	});
	const tui = new TuiAltScreen(terminal, false);
	tui.setLayoutRoot(viewport.root);
	let dispose = () => {};
	if (sidebar) {
		footer.addChild(sidebarPart(tui, "footer", lines(["BOTTOM BAR"]), { render: () => ["Status card"], invalidate() {} }));
		sidebarHeader(tui, { render: (width: number) => [`HEADER ${width}`], invalidate() {} });
		dispose = installSidebar(tui, theme);
	} else {
		footer.addChild(lines(["BOTTOM BAR"]));
	}
	tui.start();
	return { above, tui, root: viewport.root, dispose, resize: (width: number) => { columns = width; } };
}

async function capture(tui: TuiAltScreen): Promise<string[]> {
	tui.requestRender(true);
	await new Promise((resolve) => setTimeout(resolve, 20));
	return ((tui as unknown as { previousScreen: string[] }).previousScreen ?? []).map(strip);
}

async function renderViewport(columns: number, rows: number, sidebar: boolean): Promise<string[]> {
	const f = viewport(columns, rows, sidebar);
	try { return await capture(f.tui); }
	finally { f.dispose(); f.tui.stop(); }
}

test("fullscreen with the sidebar leaves no blank row between the editor and the terminal edge", async () => {
	const screen = await renderViewport(140, 24, true);
	assert.equal(screen[0], "HEADER 138", "the header owns the first row");
	assert.match(screen[screen.length - 1] ?? "", /^╰/, `the editor's bottom border sits on the last row, got ${JSON.stringify(screen.slice(-3))}`);
	assert.ok(screen.some((row) => row.startsWith("╭─ editor")), "the editor is still painted");
	assert.ok(screen.some((row) => row.includes("Status card")), "the rail is still painted");
});

test("fullscreen removes only the native above-composer spacer across resize and widget updates", async (t) => {
	const f = viewport(140, 24, true);
	t.after(() => { f.dispose(); f.tui.stop(); });
	for (const width of [140, 100, 140]) {
		f.resize(width);
		for (const widgetRows of [[], ["", "widget notice"], []]) {
			f.above.clear();
			f.above.addChild(new Spacer(1));
			if (widgetRows.length) f.above.addChild(lines(widgetRows));
			const screen = await capture(f.tui);
			const editor = screen.findIndex(row => row.startsWith("╭─ editor"));
			assert.ok(editor > 0, "composer header survives");
			if (widgetRows.length) {
				assert.match(screen[editor - 1]!, /^widget notice/);
				assert.equal(screen[editor - 2]?.trim(), "", "intentional widget blank line survives");
				assert.match(screen[editor - 3]!, /^transcript 60\b/, "no extra spacer before widget");
			} else {
				assert.match(screen[editor - 1]!, /^transcript 60\b/, `width ${width}: no blank row above composer`);
			}
		}
	}
	f.dispose();
	const native = await capture(f.tui);
	const editor = native.findIndex(row => row.startsWith("╭─ editor"));
	assert.equal(native[editor - 1], "", "disposal restores native spacing");
});

test("fullscreen preserves above-editor widgets with no recognized native spacer", async (t) => {
	const f = viewport(140, 24, true);
	t.after(() => { f.dispose(); f.tui.stop(); });
	f.above.clear();
	f.above.addChild(lines(["", "widget notice"]));
	const screen = await capture(f.tui);
	const editor = screen.findIndex(row => row.startsWith("╭─ editor"));
	assert.match(screen[editor - 1]!, /^widget notice/);
	assert.equal(screen[editor - 2]?.trim(), "");
	assert.match(screen[editor - 3]!, /^transcript 60\b/);
});

test("above-editor widget mouse coordinates follow the spacer-free layout", (t) => {
	const f = viewport(100, 24, true);
	t.after(() => { f.dispose(); f.tui.stop(); });
	let clicked: number | undefined;
	f.above.addChild({ ...lines(["", "click notice"]), handleMouse(event) { clicked = event.y; return { handled: true }; } });
	const frame = renderLayoutFrame(f.root, 100, 24, () => {});
	const y = frame.lines.findIndex(row => row.startsWith("click notice"));
	assert.ok(y >= 0);
	const box = getLayoutBoxesAt(frame, 0, y).find(box => box.component.handleMouse);
	assert.ok(box);
	box.component.handleMouse!({ type: "click", button: "left", x: 0, y: y - box.rect.y, screenX: 0, screenY: y, width: box.rect.width, height: box.rect.height } as Parameters<NonNullable<Component["handleMouse"]>>[0]);
	assert.equal(clicked, 1, "widget receives its own row, without the removed spacer");
});

test("fullscreen without the sidebar keeps Pi's bottom bar on the last row", async () => {
	const screen = await renderViewport(140, 24, false);
	assert.equal(screen[screen.length - 1], "BOTTOM BAR");
	assert.match(screen[screen.length - 2] ?? "", /^╰/);
});
