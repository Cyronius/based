# UX critique pass 4 — failed batches, laptop width, Output, search results, consistency

**Source:** `.impeccable/critique/2026-10-29T21-48-09Z__ui-src.md` (28/40). Scope agreed: everything — both P1s, the three P2s, and every minor item. Failed batch goes first. Plan/Stats stay in the tab strip (user decision). Target on re-critique: ≥ 31/40.

**Branch:** continue on `ux/critique-pass` (local, unpushed) so all four passes ship in one PR.

**Order:** harden → adapt → distill → clarify → polish → minor items. Each phase can ship alone.

## Phase 1 — A batch that fails partway looks failed (P1, first)

**Problem.** `ResultsPane.tsx:132` shows the error branch only when no result set exists. `select 1; select bogus; select 3;` shows statement 1's grid with normal styling. The error is only in Output and the status bar. The error chunk (`core/src/db/types.ts:129`) carries no statement number, so the UI cannot place the error.

**Change.**
- **Protocol.** The `error` chunk gains optional `statement?: number` (1-based) and `statementCount?: number`.
  - `lanceSql.ts:190` sends both (it has `i` and `extracted.count`).
  - `mssqlAdapter.ts` sends the batch number as `statement` and the batch count as `statementCount` (GO-separated batches are its statements).
  - Snowflake sends `statement` when its loop knows it; else nothing.
- **Store.** `queryErrors` entries gain `afterResult: number` (= `resultSets.length` when the error arrives) and `statement`/`statementCount`. No new run state.
- **Result-set strip** (`ResultsPane.tsx:58-80`). The strip shows when there is more than one result set **or** any error. An error slot sits at its `afterResult` position: err color, `ErrorIcon`, label "Statement 2 failed" (or "Error" with no statement number). Selecting it shows the existing `ErrorDetail` + "Line N · go to line" in the grid area.
- **Auto-select.** When a run ends with an error, the active slot moves to the first error slot. The user can still click back to a grid.
- **Header note.** The results header shows "Stopped at statement 2 of 3" in err color when `statementCount` is known; "Stopped with an error" when not. The row-count text stays for the selected grid.
- **Skipped statements.** When `statementCount` is known, statements after the failure show as one muted slot "1 skipped" / "2 skipped". No slot when the count is unknown.
- New pure helper `resultSlots(resultSets, queryErrors)` in `ui/src/lib/` returns the ordered slot list (grid / error / skipped). Unit test: BASED-QUERY-BATCH-FAILURE.

**Not doing.** No "continue on error" option. No per-statement timings.

## Phase 2 — Laptop width: the work column keeps room (P1)

**Problem.** At 1024px with Capi open, the rails take ~65% of the width. The work column is ~350px. The Data toolbar wraps to four rows, and Run/Open/Save fold into "…". The left rail (`LeftRail.tsx:247`) has a fixed saved width and cannot collapse.

**Change.**
- **Work column minimum: 520px.** `App.tsx` measures the window width with a `ResizeObserver` on the root. Each rail gets an effective width = min(saved width, what leaves 520px for `main`). The saved width does not change, so a wider window gives the rail its full width back.
- **Explorer collapse.** When the explorer would get less than 200px, it collapses to a 36px strip (same pattern as the collapsed Capi rail): a database icon, the connection name as tooltip, and an expand `IconButton` (`aria-label="Expand explorer"`). A user can also collapse it by hand with a chevron `IconButton` in its header. The manual state persists in settings; the auto state does not.
- **Capi rail order.** Capi shrinks first (to its 300px minimum), then the explorer collapses, then Capi collapses. The user's open/closed choice wins on the next wide window.
- **Data toolbar overflow.** Under a `@container` width of ~640px, Fit columns, Copy, and Export fold into one `MenuButton` "More" (⋯ `IconButton`, `aria-label="More actions"`). Prev/Next, range, Search rows, and edit actions stay visible.
- **Table title.** The title line uses `truncate` with the full name as `title`. No wrapping.

**Verify** at 1024×768 and 1280×800, Capi open and closed, on a query tab and a LanceDB Data tab.

## Phase 3 — Output stays quiet; errors live in one place (P2)

**Problem.** Output is open by default and says "No messages.". It repeats every error that Results already shows. It auto-scrolls to the end, so a long error shows its caret line and hides its headline. Its toggle uses the accent color and looks like the main action.

