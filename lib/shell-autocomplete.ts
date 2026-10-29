import type { AutocompleteProvider, AutocompleteItem } from "@earendil-works/pi-tui";
import { readdir, access, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import { homedir } from "node:os";

const shellPrefix = (text: string) => /^\s*(!{1,2})(?!\!)/.exec(text);
const literal = (text: string) => text.replace(/[^a-zA-Z0-9_./-]/gu, "\\$&");
const safe = (text: string) => !/[\x00-\x1f\x7f-\x9f]/u.test(text);

// Parse literal words only; never invoke shell expansion or startup/completion scripts.
function token(text: string) {
 const bang = shellPrefix(text);
 if (!bang || !safe(text)) return undefined;
 let start = bang[0].length, word = "", quote = "", escaped = false, first = true;
 for (let i = start; i < text.length; i++) {
  const c = text[i]!;
  if (escaped) { word += c; escaped = false; continue; }
  if (c === "\\" && quote !== "'" && (quote !== '"' || /[$`"\\]/u.test(text[i + 1] ?? ""))) { escaped = true; continue; }
  if (quote) { if (c === quote) quote = ""; else word += c; continue; }
  if (c === "'" || c === '"') { quote = c; continue; }
  if (/[|;&<>\s]/u.test(c)) {
   if (word) first = false;
   if (/[|;&]/u.test(c)) first = true;
   if (/[<>]/u.test(c)) first = false;
   start = i + 1; word = "";
  } else word += c;
 }
 if (escaped || /[$`]/u.test(word)) return undefined;
 return { start, word, quote, first, raw: text.slice(start) };
}

export class ShellAutocompleteProvider implements AutocompleteProvider {
 readonly triggerCharacters: string[] | undefined;
 private commands?: { at: number; path: string; names: Promise<{ name: string; path: string }[]> };
 private current: AutocompleteProvider;
 private cwd: () => string;
 private pending: (active: boolean) => void;
 private env: NodeJS.ProcessEnv;
 constructor(current: AutocompleteProvider, cwd: () => string,
  pending: (active: boolean) => void = () => {}, env: NodeJS.ProcessEnv = process.env) {
  this.current = current; this.cwd = cwd; this.pending = pending; this.env = env;
  this.triggerCharacters = current.triggerCharacters;
 }
 shouldTriggerFileCompletion(lines: string[], line: number, col: number): boolean {
  return shellPrefix(lines[0] ?? "") ? true : this.current.shouldTriggerFileCompletion?.(lines, line, col) ?? false;
 }
 async getSuggestions(lines: string[], line: number, col: number, options: { signal: AbortSignal; force?: boolean }) {
  this.pending(true);
  try {
   if (!shellPrefix(lines[0] ?? "")) return await this.current.getSuggestions(lines, line, col, options);
   if (!options.force || line !== 0 || options.signal.aborted) return null;
   const t = token(lines[0]!.slice(0, col));
   if (!t) return null;
   const home = this.env.HOME ?? homedir();
   const word = t.word.startsWith("~/") ? home + t.word.slice(1) : t.word;
   const slash = word.lastIndexOf("/"), dir = word.slice(0, slash + 1), base = word.slice(slash + 1);
   const folder = resolve(this.cwd(), dir || ".");
   const entries = await readdir(folder, { withFileTypes: true }).catch(() => []);
   const items: AutocompleteItem[] = [];
   for (const entry of entries) {
    if (!entry.name.startsWith(base) || (!base.startsWith(".") && entry.name.startsWith(".")) || !safe(entry.name)) continue;
    let directory = entry.isDirectory();
    if (entry.isSymbolicLink()) directory = await stat(resolve(folder, entry.name)).then(s => s.isDirectory()).catch(() => false);
    const value = literal(dir + entry.name) + (directory ? "/" : "");
    items.push({ value, label: entry.name + (directory ? "/" : "") });
    if (items.length >= 200) break;
   }
   if (t.first && slash < 0) {
    const path = this.env.PATH ?? "", key = this.cwd() + "\0" + path;
    if (!this.commands || this.commands.path !== key || Date.now() - this.commands.at > 5000) {
     const names = Promise.all(path.split(delimiter).filter(Boolean).map(async dir =>
      (await readdir(resolve(this.cwd(), dir)).catch(() => [])).map(name => ({ name, path: resolve(this.cwd(), dir, name) })))).then(parts => parts.flat());
     this.commands = { at: Date.now(), path: key, names };
    }
    const candidates = (await this.commands.names).filter(x => x.name.startsWith(word) && safe(x.name)).slice(0, 200);
    for (const candidate of candidates) {
     const executable = await stat(candidate.path).then(s => s.isFile()).catch(() => false) &&
      await access(candidate.path, constants.X_OK).then(() => true).catch(() => false);
     if (executable) items.push({ value: literal(candidate.name), label: candidate.name });
    }
    for (const name of ["cd", "echo", "pwd", "export", "source", "alias", "type", "history", "exit", "true", "false", "printf", "read", "unset", "command", "exec", "test"]) {
     if (name.startsWith(word)) items.push({ value: name, label: name });
    }
   }
   if (options.signal.aborted) return null;
   const unique = [...new Map(items.map(item => [item.value, item])).values()].sort((a, b) => a.label.localeCompare(b.label));
   return unique.length ? { items: unique, prefix: t.raw } : null;
  } finally { this.pending(false); }
 }
 applyCompletion(lines: string[], line: number, col: number, item: AutocompleteItem, prefix: string) {
  if (!shellPrefix(lines[0] ?? "")) return this.current.applyCompletion(lines, line, col, item, prefix);
  const t = token(lines[line]!.slice(0, col));
  if (!t) return { lines, cursorLine: line, cursorCol: col };
  const tail = lines[line]!.slice(col + (t.quote && lines[line]![col] === t.quote ? 1 : 0));
  const updated = [...lines]; updated[line] = lines[line]!.slice(0, t.start) + item.value + tail;
  return { lines: updated, cursorLine: line, cursorCol: t.start + item.value.length };
 }
}

export class ShellHistory {
 private entries: string[] = [];
 add(text: string): void {
  if (!shellPrefix(text) || !safe(text)) return;
  this.entries = [...this.entries.filter(entry => entry !== text), text].slice(-200);
 }
 suffix(text: string): string {
  const bang = shellPrefix(text);
  if (!bang || !text.slice(bang[0].length).trim() || !safe(text)) return "";
  return [...this.entries].reverse().find(entry => entry.startsWith(text) && shellPrefix(entry)?.[1] === bang[1] && entry !== text)?.slice(text.length) ?? "";
 }
}
