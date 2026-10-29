import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';

import { buildShellHeaderModel, renderShellBar, renderShellHeaderBar, renderShellBelowInputFloat, renderShellBottomOnlyBar, renderComposerMetrics, renderComposerLocation } from '../lib/shell-bar.ts';
import { framePromptLines } from '../lib/shell-prompt.ts';
import { registerYoloSessionPolicy, YOLO_STATUS_KEY, MODE_STATUS_KEY, YOLO_STATUS_TEXT } from '../lib/yolo-session-policy.ts';
import { visibleWidth, CURSOR_MARKER, matchesKey, sliceByColumn } from '@earendil-works/pi-tui';
import { initTheme } from '@earendil-works/pi-coding-agent';
import { GentlePromptEditor, buildShellBarModel } from '../extensions/gentle-shell.ts';
import { cardStyle, setCardStyle } from '../lib/shell-card.ts';
initTheme('dark');
const theme = { fg: (_color, text) => text, bold: text => text, bg: (_color, text) => `\x1b[48;2;20;20;20m${text}\x1b[49m` };
const presentation = { density: 'comfortable', headerPlacement: 'below-input', statusPlacement: 'bottom', visibility: { modelDetails: true, usageCost: true, changes: true } };
const model = {
  cwd: '/home/developer/projects/client/dashboard', branch: 'feature/settings', dirty: 2,
  modelId: 'gpt-5', effort: 'high', contextPercent: 12, contextWindow: 200000,
  costTotal: 0.1, subscription: false, statuses: ['🚀'],
};
const plain = value => Array.isArray(value) ? value.map(stripVTControlCharacters).join('\n') : stripVTControlCharacters(value);

test('latest prompt comes from the active branch, skipping non-user and image content', () => {
  let branch = [
    { type: 'message', message: { role: 'assistant', content: [] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'ignored' }, { type: 'text', text: 'First request' }, { type: 'text', text: 'with details' }] } },
    { type: 'message', message: { role: 'user', content: [{ type: 'image', data: 'ignored' }, { type: 'text', text: 'Latest request' }, { type: 'text', text: 'with details' }] } },
    { type: 'message', message: { role: 'assistant', content: [] } },
  ];
  const ctx = {
    sessionManager: { getCwd: () => '/project', getSessionName: () => 'My session', getEntries: () => [], getBranch: () => branch },
    getContextUsage: () => undefined,
  };
  const footer = { getExtensionStatuses: () => new Map([['session-name', 'My session'], ['mcp', 'MCP ready']]), getGitBranch: () => null };
  const built = buildShellBarModel({}, ctx, footer);
  assert.deepEqual(built.statuses, ['MCP ready'], 'header owns the name; legacy footer must not repeat it');
  const rows = renderShellBottomOnlyBar(built, theme, 160, undefined, { ...presentation, promptOwnsChrome: true });
  assert.equal(plain(rows).split('My session').length - 1, 1);
  assert.match(plain(rows), /MCP ready/);
  assert.equal(built.latestPrompt, 'Latest request with details');
  assert.equal(buildShellHeaderModel(built).latestPrompt, built.latestPrompt);
  branch = [{ type: 'message', message: { role: 'user', content: 'Switched branch prompt' } }];
  assert.equal(buildShellBarModel({}, ctx, footer).latestPrompt, 'Switched branch prompt');
  branch = [];
  assert.equal(buildShellBarModel({}, ctx, footer).latestPrompt, undefined);
  ctx.sessionManager.getSessionName = () => undefined;
  assert.deepEqual(buildShellBarModel({}, ctx, footer).statuses, ['MCP ready', 'My session'], 'keep legacy fallback when the header has no name');
});