**Change.**
- **Closed by default** for new query tabs. The open/closed state stays per tab.
- **Auto-open** only for server messages (`message` chunks: PRINT, notices, STATISTICS output) and for errors that Results cannot show (the outer `catch` in `store.ts:1440` — transport errors with no `error` chunk). Query errors from `error` chunks stay in Results only.
- **No error duplication.** `error` chunks no longer append to `output` (`store.ts:1415`). The Output pane keeps `message` and `system` lines.
- **Scroll to the newest entry's start.** On new lines, scroll so the first new line is at the top, not the last line at the bottom.
- **Quiet toggle.** The Output button uses the neutral toolbar style; pressed state = `bg-ink-800` + text color, not accent fill. A small count badge shows unread messages while closed.

**Spec.** UI-OUTPUT and UI-QUERY-ERROR change: errors appear in Results only.

## Phase 4 — Search results explain themselves (P2)

**Problem.** `_score` shows at full precision and is clipped. The matched text is not highlighted. One mode has three names: "Text" (button), "Keyword — BM25" (tooltip, `TableDataGrid.tsx:144-145`), "Keywords…" (field). The Where placeholder `year > 2020` (`TableDataGrid.tsx:839`) names a column the table may not have.

**Change.**
- **One name: "Keyword".** Mode `short` = "Keyword"; tooltip "Keyword — full-text (BM25)"; query placeholder "Keywords…" stays (it describes the input, and it matches). Hybrid tooltip: "Hybrid — vector + keyword".
- **Score column.** `_score` and `_distance` render with 3 significant figures and a thin bar in the cell (width = value / column max). Column width fits "0.000" + bar. The full value shows in the cell viewer and on copy.
- **Match highlight.** In Keyword and Hybrid results, text cells mark query terms (case-insensitive, whole-token match) with `bg-accent/25`. Only the drawn text changes; data and copy stay raw. The FTS-indexed column gets a wider default width (~40ch).
- **Where placeholder** from the table schema: the first numeric column → `<col> > 0`; else the first string column → `<col> = '…'`; else no placeholder.
- **"1 row".** One `plural(n, "row")` helper for the results header, search toolbar, and Data range text.

## Phase 5 — Consistency (P2, Plan/Stats unchanged)

**Change.**
- **Settings tabs.** `ThemePicker.tsx:1045` Settings uses a left side list (vertical `Tabs` variant: same keyboard, `aria-orientation="vertical"`). The dialog gets a fixed height (min(640px, 85vh)), so it does not re-center on each tab switch.
- **Settings selects** cap at `max-w-[280px]`.
- **Result-set slots are tabs.** The strip from Phase 1 renders with the shared `Tabs` (`role="tab"`, `aria-selected`). Label: "1 · 40 rows" (count with `plural`), error and skipped slots as in Phase 1.
- **Table title above view tabs.** `TableDetailsView.tsx:395`: the schema.table title comes first, the view `Tabs` second, in one header block.

**Not doing.** Plan/Stats stay in the tab strip.

## Phase 6 — Minor items

- **LanceDB Details.** Hide Key/Size/References/Metric columns when every row is empty for this table.
- **Connection menu paths.** Middle truncation (`C:\Users\…\data\docs.lance`) with the full path as `title`. Pure helper `middleTruncate(text, max)` with a unit test.
- **Error squiggle on the token.** DuckDB's message has the source line and a `^` caret line. `duckErrorLine` grows into `duckErrorPosition(message) → { line, column } | null` (column = caret offset). The marker spans the token at that column; with no caret, the whole line as today. Extends BASED-QUERY-ERROR-LINE tests.
- **Read-only note.** Remove "This connection is read-only." from the Data toolbar; the status-bar badge stays. Edit actions stay hidden as today.
- **Vector cells.** `vec[8]` moves to the column header type label; cells show the values only.
- **History empty for LanceDB.** Investigate first. The core add path (`server.ts:1147`) looks correct, so suspect the UI list filter (`connectionId`/`database` mismatch for Lance). Fix if real; record "not reproducible" in the Outcome if not.

## Spec impact

- **New:**
  - BASED-QUERY-BATCH-FAILURE (test): `resultSlots` order and labels for ok / fail-at-2-of-3 / unknown count.
  - BASED-UI-NARROW-LAYOUT (manual): 520px minimum, rail shrink and collapse order, Data toolbar overflow.
  - BASED-LANCE-SEARCH-SCORE (manual): 3-figure score with bar, match highlight.
- **Modified:**
  - UI-OUTPUT, UI-QUERY-ERROR (errors in Results only; Output closed by default, auto-open rule).
  - UI-RESULTS (slots as tabs, error/skipped slots, header note).
  - LANCE-SEARCH-UI (mode name "Keyword", schema-based Where placeholder).
  - BASED-QUERY-ERROR-LINE (column position).
  - THEME / settings requirement (side list, fixed height).
- **Tests:** `unit.resultSlots.test.ts`, `unit.middleTruncate.test.ts`, extend `unit.queryErrorLine.test.ts`. No test for `plural` (too trivial). Red first where natural.

