# Help docs window — ? icon opens a keyboard-shortcuts page

## Goal

A `?` icon next to the settings gear opens a documentation page in its own window, themed with
the app's active palette. Initial content: keyboard shortcuts — the app's default bindings and
the vim-mode keymap. More sections can accrete later without touching app code.

## Spec impact — ALREADY APPLIED to spec.md

Two new requirements were added to the UI section ahead of implementation (per request, to make
the spec the drift-proof source of truth):

- **BASED-UI-SHORTCUTS** — the canonical shortcut binding table + the discoverability rule
  (every shortcut-backed control names its shortcut in the hover tooltip). The tooltip half is
  already implemented (TabStrip, RightRail, QueryTabView). Changing a binding is now a spec
  change to that table.
- **BASED-HELP-DOCS** — the `?` button, the docs page, its window/tab opening behavior, and
  theme sync. Docs content must match the BASED-UI-SHORTCUTS table and BASED-EDITOR-VIM.

No existing requirements modified or removed. Cleanup rider: `ui/src/store.ts:1200` traces to
`BASED-CTRL-N`, which has never existed as a spec heading — repoint that comment to
BASED-UI-SHORTCUTS while in there.

## Design

### The page: `ui/docs.html` — a second Vite entry (not `public/`)

Multi-page build (`build.rollupOptions.input: { main: index.html, docs: docs.html }`). The page
loads a tiny `src/docsMain.ts` — no React:

- Imports `applyTheme` + `themeHint` from `src/theme.ts` and applies the current theme on load,
  so all ~50 palettes come from the single existing source of truth.
- Listens for the `storage` event (fires across same-origin windows; the app and docs page share
  an origin in every mode) and re-applies on `based.theme` changes → **live** theme sync while
  the docs window is open. `applyTheme`'s own localStorage write-back can't loop: the writing
  window gets no storage event and same-value sets fire none.
- Page CSS is written against the CSS variables `applyTheme` sets (`--color-ink-950`,
  `--color-brass`, `--font-sans`, …). Same Google Fonts links as `index.html` so theme font
  stacks resolve.
- Vite dev server serves `/docs.html` natively; the built file lands in `ui/dist` where
  `serveStatic` (core/src/server.ts:1255) already serves it by path. No server changes for
  serving.

Content sections (must match spec):
1. **Keyboard shortcuts** — render the BASED-UI-SHORTCUTS table verbatim.
2. **Vim mode** — enable via the settings popover's editor keymap; monaco-vim motions; `:w`
   save, `:q` close tab (`q!` semantics — discards), `:wq`; app shortcuts work in every mode;
   Ctrl+W stays close-tab, shadowing vim's window prefix (BASED-EDITOR-VIM).

### Opening it: same pattern as Ctrl+N's new-window flow

- **Core** (`core/src/server.ts`): `POST /api/window/docs` → optional
  `opts.onRequestDocsWindow?.()`; `{ ok: true }` when a handler ran, `{ ok: false }` when none
  is registered (dev core, tests). Mirrors `/api/window/new` / `onRequestNewWindow`.
- **Shell** (`shell/src/bun/index.ts`): pass `onRequestDocsWindow` → BrowserWindow at
  `${baseUrl}/docs.html` (smaller frame, title "based — help"). Module-level reference so
  repeated clicks reuse/recreate one docs window instead of stacking copies.
- **UI**: `openDocsApi()` in `ui/src/api/client.ts`; the `?` button falls back to
  `window.open("/docs.html", "_blank")` on `ok: false` or error — the dev-browser path.
  (Known wrinkle: BASED_DEV_URL + shell dev mode also lands on the fallback since dev:core has
  no shell handler; `window.open` inside the electrobun webview is untested there — dev-only.)

### The button

- `IconButton` with a `?` glyph in the **left-rail header, next to the settings gear** —
  LeftRail.tsx:171-174, beside `<ThemePicker />`. `title` / `aria-label`: "Help & keyboard
  shortcuts".
- **No keyboard shortcut initially.** F1 collides with Monaco's command palette whenever the
  editor has focus; punting until that's worth resolving.

## Files touched

| File | Change |
|---|---|
| `specs/based/spec.md` | **done** — BASED-UI-SHORTCUTS + BASED-HELP-DOCS added |
| `ui/docs.html` | new — docs page markup (second Vite entry) |
| `ui/src/docsMain.ts` | new — theme apply + storage-event live sync |
| `ui/vite.config.ts` | rollupOptions.input for the second entry |
| `core/src/server.ts` | `POST /api/window/docs` + `onRequestDocsWindow` in ServerOptions |
| `shell/src/bun/index.ts` | wire `onRequestDocsWindow` → single reusable docs BrowserWindow |
| `ui/src/api/client.ts` | `openDocsApi()` |
| `ui/src/components/LeftRail.tsx` | `?` IconButton beside the gear, with `window.open` fallback |
| `ui/src/store.ts` | comment fix: `BASED-CTRL-N` → `BASED-UI-SHORTCUTS` |

## Risks / notes

- Drift is now spec-anchored: BASED-UI-SHORTCUTS is the one table; tooltips, App.tsx bindings,
  and docs.html all trace to it, and its manual procedure includes the three-way cross-check.
- No executable test (manual category): window creation is shell/UI behavior; the route is
  trivial and exercised by the manual pass.
- Packaged-app check: confirm `scripts/package-win.ps1` / electrobun copy picks up `docs.html`
  in `ui/dist` (it copies the whole dist dir today, so it should ride along free).
