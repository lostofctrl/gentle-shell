# Local fork customization

This branch, `custom/local-patches`, is a personal fork of
[`Gentleman-Programming/gentle-shell`](https://github.com/Gentleman-Programming/gentle-shell)
maintained at [`lostofctrl/gentle-shell`](https://github.com/lostofctrl/gentle-shell).
It is installed directly as a Pi package; it is not published to npm.

## Behavior changes

Everything below applies **only while the primary session is in YOLO mode**.
`normal` and `auto` modes, child sessions, and named subagents keep the upstream
behavior. The mode is resolved through the existing identity-bound
`YoloSessionController`; no second permission controller exists.

- Primary destructive-command confirms are skipped. Sensitive paths, delivered
  test lint, writer admission, and child policy still apply.
- The mandatory ODD workflow prompt is replaced by the identity/continuity prefix.
  Lines naming a Spanish variant are filtered out.
- Automatic review follow-up, context-backstop notices, and delivery-slice notices
  are suppressed; their bookkeeping still runs.
- The ASSESS guidance becomes advisory for that turn.
- Model-profile application skips its routing confirmation and keeps the disclosure
  as a warning.
- A validated primary-TUI review candidate is granted automatically. Reviews and
  their model costs still occur; native validation, candidate binding, revocation,
  and one-shot provider consent remain authoritative. No standing session permission
  is created.

The first and last items are deliberately more permissive than upstream. Keep YOLO
off when you want upstream safety dialogs.

## Composer customizations

- Latest user prompt preview, italic and faint, right-aligned in the header.
- Plan-mode **📋** icon in the composer metrics while read-only planning is active.
- Metrics and `…/path ⎇ branch ±N` moved into the composer frame for both float and
  neon styles, with the ordinary footer chrome suppressed while the composer owns it.
- Icon-only 🚀 YOLO status.
- `rtk proxy git …` accepted by the YOLO push/commit fast path.

## Verify

```sh
pnpm install --frozen-lockfile
pnpm test
pnpm run typecheck
```

`tests/local-composer.test.mjs` covers the composer changes and
`tests/local-yolo-patch.test.ts` covers the mode gating.

## Install this fork in Pi

```sh
pi remove npm:gentle-pi
pi install git:github.com/lostofctrl/gentle-shell#custom/local-patches
```

Reload or start a fresh session afterwards. Do not load the separate local
`gentle-patch` extension at the same time: its on-disk patching targets the official
npm layout and duplicates these changes.
