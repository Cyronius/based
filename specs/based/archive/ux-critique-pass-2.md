# UX critique pass 2 — grid edits, focus, LanceDB search, 1024px, vocabulary, destructive SQL

**Source:** `.impeccable/critique/2026-10-27T18-32-23Z__ui-src.md` (25/40). Scope agreed: the three P1s + the two P2s, and destructive-SQL flagging on the approval card. Target on re-critique: ≥ 30/40.

**Branch:** continue on `ux/critique-pass` (local, unpushed) so both passes ship in one PR.

## Phase 1 — Pending grid edits survive (P1, first)

**Problem.** `TableDataGrid` holds the change set in component state (`TableDataGrid.tsx:214-216`). A switch to another tab, or Details/SQL and back, unmounts the grid and drops every pending edit with no warning. Table tabs never show as dirty, so close has nothing to confirm.

**Change.**
- New per-tab field on `TableTabState`: `grid?: TableGridSession`, in memory only (never written to the tab store). It holds what the change set depends on: the loaded `page`, `offset`, `sort`, `filterExprs`, `browseWhere`, plus `edits`, `newRows`, `deleted`. The edit keys are row indexes into that page, so the page travels with them. Paging is already blocked while edits are pending (`:870-880`), so the page cannot drift under the edits.
- `TableDataGrid` reads and writes that slice through one store action, `patchTableGrid(tabId, partial)`, instead of `useState`. On mount with a saved slice it renders the saved page and does not refetch.
- The search session (mode, query, result, Tuning values) moves into the same slice, so a search also survives a tab switch.
- Selection, menus, and in-flight flags stay local.
- `pendingCount` moves to a pure helper `gridPendingCount(grid)` in `ui/src/lib/` (shared by the grid and the tab strip).
- Dirty mark: a table tab with `gridPendingCount > 0` shows the same `•` as a dirty query tab (`TabStrip.tsx:79`).
- Close: `closeTabs` treats such a tab as unsaved. The opt-in confirm (off by default) lists it as "dbo.Orders — 3 pending changes". With the confirm off it closes silently, as query tabs do.
- Reopen: the closed-tab snapshot carries `grid`, so Ctrl+Shift+T brings the pending edits back in the same session.
- Connection switch: the per-connection view cache already keeps `tabs`, so the slice comes along with no extra work.

**Not doing.** No new "you have unsaved edits" prompt anywhere (standing rule: no nag prompts). Window close behaves as it does today.

## Phase 2 — Approval card flags destructive SQL

**Change** (`capiTools.tsx` ApprovalCard / ApprovalFrame):
- New pure helper `describeStatements(sql)` in `ui/src/lib/sqlText.ts`, built on `statementSpans`. It returns one entry per statement: `{ kind, table?, noWhere }`.
  - `kind` is the leading verb: SELECT, INSERT, UPDATE, DELETE, MERGE, TRUNCATE, DROP, ALTER, CREATE, EXEC, or OTHER.
  - A WITH-led statement takes the first top-level verb after its CTE list.
  - `table` is the target name after UPDATE / DELETE [FROM] / TRUNCATE TABLE / DROP <type>, when it parses.
  - `noWhere` is true for UPDATE/DELETE with no top-level WHERE. Text in strings, comments, and parentheses does not count.
- The card header gets a badge per distinct kind ("UPDATE", "DELETE · 2"), beside the title.
- A warning line, in the err color, for each statement that changes every row: "No WHERE — changes every row in dbo.Orders". TRUNCATE gets the same line.
- Approve turns red (err outline, not ok-green) when any statement is DROP, TRUNCATE, DELETE, or a no-WHERE UPDATE. The label and the flow stay the same. No extra dialog.
- Mutation cards only. The import and create-table cards keep their current look.

## Phase 3 — Visible focus (P1)

