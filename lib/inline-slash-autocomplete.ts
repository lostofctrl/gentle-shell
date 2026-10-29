import type { AutocompleteItem, AutocompleteProvider } from "@earendil-works/pi-tui";

interface PromptEditor {
 getLines(): string[];
 getCursor(): { line: number; col: number };
}

// A standalone command token, not a slash inside a URL, path, or shell draft.
function slashToken(lines: string[], line: number, col: number) {
 if (/^\s*!/.test(lines[0] ?? "")) return undefined;
 const before = (lines[line] ?? "").slice(0, col);
 const text = /(?:^|\s)(\/[\w:.-]*)$/.exec(before)?.[1];
 return text === undefined ? undefined : { text, start: col - text.length,
  inline: line > 0 || before.slice(0, col - text.length).trim() !== "" };
}

/** Reuse Pi's command catalog and insertion rules on the cursor-local token. */
export class InlineSlashAutocompleteProvider implements AutocompleteProvider {
 readonly triggerCharacters: string[] | undefined;
 private readonly current: AutocompleteProvider;
 constructor(current: AutocompleteProvider) {
  this.current = current;
  this.triggerCharacters = current.triggerCharacters;
 }
 async getSuggestions(...args: Parameters<AutocompleteProvider["getSuggestions"]>) {
  const [lines, line, col, options] = args;
  const token = slashToken(lines, line, col);
  if (!token) return this.current.getSuggestions(...args);
  const result = await this.current.getSuggestions([lines[line]!.slice(token.start)], 0, token.text.length, { ...options, force: false });
  // Native Tab also completes absolute paths. Keep that fallback in its original context.
  if (token.inline && options.force && !result?.items.length) return this.current.getSuggestions(...args);
  // A slash-prefixed result makes native Enter submit. Inline Enter must only insert.
  return result && token.inline && result.prefix === token.text ? { ...result, prefix: result.prefix.slice(1) } : result;
 }
 applyCompletion(lines: string[], line: number, col: number, item: AutocompleteItem, prefix: string) {
  const token = slashToken(lines, line, col);
  if (!token || (token.inline ? "/" + prefix : prefix) !== token.text) return this.current.applyCompletion(lines, line, col, item, prefix);
  const result = this.current.applyCompletion([lines[line]!.slice(token.start)], 0, token.text.length, item, token.text);
  const updated = [...lines.slice(0, line), ...result.lines, ...lines.slice(line + 1)];
  updated[line] = lines[line]!.slice(0, token.start) + updated[line];
  return { lines: updated, cursorLine: line + result.cursorLine,
   cursorCol: result.cursorCol + (result.cursorLine === 0 ? token.start : 0) };
 }
 shouldTriggerFileCompletion(lines: string[], line: number, col: number) {
  return this.current.shouldTriggerFileCompletion?.(lines, line, col) ?? false;
 }
}

/** Pi has no public slash activation hook. Leave native behavior intact on API drift. */
export function installInlineSlashTriggers(editor: PromptEditor): boolean {
 type Hooks = {
  isAtStartOfMessage(): boolean;
  isInSlashCommandContext(before: string): boolean;
 };
 const host = editor as PromptEditor & Hooks;
 const keys = ["isAtStartOfMessage", "isInSlashCommandContext"] as const;
 if (!keys.every(key => typeof host[key] === "function")) return false;
 const atStart = host.isAtStartOfMessage.bind(host);
 const inCommand = host.isInSlashCommandContext.bind(host);
 const currentToken = () => {
  const cursor = editor.getCursor();
  return slashToken(editor.getLines(), cursor.line, cursor.col);
 };
 Object.assign(host, {
  // These host predicates are used only by autocomplete, never command dispatch.
  isAtStartOfMessage: () => atStart() || currentToken()?.text === "/",
  isInSlashCommandContext: (before: string) => inCommand(before) || currentToken() !== undefined,
 });
 return true;
}
