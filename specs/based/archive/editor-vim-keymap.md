# Plan: vim keymap for the query editor

## Spec impact

**New requirement:** `BASED-EDITOR-VIM` — Settings → General offers `default` | `vim` for the query editor's keymap;
`vim` gives modal editing, with the mode indicator and `:` command line hosted in the app's existing bottom status bar,
and `:w` / `:q` / `:wq` wired to the app's save/close-tab actions. Test category **manual**.

**Modified requirement:** `BASED-SETTINGS` — gains the `editorKeymap` key (default `"default"`), which round-trips
through `GET`/`POST /api/settings` like every other setting. Covered by an added case in
`specs/based/tests/integration.settings.test.ts`.

No other requirement changes: theming, tab persistence, and the editor's existing keybindings are untouched.

## Approach

`monaco-vim@0.4.4` on top of the stock `monaco-editor` the app already uses (not the `@codingame` fork the
LSP client deliberately avoids — see `ui/src/lsp/client.ts`). It is loaded through a dynamic `import()` inside
`ui/src/vimMode.ts`, so it ships as its own lazy chunk and costs nothing when the keymap is off.

monaco-vim wants a DOM node for its status output. It gets a slot in `StatusBar.tsx` rather than a second bar under the
editor — the app already has a status bar, and reusing it means the vim UI inherits the active theme with no new theme
tokens. The node is borrowed: monaco-vim writes into it and its `dispose()` clears it again.

Two implementation constraints worth recording:

- The vim attach/detach effect in `EditorPane` is **separate** from the editor-creation effect. Folding them together
  would rebuild the editor on every keymap toggle and discard the undo stack.
- React StrictMode double-invokes effects, so the attach is guarded by a `cancelled` flag and always disposed —
  otherwise two adapters land on one editor and every keystroke doubles.

monaco-vim's status bar shouts `--INSERT--`. The project's UI rules rule out uppercase labels, so a small subclass
overrides `setMode` to write "Normal" / "Insert" / "Visual line", with emphasis from font weight.

## Files

- `ui/package.json` — add `monaco-vim`
- `core/src/storage/settings.ts`, `ui/src/api/types.ts`, `ui/src/store.ts` — the `editorKeymap` setting
- `ui/src/components/ThemePicker.tsx` — the General-tab select
- `ui/src/vimMode.ts` (new) — on-demand load, themed status bar, ex-command registration
- `ui/src/components/EditorPane.tsx` — attach/detach effect
- `ui/src/components/StatusBar.tsx` — the status slot
- `ui/src/index.css` — `.vim-status` rules (the injected `:`-command `<input>` must inherit, not render native)
- `specs/based/tests/integration.settings.test.ts`, `specs/based/tests/manual.ui.test.ts`