- One global rule in `index.css`: `:focus-visible { outline: 2px solid var(--color-brass); outline-offset: 2px }`. Monaco and the Glide grid canvas keep their own focus look; they are excluded.
- `IconButton` gets the same ring explicitly (`focus-visible:outline-*`), so a `className` cannot drop it.
- Remove stray `outline-none` / `focus:outline-none` where no replacement focus style exists. Inputs that already show `focus:border-brass` keep it.
- Row-count badge on the results tab (`ResultsPane.tsx:79`): `text-faint` → `text-muted` (4.3:1 → AA).
- Extend `unit.themeContrast.test.ts`: brass against `ink-900` and `ink-950` is ≥ 3:1 in every theme (WCAG non-text contrast). If a theme fails, nudge its brass, not the rule.

## Phase 4 — LanceDB search offers only what the table can run (P1)

The table tab already loads `indexes` (`store.ts:586-591`), and Lance indexes carry `typeDesc`.

- Text and Hybrid need a full-text (INVERTED/FTS) index. When `indexes` is loaded and has none, those radios are `aria-disabled`, and their tooltip says "Needs a full-text index on a text column". When `indexes` is unknown (fetch failed), every mode stays on.
- Vector and Hybrid need a vector column. With no vector column, those modes are disabled with the same pattern.
- The default mode is the first mode the table can run (vector → text).
- Vector/Hybrid with no embedding profile: Run stays enabled, but a hint under the row reads "Choose an embedding profile". The hint has a button that opens Tuning and focuses the Embedding select. With no profiles at all, the button opens Settings → Embedding profiles.
- Errors: extract the headline + "Full error" disclosure from `TableTabError` (`TableDetailsView.tsx:339-375`) into a shared `ErrorDetail` component. A pure `errorHeadline(full)` in `ui/src/lib/` cuts at the first line or "Caused by:". Use it for `searchError`, `loadError`, and `commitError` in the grid, and in `TableTabError`.

## Phase 5 — Toolbars fit at 1024px with Capi open (P2)

- Query toolbar (`QueryTabView.tsx:~95-140`): a container query on the toolbar. Below about 560px of toolbar width, Open…, Save, and Save As… fold into one "More" `IconButton` menu, and the file path hides (its full text stays in the tab tooltip). Run, Rows, and Output always stay visible. Nothing wraps inside a button (`whitespace-nowrap`).
- Results toolbar (`ResultsPane.tsx:53`): only the result-set buttons scroll sideways, in their own region. The view switch, row count, and actions stay pinned. Phase 6's Export menu removes most of the width.
- Not doing: a Capi rail width cap. Container queries fix the toolbars at any rail width, so a cap adds a second mechanism for the same problem.

## Phase 6 — One vocabulary for tabs, Run, and export (P2)

- **Tabs.** New `ui/src/components/Tabs.tsx`: tablist, roving tabindex, arrow/Home/End keys (same rules as BASED-UI-A11Y-KEYBOARD), and one look: an underline, brass when active. Use it for every secondary tab set:
  - ResultsPane Grid/Text/Plan
  - PlanView
  - LeftRail Objects/History
  - HistoryPanel
  - TableDetailsView Details/Data/SQL
  - ThemePicker Settings sections

  The document tab strip (`TabStrip`) and the bottom panel strip (`BottomTabPanel`) keep the top-bar look. That gives two tiers: documents/panels, and views inside them.
- **Run.** New `RunButton` (ok-green outline, "▶ Run", `whitespace-nowrap`). Use it in the query toolbar, the LanceDB search row (replaces the brass Run), and the Capi code-block Run.
- **Export.** `GridToolbarActions` becomes: Fit columns (text), Copy as a `CopyIcon` `IconButton` (project rule), and one "Export ▾" menu with Copy as Markdown, Save as CSV, and Open in Excel. The same hook feeds it, so the context menu and notices do not change. It applies to all three grids.

## Spec impact

