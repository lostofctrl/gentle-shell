import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ShellAutocompleteProvider, ShellHistory } from "../lib/shell-autocomplete.ts";

const fallback = {
 getSuggestions: async () => ({ items: [{ value: "normal", label: "normal" }], prefix: "n" }),
 applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
 shouldTriggerFileCompletion: () => false,
};
const options = () => ({ signal: new AbortController().signal, force: true });
test("shell Tab completes executable commands, paths and literal filenames without running text", async () => {
 const root = await mkdtemp(join(tmpdir(), "shell-complete-"));
 try {
  await mkdir(join(root, "bin")); await mkdir(join(root, "space dir"));
  await writeFile(join(root, "bin", "quasar-run"), ""); await chmod(join(root, "bin", "quasar-run"), 0o755);
  await writeFile(join(root, "bin", "quasar-noexec"), "");
  await writeFile(join(root, "$(touch OWNED)"), "");
  await writeFile(join(root, "unsafe\x1b[31m"), "");
  const provider = new ShellAutocompleteProvider(fallback, () => root, () => {}, { PATH: join(root, "bin"), HOME: root });
  for (const bang of ["!", "!!"]) {
   const command = await provider.getSuggestions([`${bang}quasar-`], 0, bang.length + 7, options());
   assert.deepEqual(command?.items.map(x => x.value), ["quasar-run"]);
   const text = `${bang}cat spa --tail`;
   const result = await provider.getSuggestions([text], 0, bang.length + 7, options());
   assert.ok(result?.items.some(x => x.value === "space\\ dir/"));
   const applied = provider.applyCompletion([text], 0, bang.length + 7, result!.items[0]!, result!.prefix);
   assert.equal(applied.lines[0], `${bang}cat space\\ dir/ --tail`);
   const quoted = `${bang}cat "spa`;
   const quoteResult = await provider.getSuggestions([quoted], 0, quoted.length, options());
   assert.equal(quoteResult?.items[0]?.value, "space\\ dir/");
   const closed = quoted + '" --tail';
   assert.equal(provider.applyCompletion([closed], 0, quoted.length, quoteResult!.items[0]!, quoteResult!.prefix).lines[0],
    `${bang}cat space\\ dir/ --tail`);
   const home = `${bang}cat ~/spa`;
   const homeResult = await provider.getSuggestions([home], 0, home.length, options());
   assert.equal(homeResult?.items[0]?.value, join(root, "space\\ dir/"));
   const unsafe = `${bang}cat `;
   const files = await provider.getSuggestions([unsafe], 0, unsafe.length, options());
   assert.ok(files?.items.some(x => x.value === "\\$\\(touch\\ OWNED\\)"));
   assert.ok(files?.items.every(x => !x.label.includes("\x1b")));
   assert.equal((await import("node:fs")).existsSync(join(root, "OWNED")), false);
  }
  assert.equal((await provider.getSuggestions(["normal"], 0, 6, options()))?.prefix, "n");
  assert.equal(await provider.getSuggestions(["!qu"], 0, 3, { ...options(), force: false }), null);
  assert.equal(provider.shouldTriggerFileCompletion(["!!qu"], 0, 4), true);
  const controller = new AbortController(); controller.abort();
  assert.equal(await provider.getSuggestions(["!qu"], 0, 3, { signal: controller.signal, force: true }), null);
 } finally { await rm(root, { recursive: true, force: true }); }
});
test("history is bounded, prefix-local, recent-first and rejects control/multiline suggestions", () => {
 const history = new ShellHistory();
 history.add("!git status"); history.add("!!git secret"); history.add("!git stash");
 assert.equal(history.suffix("!git st"), "ash");
 assert.equal(history.suffix("!!git s"), "ecret");
 assert.equal(history.suffix("!"), ""); assert.equal(history.suffix("ordinary"), "");
 history.add("!git st\x1b[31m"); history.add("!git st\nsecond");
 assert.equal(history.suffix("!git st"), "ash");
 for (let i = 0; i < 201; i++) history.add(`!bounded-${i}`);
 assert.equal(history.suffix("!git st"), "");
 assert.equal(history.suffix("!bounded-"), "200");
});
