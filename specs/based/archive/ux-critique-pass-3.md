# UX critique pass 3 — crash recovery, tab strip, query errors, data-first Data tab, Capi readiness

**Source:** `.impeccable/critique/2026-10-28T14-22-26Z__ui-src.md` (27/40). Scope agreed: everything — both P1s, the three P2s, and every minor item. Data tab goes "data first" (mockups: before/after screenshots shown 2026-10-28). Target on re-critique: ≥ 30/40.

**Branch:** continue on `ux/critique-pass` (local, unpushed) so all three passes ship in one PR.

**Order:** harden → adapt → clarify → distill → onboard → minor items. Each phase is independently shippable.

## Phase 1 — A render error never white-screens the app (P1, first)

**Problem.** No error boundary exists anywhere in `ui/src`. Embeddings threw a deck.gl WebGL error during mount, React unmounted the whole tree, and the window went white. The tab meta saves `view: "embeddings"` (`store.ts:412`), so the next launch crashes again.

**Change.**
- New `ui/src/components/ErrorBoundary.tsx` (class component — the only React API that catches render errors). Props: `resetKey`, `fallback(error, reset)`.
- **Tab boundary.** `App.tsx:286-290` wraps the active tab body in a boundary keyed by `activeTab.id`. Fallback: "This tab failed to draw." + `ErrorDetail` (headline + Full error) + a "Close tab" button. The rail, tab strip, and Capi stay alive.
- **Table-view boundary.** `TableDetailsView.tsx:415-418` wraps the view body in a boundary keyed by `tab.view`. Fallback: "The {view} view failed." + `ErrorDetail` + "Switch to Data". When the failed view is `embeddings`, the store sets `tab.view = "data"` so the saved session never reopens into the crash.
- **Root boundary.** `main.tsx` wraps `<App />`. Last resort only: "based hit an error" + `ErrorDetail` + "Reload window".
- **WebGL check.** `EmbeddingsCanvas` creates a throwaway `webgl2` context before it builds the Deck. With none, the view shows "The embeddings map needs WebGL 2, and this window could not start it." in place of the canvas — no throw. Deck's own `onError` (async device errors that a boundary cannot catch) routes to the same message.

**Not doing.** No error reporting to a server; no automatic retry.

## Phase 2 — Tab strip: "+" and toggles never scroll away (P1)

**Problem.** `TabStrip.tsx:75` puts `overflow-x-auto` on the whole strip, so with many tabs "+" and the plan/stats toggles scroll off. The close button sits inside `role="tab"`, so a screen reader names each tab "docs Close tab". SQL-derived titles collide ("select plain" ×4).

**Change.**
- Only the tablist scrolls (`min-w-0 flex-1 overflow-x-auto`, thin scrollbar). "+", the new all-tabs menu, and the toggles sit in a fixed, non-scrolling group at the right.
- Activating a tab scrolls it into view (`scrollIntoView({ inline: "nearest" })`), including by keyboard.
- **All tabs menu.** A `MenuButton` "⌄" (`title`/`aria-label` "All tabs"), shown only when the tablist overflows (a `ResizeObserver` compares `scrollWidth` and `clientWidth`). One item per tab; the active tab is marked.
- **Close button out of the tab.** Each tab becomes a wrapper (`role="presentation"`) that holds the `role="tab"` element and a sibling close `IconButton`. Same look, same hover reveal, same middle-click close. The tab's accessible name is the title only.
- **Duplicate titles.** A pure `dedupeTitles(tabs)` in `ui/src/lib/` returns display titles. The second and later tabs with the same title get " (2)", " (3)" in tab order. Display only — stored titles do not change.
- **Stats toggle wording.** The tooltip is per engine: SQL Server keeps "STATISTICS TIME, IO". Other engines say "Capture run statistics on next run". The plan toggle hides when `capabilities.plan` is false (if that capability exists; else unchanged).

## Phase 3 — One error look for a failed query (P2)

**Problem.** Three looks for one error: `ResultsPane.tsx:122-131` prints raw text, Output flattens multi-line messages into one line (`OutputPane.tsx:28-33` has no `whitespace-pre-wrap`), and only SQL Server errors get an editor marker, because only `mssqlAdapter.ts:911` sets `textLine`.

**Change.**
- `ResultsPane` error state uses `ErrorDetail` per error: headline in err color, "Line N" prefix when known, Full error disclosure for multi-line text. A "Go to line N" button puts the cursor on that line in the editor.
- `OutputPane`: error lines get `whitespace-pre-wrap break-words`. The duplicate "Output" heading inside the pane goes (Phase 6 minor item); the run status chip stays.
- **Editor markers for DuckDB/Lance SQL.** New pure helper `duckErrorLine(message)` in `core/src/db/` reads DuckDB's `LINE n:` suffix. `lanceSql.ts:282` maps it to a text line with the statement's start line and sends `textLine`. The statement start comes from locating each extracted statement's text in the script, in order.
- **Snowflake.** `snowflakeAdapter.ts:939` already sends `line`. Add `textLine` = statement start line + `line` − 1, with the same statement-start lookup.