test('latest prompt contracts native skill blocks to their command and keeps user arguments', () => {
  for (const [name, args, asParts] of [['research', '', false], ['code-review', 'Review the 工具 changes\ncarefully', true]]) {
    const expanded = `<skill name="${name}" location="/skills/${name}/SKILL.md">\nReferences are relative to /skills/${name}.\n\n${'Private skill instructions. '.repeat(40)}\n</skill>${args ? `\n\n${args}` : ''}`;
    const content = asParts ? [{ type: 'text', text: expanded }] : expanded;
    const ctx = {
      sessionManager: {
        getCwd: () => '/project', getSessionName: () => 'My session', getEntries: () => [],
        getBranch: () => [{ type: 'message', message: { role: 'user', content } }],
      },
      getContextUsage: () => undefined,
    };
    const footer = { getExtensionStatuses: () => new Map(), getGitBranch: () => null };
    const built = buildShellBarModel({}, ctx, footer);
    const command = `/skill:${name}${args ? ` ${args}` : ''}`;
    assert.equal(built.latestPrompt, command);
    const text = stripVTControlCharacters(renderShellHeaderBar(buildShellHeaderModel(built), theme, 120, undefined, { ...presentation, promptOwnsChrome: true }).text);
    assert.ok(text.endsWith(command.replace(/\n/g, ' ') + '  '), text);
    assert.doesNotMatch(text, /<\/?skill|References|Private skill|SKILL\.md/);
    assert.equal(asParts ? content[0].text : content, expanded, 'session messages must remain expanded');
  }
});

test('header right-aligns a single-line truncated latest prompt beside the session name', () => {
  const named = { ...model, sessionName: 'My session', latestPrompt: 'Build the settings screen\nwith 工具 '.repeat(15) + '\x1b[31mred\x1b[0m' };
  const own = { ...presentation, promptOwnsChrome: true };
  for (const width of [40, 80, 160]) {
    const text = stripVTControlCharacters(renderShellHeaderBar(buildShellHeaderModel(named), theme, width, undefined, own).text);
    assert.match(text, /My session +Build the settings/);
    assert.match(text.trimEnd(), /…$/);
    assert.ok(!/[\r\n\x1b]/.test(text));
    assert.equal(visibleWidth(text), width);
  }
  const narrow = stripVTControlCharacters(renderShellHeaderBar(buildShellHeaderModel(named), theme, 20, undefined, own).text);
  assert.match(narrow, /My session/);
  assert.doesNotMatch(narrow, /Build/);
  for (const change of [{ latestPrompt: '' }]) {
    const text = stripVTControlCharacters(renderShellHeaderBar(buildShellHeaderModel({ ...named, ...change }), theme, 80, undefined, own).text);
    assert.doesNotMatch(text, /Build/);
  }
  const short = stripVTControlCharacters(renderShellHeaderBar(buildShellHeaderModel({ ...named, latestPrompt: 'Fix\n\t\x1b[31mtypo\x1b[0m' }), theme, 80, undefined, own).text);
  assert.match(short, /My session {10,}Fix typo  $/);
  assert.doesNotMatch(short, /…/);
  const unnamed = stripVTControlCharacters(renderShellHeaderBar(buildShellHeaderModel({ ...named, sessionName: undefined, latestPrompt: 'Latest request' }), theme, 80, undefined, own).text);
  assert.match(unnamed, /Latest request  $/);
  for (const width of [0, 1, 2, 10, 20, 40, 80, 160]) {
    const result = renderShellHeaderBar(buildShellHeaderModel({ ...named, latestPrompt: 'Latest request '.repeat(10) }), theme, width, undefined, presentation);
    assert.ok(visibleWidth(result.text) <= width);
    if (result.usageSpan) {
      const prefix = stripVTControlCharacters(result.text).slice(0, result.usageSpan.start);
      assert.equal(visibleWidth(prefix), result.usageSpan.start);
      assert.match(stripVTControlCharacters(result.text).slice(result.usageSpan.start, result.usageSpan.end), /^usage/);
    }
  }
});