New:
- **BASED-TABLE-EDIT-RETAIN** (manual): pending Data-tab edits and the search session survive a tab, view, or connection switch. A table tab with pending edits shows the dirty mark. Close goes through the opt-in confirm, and reopen restores the edits.
- **BASED-APPROVAL-RISK** (test): `describeStatements` kinds, target table, and no-WHERE detection. Cases include strings/comments with WHERE, a WHERE in a subquery only, a CTE-led DELETE, multi-statement batches, TRUNCATE, and DROP. Card rendering is manual.
- **BASED-FOCUS-VISIBLE** (test for the brass ≥ 3:1 contrast in every theme; manual for ring presence).
- **BASED-ERROR-HEADLINE** (test): `errorHeadline` on a single line, a multi-line error, and a Lance "Caused by:" chain.

Modified:
- BASED-UI-TABS (dirty mark covers table tabs)
- BASED-TAB-CLOSE-CONFIRM (lists table tabs with pending edits)
- BASED-TAB-REOPEN (restores pending edits)
- BASED-UI-TABLE-EDIT (edits persist across switches)
- BASED-UI-APPROVAL-CARD (kind badge, no-WHERE warning, red Approve)
- BASED-THEME-CONTRAST (row-count badge)
- BASED-UI-A11Y-KEYBOARD (shared Tabs)
- BASED-LANCE-SEARCH-UI (disabled modes, profile hint, error headline, shared Run)
- BASED-UI-EXEC-PLAN (query toolbar overflow)
- BASED-GRID-EXPORT-STANDARD (Copy icon + Export menu; step 3 of its procedure changes)
- BASED-UI-TABLE-TAB-ERROR (uses the shared ErrorDetail)

## Verification

- `bun run typecheck`; `cd specs && bun test .`. The new unit tests must fail first for the right reason (missing export), then pass.
- Live in Playwright (msedge), with core and Vite started separately:
  1. Edit 2 cells, then switch tab → SQL view → back: the edits are still marked, and the tab shows `•`.
  2. Close the tab, then Ctrl+Shift+T: the edits come back. Turn the confirm on, close again: the dialog lists the table.
  3. Capi proposes `DELETE FROM t`: DELETE badge, no-WHERE line, red Approve. `UPDATE … WHERE id=1`: badge only, normal Approve.
  4. Tab through the toolbar on a dark theme and on a light theme: a brass ring is on every control.
  5. A Lance table with no FTS index: Text/Hybrid are disabled with a tooltip. Vector with no profile: the hint opens Tuning. Force an error: headline + Full error.
  6. 1024×768 with Capi open: the query and results toolbars show Run, Rows, and Export with no clipped or wrapped labels.
- Re-run `/impeccable critique ui/src` and record the score in this plan's Outcome before archiving.

## Outcome (2026-10-28)

All six phases shipped. Re-critique: 27/40 (trend 24 → 25 → 27); the target of 30 was not reached.

- Phase 1: the grid session lives in `TableTabState.grid`. Reload effects compare against what was last loaded, not first-run refs, because StrictMode's double effect run had cleared restored edits. An agent `show_results` filter now reaches the first fetch (it raced the mount load before).
- Phase 3: 13 themes had an accent below 3:1 and were nudged by the smallest shift (Marrakech moved most: #4a6bff → #9fb1ff).
- Phase 4: a table that can run no search mode shows one line in place of the search row.
- Phase 5: the results toolbar wraps onto a second line in a narrow pane instead of hiding actions; no Capi rail cap.
- Verified live with Playwright on a LanceDB fixture: search session and dirty mark survive view switches, the confirm lists "docs — 2 pending changes", Ctrl+Shift+T restores the edits, disabled modes and tooltips, the profile hint, the Export and More menus with keyboard, the focus ring on a dark and a light theme, and the 1024px toolbars with Capi open.
- Not verified live: real cell editing (no SQL Server reachable; Glide does not render headless) and the approval card (no model available). Both are covered by unit tests for the logic only.
- New issues from the re-critique: Embeddings white-screens the app with no error boundary and the saved view repeats it; tab-strip overflow hides "+"; query errors are not on ErrorDetail; the Data tab opens on Vector with no profile when Text would run; Capi gives no early "no model" sign.
