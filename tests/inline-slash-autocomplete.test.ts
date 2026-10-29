import assert from "node:assert/strict";
import test from "node:test";
import { InlineSlashAutocompleteProvider, installInlineSlashTriggers } from "../lib/inline-slash-autocomplete.ts";

test("unsupported editor layouts retain every native method unchanged", () => {
 const native = () => false;
 const editor = { getLines: () => ["use /"], getCursor: () => ({ line: 0, col: 5 }), isAtStartOfMessage: native };
 assert.equal(installInlineSlashTriggers(editor), false);
 assert.equal(editor.isAtStartOfMessage, native);
 assert.deepEqual(Object.keys(editor), ["getLines", "getCursor", "isAtStartOfMessage"]);
});

test("provider translates only standalone slash tokens and preserves signals and other providers", async () => {
 const calls: unknown[][] = [];
 const item = { value: "reload", label: "reload" };
 const current = {
  triggerCharacters: ["#"],
  getSuggestions: async (...args: unknown[]) => {
   calls.push(args); return { items: [item], prefix: "/re" };
  },
  applyCompletion: (lines: string[], cursorLine: number, cursorCol: number) => ({ lines, cursorLine, cursorCol }),
  shouldTriggerFileCompletion: () => true,
 };
 const provider = new InlineSlashAutocompleteProvider(current);
 const options = { signal: new AbortController().signal, force: true };
 assert.deepEqual(provider.triggerCharacters, ["#"]);
 const lines = ["before", "use /re tail", "after"];
 assert.equal((await provider.getSuggestions(lines, 1, 7, options))?.prefix, "re");
 assert.deepEqual(calls.pop(), [["/re tail"], 0, 3, { ...options, force: false }]);
 for (const text of ["https://re", "src/re", "use /usr/re", "use @re", "use #re", "/reload arg", "!echo /re", "!!echo /re"]) {
  const lines = [text];
  await provider.getSuggestions(lines, 0, text.length, options);
  assert.deepEqual(calls.pop(), [lines, 0, text.length, options], text);
 }
 assert.equal((await provider.getSuggestions(["  /re"], 0, 5, options))?.prefix, "/re", "native command submission prefix stays unchanged");
 assert.equal(provider.shouldTriggerFileCompletion(["@file"], 0, 5), true);
 const untouched = provider.applyCompletion(["@file"], 0, 5, item, "@file");
 assert.deepEqual(untouched, { lines: ["@file"], cursorLine: 0, cursorCol: 5 });
});