test('latest prompt alone is italic and faint with styling reset before counters', () => {
  for (const promptOwnsChrome of [true, false]) {
    const headerModel = buildShellHeaderModel({ ...model, sessionName: 'My session', latestPrompt: 'Latest request' });
    const text = renderShellHeaderBar(headerModel, theme, 220, undefined, { ...presentation, promptOwnsChrome }).text;
    assert.ok(text.includes('\x1b[2;3mLatest request\x1b[22;23m'));
    assert.equal(text.split('\x1b[2;3m').length, 2);
    assert.equal(visibleWidth(text), 220);
    const empty = renderShellHeaderBar({ ...headerModel, latestPrompt: '' }, theme, 220, undefined, { ...presentation, promptOwnsChrome }).text;
    assert.ok(!empty.includes('\x1b[2;3m'));
  }
});

test('foreign editor fallback retains full directory and adjacent branch when width permits', () => {
  const text = stripVTControlCharacters(renderShellHeaderBar(model, theme, 180, undefined, { ...presentation, promptOwnsChrome: false }).text);
  assert.match(text, /\/home\/developer\/projects\/client\/dashboard ⎇ feature\/settings/);
});

test('grouped composer and bottom fallback preserve project + branch within their width', () => {
  for (const rows of [
    renderShellBelowInputFloat(model, theme, 180, undefined, presentation).rows,
    renderShellBottomOnlyBar(model, theme, 180, undefined, presentation),
  ]) {
    assert.match(plain(rows), /dashboard ⎇ feature\/settings/);
    assert.match(plain(rows), /🚀/);
    assert.ok(rows.every(row => visibleWidth(row) <= 180));
  }
  for (const width of [0, 1, 20, 40, 80]) {
    assert.ok(visibleWidth(renderShellHeaderBar(model, theme, width, undefined, presentation).text) <= width);
  }
});

test('non-repository and detached-HEAD labels stay truthful', () => {
  assert.doesNotMatch(renderShellHeaderBar({ ...model, branch: null }, theme, 160).text, /feature\/settings|null/);
  assert.match(renderShellHeaderBar({ ...model, branch: 'HEAD' }, theme, 160).text, /dashboard ⎇ HEAD/);
});

test('metrics and tail-truncated folder + branch are right-aligned in both styles', () => {
  for (const style of ['float', 'neon']) {
    const rows = framePromptLines(['─', 'draft stays intact', '─'], 140, {
      state: 'working', tick: 0, workingLabel: 'implementing…', style,
      borderColor: text => text, fg: theme.fg, bg: theme.bg,
      topRight: width => renderComposerMetrics(model, theme, width, undefined, presentation).text,
      bottomRight: width => renderComposerLocation(model, theme, Math.min(48, width)),
    });
    assert.equal(rows.length, 3);
    const top = stripVTControlCharacters(rows[0]);
    assert.match(top, /implementing….*gpt-5.*ctx.*12%.*usage/);
    assert.ok(top.indexOf('gpt-5') > 60, top);
    const bottom = stripVTControlCharacters(rows[2]);
    assert.ok(bottom.indexOf('…') > 60, bottom);
    assert.match(bottom, /….*dashboard ⎇ feature\/settings ±2(?: ─╯| {2})$/);
    assert.doesNotMatch(top, /dashboard|feature\/settings/);
    assert.match(stripVTControlCharacters(rows[1]), /draft stays intact/);
    assert.ok(rows.every(row => visibleWidth(row) <= 140));
  }
});

test('neon composer retains horizontal outline between and after relocated labels', () => {
  for (const state of ['idle', 'working', 'queued']) {
    const rows = framePromptLines(['─', 'draft', '─'], 160, {
      state, tick: 0, style: 'neon', borderColor: text => text, fg: theme.fg,
      topRight: width => renderComposerMetrics(model, theme, width).text,
      bottomRight: width => renderComposerLocation(model, theme, width),
    }).map(stripVTControlCharacters);
    assert.match(rows[0], /^╭─ .* ─{3,} .*usage.*─╮$/, 'top must keep its rule, not blank padding');
    assert.match(rows[1], /^│.*draft.*│$/);
    assert.match(rows[2], /^╰─ .* ─{3,} .*dashboard ⎇ feature\/settings ±2 ─╯$/, 'bottom must keep its rule before the right-aligned path');
    assert.ok(rows.every(row => visibleWidth(row) === 160));
  }
});

