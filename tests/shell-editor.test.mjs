import assert from 'node:assert/strict';
import test from 'node:test';
import { stripVTControlCharacters } from 'node:util';
const plain = text => stripVTControlCharacters(text).replace(/\x1b_pi:[^\x07]*\x07/g, '');
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
// Installed Git packages may have only peer dependencies supplied by the Pi host.
// Normal development/CI uses local dependencies; the host fallback changes no config.
let load = specifier => import(specifier);
try { await import('@earendil-works/pi-coding-agent'); }
catch (error) {
 if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
 const piRoot = dirname(dirname(dirname(realpathSync(execFileSync('which', ['pi'], { encoding: 'utf8' }).trim()))));
 const { createJiti } = createRequire(join(piRoot, 'package.json'))('jiti');
 const jiti = createJiti(import.meta.url, { alias: Object.fromEntries(['pi-coding-agent', 'pi-tui', 'pi-ai'].map(name =>
  [`@earendil-works/${name}`, join(piRoot, name === 'pi-coding-agent' ? 'dist/bundle/index.js' : `node_modules/@earendil-works/${name}/dist/index.js`)])) });
 load = specifier => jiti.import(specifier);
}
const { initTheme } = await load('@earendil-works/pi-coding-agent');
const { CURSOR_MARKER, matchesKey, visibleWidth, CombinedAutocompleteProvider } = await load('@earendil-works/pi-tui');
const { GentlePromptEditor } = await load('../extensions/gentle-shell.ts');
const { cardStyle, setCardStyle } = await load('../lib/shell-card.ts');
initTheme('dark');
function editor() {
 const e = new GentlePromptEditor({ terminal: { rows: 40, columns: 100 }, requestRender() {} },
  { borderColor: t => t, selectList: {} },
  { matches: (data, action) => action === 'tui.editor.selectAll' && matchesKey(data, 'alt+a') },
  { fg: (_, t) => t, bg: (_, t) => t, bold: t => t, requestRender() {}, pending: () => false,
   now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {} });
 e.focused = true; return e;
}
async function settleCompletion(e) {
 // Completion starts on the host's serialized microtask chain, not a timer.
 await e.autocompleteRequestTask;
}
function slashEditor() {
 const e = editor();
 e.setAutocompleteProvider(new CombinedAutocompleteProvider([
  { name: 'reload', description: 'Reload extensions' },
  { name: 'resume', description: 'Resume session' },
  { name: 'skill:research', description: 'Research' },
 ], process.cwd()));
 return e;
}
test('slash completion opens and filters anywhere, accepts with undo, and preserves surrounding text', async () => {
 for (const prefix of ['', 'please ', 'first line\nthen ', 'first line\n', '工具\t']) {
  const e = slashEditor();
  try {
   e.setText(prefix); const normalizedPrefix = e.getText();
   e.handleInput('/'); await settleCompletion(e);
   assert.equal(e.isShowingAutocomplete(), true, `menu after ${JSON.stringify(prefix)}`);
   for (const c of 'relo') { e.handleInput(c); await settleCompletion(e); }
   assert.equal(e.autocompleteList.getSelectedItem()?.value, 'reload');
   e.handleInput('\t'); await settleCompletion(e);
   assert.equal(e.getText(), normalizedPrefix + '/reload ');
   e.handleInput('\x1f'); assert.equal(e.getText(), normalizedPrefix + '/relo');
  } finally { e.dispose(); }
 }
});
test('inline slash Tab, Enter, Escape, backspace and skill names use native completion without submitting', async () => {
 const e = slashEditor(); let submitted = false; e.onSubmit = () => { submitted = true; };
 try {
  e.setText('use /relo'); e.handleInput('\t'); await settleCompletion(e);
  assert.equal(e.getText(), 'use /reload ', 'Tab accepts the single match natively');
  e.setText('use /rel'); e.handleInput('o'); await settleCompletion(e);
  assert.equal(e.isShowingAutocomplete(), true);
  e.handleInput('\r'); assert.equal(e.getText(), 'use /reload '); assert.equal(submitted, false);
  e.setText('use /rel'); e.handleInput('o'); await settleCompletion(e);
  e.handleInput('\x1b'); assert.equal(e.isShowingAutocomplete(), false); assert.equal(e.getText(), 'use /relo');
  e.handleInput('\x7f'); await settleCompletion(e);
  assert.equal(e.isShowingAutocomplete(), true, 'backspace reopens command completion');
  e.setText('use /skill:res'); e.handleInput('e'); await settleCompletion(e);
  e.handleInput('\r'); assert.equal(e.getText(), 'use /skill:research ');
 } finally { e.dispose(); }
});
test('inline completion preserves cursor suffix and other lines and ignores URLs, paths and shell drafts', async () => {
 const e = slashEditor();
 try {
  e.setText('before\nuse /relo + tail\nafter');
  e.state.cursorLine = 1; e.state.cursorCol = 'use /relo'.length;
  e.handleInput('\t'); await settleCompletion(e);
  assert.equal(e.getText(), 'before\nuse /reload  + tail\nafter');
  assert.deepEqual(e.getCursor(), { line: 1, col: 'use /reload '.length });
  for (const prefix of ['https:/', 'src', 'use /tmp', '!echo ', '!!echo ']) {
   e.setText(prefix); e.handleInput('/'); await settleCompletion(e);
   assert.equal(e.isShowingAutocomplete(), false, prefix);
  }
 } finally { e.dispose(); }
});
test('Tab still completes an inline absolute path without a trailing slash', async () => {
 const e = slashEditor();
 try {
  e.setText('use /tmp'); e.handleInput('\t'); await settleCompletion(e);
  assert.equal(e.getText(), 'use /tmp/');
 } finally { e.dispose(); }
});
test('shell ghosts are display-only, clipped in both frames, and Right inserts with undo', () => {
 const old = cardStyle();
 try { for (const style of ['float', 'neon']) for (const bang of ['!', '!!']) {
  setCardStyle(style); const e = editor();
  try {
   e.addToHistory(`${bang}git status 工具`); e.setText(`${bang}git st`);
   for (const width of [8, 20, 80]) {
    const rows = e.render(width); assert.ok(rows.every(row => visibleWidth(row) <= width));
    assert.equal(e.getText(), `${bang}git st`); assert.ok(rows.some(row => row.includes(CURSOR_MARKER)));
   }
   assert.match(plain(e.render(80).join('\n')), /git status 工具/);
   e.handleInput('\x1b[C'); assert.equal(e.getText(), `${bang}git status 工具`);
   e.handleInput('\x1f'); assert.equal(e.getText(), `${bang}git st`);
   e.setText(`${bang}git st`); e.handleInput('\x1b[D'); e.render(80); e.handleInput('\x1b[C');
   assert.equal(e.getText(), `${bang}git st`, 'Right in the middle only moves');
   e.render(80); e.onExtensionShortcut = () => true; e.handleInput('\x1b[C');
   assert.equal(e.getText(), `${bang}git st`, 'shortcut wins'); e.onExtensionShortcut = undefined;
   e.handleInput('\x1ba'); e.render(80); e.handleInput('\x1b[C');
   assert.equal(e.getText(), `${bang}git st`, 'selection wins');
  } finally { e.dispose(); }
 } } finally { setCardStyle(old); }
});
test('completion menus, pending providers and session instances never leak ghost acceptance', async () => {
 const e = editor(), fresh = editor();
 try {
  e.addToHistory('!!echo private'); e.setText('!echo p');
  assert.doesNotMatch(plain(e.render(80).join('\n')), /private/);
  e.setText('!!echo p'); fresh.setText('!!echo p');
  assert.doesNotMatch(plain(fresh.render(80).join('\n')), /private/);
  e.autocompleteState = 'force'; e.autocompleteList = { render: () => ['menu item'] };
  assert.doesNotMatch(plain(e.render(80).join('\n')), /private/);
  e.handleInput('\x1b[C'); assert.equal(e.getText(), '!!echo p');
  e.autocompleteState = null; e.autocompleteList = undefined;
  let release;
  e.setAutocompleteProvider({ getSuggestions: () => new Promise(r => { release = r; }),
   applyCompletion: (lines, cursorLine, cursorCol) => ({ lines, cursorLine, cursorCol }) });
  const p = e.autocompleteProvider.getSuggestions(['prose'], 0, 5, { signal: new AbortController().signal });
  assert.doesNotMatch(plain(e.render(80).join('\n')), /private/);
  e.handleInput('\x1b[C'); assert.equal(e.getText(), '!!echo p');
  release(null); await p;
  assert.match(plain(e.render(80).join('\n')), /private/);
  const paste = Array.from({ length: 12 }, (_, i) => `synthetic payload ${i} `.repeat(5)).join('\n');
  e.setText(''); e.handleInput('\x1b[200~' + paste + '\x1b[201~');
  e.render(80); assert.equal(e.getExpandedText(), paste);
 } finally { e.dispose(); fresh.dispose(); }
});