**Risk.** DuckDB's `extractStatements` gives no offsets. If the text search for a statement fails (for example, DuckDB normalized it), send no `textLine`. The error still shows; only the marker is missing.

## Phase 4 — Data tab leads with data (P2)

**Problem.** The Data tab stacks three toolbars: search row, profile hint, browse row. It opens on Vector with no embedding profile, although the table has a full-text index and Text would run.

**Change** (per the approved mockups):
- **Browse state (default).** One toolbar row: Prev/Next, range, a compact "Search rows…" field (about 15rem) with a `Ctrl+F` hint, then edit actions, read-only note, export. The search row is not rendered. The field shows only when at least one search mode runs.
- **Search state.** Focus on the compact field, or `Ctrl+F` anywhere in the Data tab, opens the search row and moves focus to its query input (typed text carries over). The row: mode menu, query, Run, Clear, row count, Tuning, ✕. `Esc` in the query input or ✕ closes search: it clears the result and returns to the browse row. The existing rule stays: the browse row hides while a result shows.
- **Mode as a menu.** The three-button radio group becomes a `MenuButton` "Text ▾". Blocked modes show as disabled items with their reason. `MenuButton`/`MenuAction` gain `disabled` and `hint`; disabled items are skipped by arrow keys and announce `aria-disabled`.
- **Default mode** is a pure `defaultSearchMode({ hasFts, hasVectorColumn, hasEmbeddingProfile })` in `ui/src/lib/`:
  - Vector, when a vector column and an embedding profile both exist.
  - Else Text, when a full-text index exists.
  - Else Vector, when a vector column exists (the profile hint shows).
  - Else null (no search).
  The user can still choose Vector with no profile; this only decides the opening mode.
- **Profile hint merges into the row.** When Vector/Hybrid has no profile, the Run slot shows "Choose embedding profile" (or "Add embedding profile") in place of Run. Same `chooseProfile` action. The separate hint row goes.
- `searchOpen` lives in the grid session (`TableGridSession`), so it survives a view switch with the rest of the search.
- `Ctrl+F` calls `preventDefault` only when focus is inside the Data tab, so the webview's own find bar is not affected elsewhere.

## Phase 5 — Capi says early when it cannot answer (P2)

**Problem.** The Capi empty state reads as ready. With no profile, no key, or a stopped model server, the user only learns it after a send fails.

**Change.**
- New core route `GET /api/ai-profiles/active/status` → `{ state: "none" | "no-key" | "unreachable" | "ok", profileName?, detail? }`.
  - `none`: no profile (same condition as `server.ts:163`).
  - `no-key`: the profile kind needs a key and `hasKey` is false.
  - `unreachable`: OpenAI-compatible profiles only — `GET {baseUrl}/models` with a 3 s timeout fails. Hosted kinds (openai, azure-openai, anthropic) get no network probe, so no cost and no delay.
  - The models request is a shared helper so `model-id-validation.md` reuses it later.
- The UI checks the status when the rail opens, when the active profile changes, and after a failed send. One line above the composer for any state except `ok`, for example "No agent profile yet." / "The model server at localhost:1234 is not answering." with a "Settings → Agent" button (`openSettings("agent")`). The composer stays enabled — a stopped server can come back.
- The collapsed rail shows a small err dot with the same text as its tooltip.

**Not doing.** No polling. No send blocking.

## Phase 6 — Minor items

1. **Result-set chips** (`ResultsPane.tsx:63-77`): render only when there are 2 or more result sets.
2. **Output handles**: remove the "Output" heading inside `OutputPane` (the bottom tab already names it). The toolbar checkbox becomes a toggle button with `aria-pressed`, matching the plan/stats toggles' pattern.
3. **"Open sql"** (`ExplorerContextMenu.tsx:99`) → "Open SQL".
4. **Stats tooltip wording**: done in Phase 2.
5. **No-connection rail**: `LeftRail.tsx:298-328` hides the database and schema selectors when no connection is active (they are disabled and empty today).
6. **Fonts**: `index.html` keeps only the default theme's families (Fraunces, IBM Plex Sans, IBM Plex Mono). `applyTheme` adds one `<link>` with the active theme's three families when they differ. ThemePicker loads the full list when it opens, for its previews. A pure `themeFontUrl(theme)` builds the URL.
7. **Collapsed Capi rail** (`RightRail.tsx:396-405`): 36px wide, the `CapiMark` at the top, the vertical label at `--fs-base` and `text-paper-dim`, plus the Phase 5 status dot. `aria-label="Expand Capi"`.
8. **Stale query-tab titles**: not doing. Titles stay sticky (BASED-TAB-AUTONAME-APPLY names a tab once; a title that changes under the user confuses them). Duplicates are handled by the Phase 2 suffix.
9. **Close button inside `role="tab"`**: done in Phase 2.
10. **Font slider** (`ThemePicker.tsx:72`): `aria-label="Font size"` and `aria-valuetext` as a percent.