test('chrome keeps width, safety hints, branch truth and usage hit span under resize', () => {
  for (const width of [0, 1, 2, 6, 10, 20, 40, 80, 160]) {
    const metrics = renderComposerMetrics(model, theme, width, 'ctrl+u', presentation);
    assert.ok(visibleWidth(metrics.text) <= width);
    if (metrics.usageSpan) {
      const { start, end } = metrics.usageSpan;
      assert.match(stripVTControlCharacters(metrics.text).slice(start, end), /^usage/);
      assert.ok(start >= 0 && end <= visibleWidth(metrics.text));
    }
    const location = renderComposerLocation({ ...model, cwd: '/very/long/工具/目录/dashboard', branch: 'feature/工具/settings' }, theme, width);
    assert.ok(visibleWidth(location) <= width);
    for (const style of ['float', 'neon']) {
      const rows = framePromptLines(['↑ 4 more', 'draft', '↓ 2 more'], width, {
        state: 'idle', tick: 0, style, borderColor: text => text, fg: theme.fg, bg: theme.bg,
        escHint: 'esc again to cancel',
        topRight: available => renderComposerMetrics(model, theme, available).text,
        bottomRight: available => renderComposerLocation(model, theme, available),
      });
      assert.ok(rows.every(row => visibleWidth(row) <= width), `${style} ${width}`);
      if (width >= 80) {
        const bottom = stripVTControlCharacters(rows.at(-1));
        assert.match(bottom, /^.{0,3}esc again to cancel/);
        assert.match(bottom, /⎇ feature\/settings ±2(?: ─╯| {2})$/);
      }
    }
  }
  assert.doesNotMatch(renderComposerLocation({ ...model, branch: null }, theme, 100), /⎇|null/);
  assert.match(renderComposerLocation({ ...model, branch: 'HEAD' }, theme, 100), /⎇ HEAD/);
});

test('real editor preserves draft, cursor, selection and clickable usage through resize and model changes', () => {
  const originalStyle = cardStyle();
  try {
    for (const style of ['float', 'neon']) {
      setCardStyle(style);
      let current = { ...model }, opened = 0;
      const editor = new GentlePromptEditor(
        { terminal: { rows: 40, columns: 160 }, requestRender() {} },
        { borderColor: text => text, selectList: {} },
        { matches: (data, action) => action === 'tui.editor.selectAll' && matchesKey(data, 'alt+a') },
        { fg: theme.fg, bg: theme.bg, bold: theme.bold, requestRender() {},
          pending: () => false, now: () => 0, doubleEscCancelEnabled: () => false, dispatchQueuedText() {},
          metrics: width => renderComposerMetrics(current, theme, width),
          location: width => renderComposerLocation(current, theme, width),
          openUsage: () => opened++,
        },
      );
      try {
        editor.focused = true;
        editor.handleInput('draft stays intact');
        for (const width of [160, 60, 20, 80, 160]) {
          const rows = editor.render(width);
          assert.ok(rows.every(row => visibleWidth(row) <= width), `${style}: width ${width}`);
          assert.equal(editor.getText(), 'draft stays intact');
          assert.ok(rows.some(row => row.includes(CURSOR_MARKER)));
          if (width === 160) {
            assert.match(stripVTControlCharacters(rows[0]), /gpt-5.*ctx.*usage/);
            assert.match(stripVTControlCharacters(rows.at(-1)), /dashboard ⎇ feature\/settings/);
            const x = stripVTControlCharacters(rows[0]).indexOf('usage');
            assert.equal(editor.handleMouse({ type: 'click', button: 'left', x, y: 0, width }).handled, true);
          }
        }
        assert.equal(opened, 2);
        current = { ...current, modelId: 'new-model', branch: 'main', contextPercent: 25 };
        const updated = plain(editor.render(160));
        assert.match(updated, /new-model.*ctx.*25%/);
        assert.match(updated, /⎇ main/);
        assert.doesNotMatch(updated, /gpt-5|feature\/settings/);
        editor.handleInput('\x1ba');
        assert.match(plain(editor.render(160)), /chars selected/);
        assert.match(stripVTControlCharacters(editor.render(160).at(-1)), /dashboard ⎇ main/);
        editor.handleInput('x');
        assert.equal(editor.getText(), 'x');
        editor.autocompleteState = 'force';
        editor.autocompleteList = { render: () => ['completion one', 'completion two'] };
        const completed = editor.render(160);
        assert.match(stripVTControlCharacters(completed.at(-3)), /dashboard ⎇ main/);
        assert.match(stripVTControlCharacters(completed.at(-2)), /completion one/);
        assert.match(stripVTControlCharacters(completed.at(-1)), /completion two/);
        assert.ok(completed.every(row => visibleWidth(row) <= 160));
      } finally { editor.dispose(); }
    }
  } finally { setCardStyle(originalStyle); }
});