## Verification

- `cd specs && bun test .` and typecheck clean.
- Live (dev core + vite, Playwright msedge):
  - LanceDB: `select 1; select bogus from t; select 3;` → slots "1 · 1 row", "Statement 2 failed", "1 skipped"; error slot selected; header "Stopped at statement 2 of 3"; Output closed.
  - SQL Server (if a dev connection is up): two GO batches, second fails.
  - 1024×768 with Capi open: work column ≥ 520px; explorer collapsed; Data toolbar one row.
  - Keyword search: 3-figure scores, highlighted terms, Where placeholder from a real column.
  - Settings: tab switch does not move the dialog.
- Re-run `/impeccable critique` and record the score in the Outcome.

## Risks

- **Rail auto-collapse can fight the user.** Mitigation: auto state never persists, and a manual expand while narrow shrinks Capi first.
- **Highlight cost.** Term marking runs in the Glide draw callback. Keep it to the visible cells and a precompiled regex per query.
- **mssql statement numbers** are per GO batch, not per statement inside a batch. The label says "Batch 2 failed" for SQL Server.

## Outcome

**Implemented** on `ux/critique-pass` (uncommitted). Tests: 880 pass, 73 skip, 0 fail; core and UI typecheck clean.

**Deviations from the plan:**
- **Two new tests the plan marked manual.** `railFit` (BASED-UI-NARROW-LAYOUT) and the search display helpers (BASED-LANCE-SEARCH-SCORE) are pure and easy to get silently wrong, so both carry unit tests.
- **Rail layout is a small shared store** (`ui/src/railLayout.ts`) over a pure `railFit`, not an `App.tsx` ResizeObserver. Ctrl+J goes through the same `toggleCapi`, so a squeezed-shut Capi expands instead of closing.
- **Explorer collapse persists in localStorage** (like the rail widths), not in settings.
- **Middle truncation reuses the status bar's CSS approach** (`MiddleTruncate`: the folder part truncates, the file name stays). No `middleTruncate` string helper or test.
- **Score cells in the Cell viewer** show the 3-figure text; Copy and Export keep the full value.
- **No "wider FTS column" change.** Auto-fit already widens long text columns up to the 400px cap.
- **Capi's `get_tab`** now reads run errors from `queryErrors` (with statement/batch and line), because errors left Output.

**Found on the way:**
- **DuckDB binder carets are shifted** right by the statement's character offset in the script (parser carets are not). The bridge now subtracts `statementStarts(script)[i].offset`; an integration test pins line 4, column 3 for a binder error in statement 2.
- **History was empty for LanceDB** because a LanceDB connection has no database name and `history.database` is NOT NULL; the insert failed inside a swallowed `.catch`. Core now writes `""`. Integration test added (red first). The History panel also reloads shortly after any run finishes.

**Verified live** (dev core + vite, Playwright msedge, temp LanceDB fixture with FTS + vectors):
- `select 1 as a;` / `select bogus from plain;` / `select 3;` → "1 · 1 row", "Statement 2 failed" (selected), "1 skipped"; header "Stopped at statement 2 of 3"; squiggle under `bogus`; Output closed with no error line.
- Keyword search "refund late" → "Keyword ▾", `_score` 3 figures with bars, both words marked; Where example `id > 0`; `vector · vec[8]` header with values-only cells.
- Details on LanceDB → Name, Data Type, Nullable; index table without Metric.
- Widths: 1440 → 288/384; 1024 → 224/280 (work 520); 900 → explorer strip + Capi 344; expanding the explorer at 900 collapses Capi; hand-collapse persists at 1440. Browse toolbar is one row (44px) at all widths; ⋯ menu holds Fit columns, Copy, Copy as Markdown, Save as CSV, Open in Excel below 40rem.
- Settings: same dialog rect on all four sections; General selects 280px.
- History lists LanceDB runs.

**Regression caught by the re-critique and fixed:** the first middle-truncation cut the whole connection subtitle at its last slash, so the engine name became "Lance…" and a stray character showed before the folder. `MiddleTruncate` now takes `before` (engine, kept whole) and `after` (auth label, gives way last); `connSubtitle` is gone.

**Re-critique:** 29/40 (trend 24 → 25 → 27 → 28 → 29), below the ≥ 31 target. Snapshot `.impeccable/critique/2026-10-31T16-28-01Z__ui-src.md`. The pass-4 issues no longer appear as priorities; the new P1s are the editor/results split and unlabelled Embeddings clusters.

**Not verified live:** SQL Server batch labels ("Batch 2 failed") and Output auto-open for PRINT/notices (no SQL Server dev connection in this session); Output auto-open for "(n rows affected)" (the fixture connection is read-only).
