# Theming + app settings — COMPLETED

**Requirements added:** `BASED-SETTINGS` (integration), `BASED-THEME` (manual). See spec.md → *Settings / Appearance*.

## Context
Anticipated need for theming + general settings. Decided to defer frameless/custom window chrome
(macOS-shaped in Electrobun 1.18.1; forfeits Win11 snap/drag on the Windows-first target) and ship
theming under the native frame instead. Full decision: `~/.claude/plans/we-ll-probably-need-theming-dynamic-finch.md`.

## What shipped
- **18 themes** (11 dark / 7 light). Single source of truth: `ui/src/theme.ts` (`THEMES`). Full font
  swap per theme.
- **Application model:** `applyTheme(id)` writes CSS custom properties (`--color-*`, `--font-*`, shadcn
  tokens, `color-scheme`) onto `<html>`, so Tailwind v4 utilities retint at runtime. Monaco (`based`
  theme via `syncMonacoTheme`) and both Glide grids (`gridThemeFromCss` / `gridCellOverrides`) read the
  live variables back off the DOM — no duplicated palettes.
- **Persistence:** server-side, single-row `app_settings` table + `SettingsStore` (mirrors `AiConfigStore`)
  + `GET/POST /api/settings`. localStorage holds a first-paint hint to avoid flash; server is source of truth.
- **UI:** `ThemePicker` in the LeftRail header (grouped dark/light, live swatches). Fonts loaded via
  `ui/index.html` Google Fonts link.

## Key files
`ui/src/theme.ts`, `ui/src/components/ThemePicker.tsx`, `ui/src/store.ts` (theme/setTheme/loadSettings),
`ui/src/main.tsx` (pre-paint apply), `ui/src/monacoSetup.ts` + `EditorPane.tsx`,
`ui/src/components/ResultGrid.tsx` + `TableDataGrid.tsx`, `ui/src/index.css` (color-scheme + scrollbar tokens),
`core/src/storage/settings.ts` + `db.ts` + `server.ts` + `index.ts`.

## Verification
- Integration: `specs/based/tests/integration.settings.test.ts` (3 pass) — defaults, POST→GET persistence
  across store reopen, partial-merge.
- Manual (BASED-THEME acceptance criteria): pick a theme → chrome/editor/grids/native controls + fonts
  recolor with no reload; survives restart.
- `bun run typecheck` (core/ui/shell) + `bun run build:ui` green.