test('relocated footer keeps notices and changes but no duplicate metrics or location', () => {
  const relocated = { ...presentation, promptOwnsChrome: true };
  const changes = { files: [{ path: 'src/file.ts', added: 1, deleted: 0, status: 'modified' }], added: 1, deleted: 0 };
  const result = renderShellBelowInputFloat({ ...model, statuses: [...model.statuses, 'MCP ready'] }, theme, 140, undefined, relocated, changes);
  assert.doesNotMatch(plain(result.rows), /🚀/);
  assert.match(plain(result.rows), /MCP ready/);
  assert.match(plain(result.rows), /1 file.*\+1/);
  for (const rows of [
    result.rows,
    renderShellBar(model, theme, 140, relocated),
    renderShellBottomOnlyBar(model, theme, 140, undefined, relocated),
    [renderShellHeaderBar(model, theme, 140, undefined, relocated).text],
  ]) assert.doesNotMatch(plain(rows), /🚀|gpt-5|ctx|usage|dashboard|feature\/settings/);
  assert.match(renderShellHeaderBar(model, theme, 140, undefined, { ...relocated, promptOwnsChrome: false }).text, /dashboard ⎇ feature\/settings.*gpt-5/);
  const hiddenMetrics = renderComposerMetrics(model, theme, 140, undefined, { ...presentation, visibility: { modelDetails: false, usageCost: false } });
  assert.equal(hiddenMetrics.text, '🚀');
  assert.equal(hiddenMetrics.usageSpan, undefined);
});