## Spec impact

New:
- **BASED-UI-ERROR-BOUNDARY** (manual): tab, table-view, and root boundaries; a failed Embeddings view falls back to Data and is not restored. WebGL 2 missing shows a message, not a crash.
- **BASED-QUERY-ERROR-LINE** (test): `duckErrorLine` on single-line, multi-line, and no-`LINE` messages; statement-start mapping for a 3-statement script.
- **BASED-TAB-TITLE-DEDUPE** (test): `dedupeTitles` — unique titles unchanged, duplicates suffixed in tab order, closing a tab renumbers.
- **BASED-LANCE-SEARCH-DEFAULT** (test): `defaultSearchMode` truth table.
- **BASED-AGENT-READY** (manual): status route states and the Capi line; collapsed rail dot.

Modified:
- BASED-UI-TABS (pinned "+" and toggles, All tabs menu, close button outside the tab)
- BASED-UI-RESULTS (chips only for 2+ result sets)
- BASED-UI-QUERY-ERROR (ErrorDetail, Go to line, markers for DuckDB and Snowflake)
- BASED-UI-OUTPUT (wrapped error text, single heading, toggle button)
- BASED-LANCE-SEARCH-UI (browse-first row, Ctrl+F, mode menu, inline profile action, `searchOpen` in session)
- BASED-EMBED-UI (WebGL 2 check)
- BASED-THEME (per-theme font loading)
- BASED-AI-PROVIDER-PROFILES (status route)

## Verification

- `bun run typecheck`; `cd specs && bun test .`. New unit tests fail first for the right reason (missing export), then pass.
- Live in Playwright (msedge), core and Vite started separately, LanceDB fixture with an FTS index and a vector column:
  1. Force WebGL off (`--disable-gpu --disable-webgl` launch flags) and open Embeddings: message, no white screen. Throw from a test hook in a view: the view fallback shows, "Switch to Data" works, a reload opens on Data.
  2. Open 15 tabs at 1024px: "+", All tabs, and the toggles stay visible; All tabs activates and scrolls to a tab. Four "select plain" tabs read "select plain", "(2)", "(3)", "(4)". Rerun with new SQL: the title does not change.
  3. Lance SQL with a syntax error on line 3 of a 3-statement script: marker on line 3, ErrorDetail in results, wrapped text in Output, Go to line works.
  4. Data tab: opens as one toolbar row on Text (no profile). Ctrl+F opens search; Esc returns to browse. Mode menu shows Vector with the profile reason when blocked.
  5. No AI profile: Capi line + Settings button; collapsed rail dot. Profile pointing at a closed port: "not answering" line.
  6. Minor items by eye: single result set has no chip; Output has one heading; "Open SQL"; no selectors with no connection; Network panel shows one fonts CSS at startup; slider name in the accessibility tree.
- Re-run `/impeccable critique ui/src` and record the score in this plan's Outcome before archiving.

## Outcome (2026-10-29)

All six phases shipped. Re-critique: 28/40 (trend 24 → 25 → 27 → 28); the target of 30 was not reached.

- Phase 1: the Embeddings crash had a root cause beyond the missing boundary. `EmbeddingsView` called `deck.getViewports()` before deck.gl's device was ready, which asserts. Label projection and the lasso now wait for `deck.isInitialized`, and `onLoad` triggers the first label pass. The map now draws in headless Edge; with `--disable-webgl` the WebGL message shows.
- Phase 3: DuckDB puts `LINE n:` on binder errors too, and n counts lines of the whole script, so `statementStartLines` is only the fallback. `statementStartLines(script)` scans the text itself (DuckDB gives no statement offsets), so the plan's "find each statement's text" idea was dropped.
- Phase 4: a persisted search result keeps the search row open even if `searchOpen` is false. The `Ctrl+F` hint uses the platform accelerator.
- Phase 6: ThemePicker shows no font previews, so it does not load every family. A new requirement, BASED-THEME-FONT-LOAD (test), covers `themeFontUrl`.
- Verified live with Playwright on a LanceDB fixture: one-row Data tab, Ctrl+F/Esc, mode menu, the inline profile action, the view boundary, a line-3 marker and Go to line, a script-relative binder-error marker, deduped titles, pinned "+"/All tabs at 1024px, close-button names, the readiness line and rail dot (state injected), and Embeddings with and without WebGL.
- Not verified live: the tab and root boundaries (only the view boundary was forced), a real unreachable model server (state was injected; the route returned `ok` for the configured profile), and Snowflake markers (no Snowflake account).
- New issues from the re-critique: a batch that fails partway shows the earlier result grid as if it succeeded; rails do not adapt at 1024px with Capi open; Output is open by default and repeats errors; search results show raw scores and mixed mode names (Text / Keyword / Keywords).