test('YOLO publishes a composer status without an above-editor widget; mode changes retain safety notices', async t => {
  const root = mkdtempSync(join(tmpdir(), 'composer-chrome-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const statuses = new Map(), widgets = new Map(), notices = [];
  const ctx = { mode: 'tui', hasUI: true, cwd: root, sessionManager: { getSessionId: () => 'test-session' }, ui: {
    setStatus: (key, value) => statuses.set(key, value),
    setWidget: (key, value) => widgets.set(key, value),
    notify: text => notices.push(text),
  } };
  const controller = registerYoloSessionPolicy({ registerCommand() {}, events: { on() {} } }, { GENTLE_PI_CONFIG_HOME: root });
  assert.equal(await controller.humanAction('on', ctx), true);
  assert.equal(await controller.active(ctx), true);
  assert.equal(statuses.get(YOLO_STATUS_KEY), '🚀');
  assert.equal(widgets.get(YOLO_STATUS_KEY), undefined);
  assert.equal(statuses.get(MODE_STATUS_KEY), undefined, 'no duplicate Permissions: YOLO text');
  assert.ok(notices.includes(YOLO_STATUS_TEXT));
  assert.match(YOLO_STATUS_TEXT, /guards|review|confirm/i);
  assert.equal(await controller.setMode('normal', ctx), true);
  assert.equal(await controller.active(ctx), false);
  assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
  assert.equal(widgets.get(YOLO_STATUS_KEY), undefined);
  assert.equal(statuses.get(MODE_STATUS_KEY), 'Permissions: NORMAL');
  assert.equal(await controller.setMode('auto', ctx), true);
  assert.equal(statuses.get(MODE_STATUS_KEY), 'Permissions: AUTO');
  controller.reset(ctx);
  assert.equal(statuses.get(YOLO_STATUS_KEY), undefined);
});

const rocket = '\x1b[33m🚀\x1b[39m';
test('composer shows the active YOLO rocket, including with hidden metrics and planning', () => {
  const hidden = { ...presentation, visibility: { modelDetails: false, usageCost: false } };
  for (const statuses of [[rocket], ['🚀'], [rocket, '\x1b[33m⏸ plan\x1b[39m'], [], ['not 🚀'], [YOLO_STATUS_TEXT]]) {
    const active = statuses.includes(rocket) || statuses.includes('🚀');
    const current = { ...model, statuses };
    assert.equal(plain(renderComposerMetrics(current, theme, 160, undefined, hidden).text).includes('🚀'), active);
    for (const width of [0, 1, 2, 3, 8, 20, 40, 80, 160]) {
      const metrics = renderComposerMetrics(current, theme, width);
      assert.ok(visibleWidth(metrics.text) <= width);
      if (width >= 8) assert.equal(plain(metrics.text).includes('🚀'), active);
      if (metrics.usageSpan) assert.match(plain(sliceByColumn(metrics.text, metrics.usageSpan.start, metrics.usageSpan.end)), /^usage/);
    }
    for (const style of ['float', 'neon']) for (const state of ['idle', 'working', 'queued']) {
      const rows = framePromptLines(['─', 'draft stays intact', '─'], 160, {
        state, tick: 0, style, borderColor: text => text, ...theme,
        topRight: width => renderComposerMetrics(current, theme, width).text,
      });
      assert.equal(plain(rows[0]).includes('🚀'), active);
      assert.match(plain(rows[1]), /draft stays intact/);
      assert.ok(rows.every(row => visibleWidth(row) <= 160));
    }
  }
});

const planning = '\x1b[33m⏸ plan\x1b[39m';
test('composer shows a plan icon only for active planning, not execution or other notices', () => {
  for (const statuses of [[planning], [], ['📋 0/2'], ['🚀'], ['not ⏸ plan']]) {
    const { text, usageSpan } = renderComposerMetrics({ ...model, statuses }, theme, 160);
    assert.equal(plain(text).includes('📋'), statuses.includes(planning));
    if (usageSpan) assert.match(plain(sliceByColumn(text, usageSpan.start, usageSpan.end)), /^usage/);
  }
});

test('plan icon remains with hidden metrics and width-safe through resize', () => {
  const current = { ...model, statuses: [planning] };
  const hidden = { density: 'comfortable', visibility: { modelDetails: false, usageCost: false } };
  assert.equal(plain(renderComposerMetrics(current, theme, 80, undefined, hidden).text), '📋');
  for (const width of [0, 1, 2, 3, 8, 20, 40, 80, 160]) {
    const metrics = renderComposerMetrics(current, theme, width);
    assert.ok(visibleWidth(metrics.text) <= width, `metrics width ${width}`);
    if (width >= 8) assert.match(plain(metrics.text), /📋/);
  }
});

test('both composer styles show and clear the icon without changing the draft', () => {
  for (const style of ['float', 'neon']) for (const state of ['idle', 'working', 'queued']) {
    for (const statuses of [[planning], []]) {
      const rows = framePromptLines(['─', 'draft stays intact', '─'], 160, {
        state, tick: 0, style, borderColor: text => text, ...theme,
        topRight: width => renderComposerMetrics({ ...model, statuses }, theme, width).text,
      });
      assert.equal(plain(rows[0]).includes('📋'), statuses.length > 0, `${style} ${state}`);
      assert.match(plain(rows[1]), /draft stays intact/);
      assert.ok(rows.every(row => visibleWidth(row) <= 160));
    }
  }
});
