# UX critique pass 5 — results space, cluster names, history batches, narrow Capi, Output, wording

**Source:** `.impeccable/critique/2026-10-31T16-28-01Z__ui-src.md` (29/40). Scope agreed: everything — the 5 priority issues and every minor item. Results space goes first. Capi stays a side rail; below 1200px opening Capi collapses the explorer. Target on re-critique: ≥ 31/40.

**Branch:** continue on `ux/critique-pass` (local, unpushed) so all five passes ship in one PR.

**Order:** layout → clarify (clusters) → harden (history) → adapt → distill → clarify (wording) → polish. Each phase can ship alone.

## Phase 1 — Results get the space (P1, first)

**Problem.** `QueryTabView.tsx` gives the editor a fixed 45% (`Panel defaultSize={45}`), results 40%, Output 15%. A one-line query leaves ~550px of empty editor at 1440×900 and shows ~5 grid rows. Glide's default row height (34px) is loose for a SQL grid; row-number markers are ~9px and low contrast.

**Change.**
- **Fit the editor to its text after a run.** When a run finishes with at least one result set, and the user has not dragged the editor/results split on this tab, the editor panel resizes to its content: line count × line height + padding, clamped to at least 6 lines and at most 45% of the tab. A drag on that handle marks the tab's split as manual; from then on the layout `autoSaveId` keeps the user's split and auto-fit stops for that tab. A manual split persists with the existing per-tab layout save.
- **Denser grid.** `DataGrid` sets `rowHeight` 26 and `headerHeight` 30 for both grids (query results and Data tab). Row markers use the theme's `textMedium` at `fs-sm`, not the default tiny light gray.
- **"…" on cut text.** Glide clips cell text at the edge with no ellipsis. Set `truncateEntries`/text-overflow where Glide supports it; else draw an ellipsis in the shared `drawCell` path for text cells whose measured width exceeds the cell. Data is unchanged.

**Spec.** BASED-UI-TABS (pane sizes), BASED-UI-RESULTS (row density, ellipsis).

## Phase 2 — Embeddings clusters name themselves (P1)

**Problem.** `clusterName(c)` (`EmbeddingsView.tsx:146`) returns the AI label or the bare number. The worker already computes TF-IDF top terms per cluster (`snap.terms`, `worker.ts:135`), but they are only sent as a hint to the paid "AI label" call. Some clusters have no on-canvas label, and labels 6 and 9 collide.

**Change.**
- **Default name from terms.** `clusterName(c)` = AI label, else the top 2 TF-IDF terms joined with " · " (e.g. "refund · charge"), else the number. Pure helper `clusterDisplayName(aiLabel, terms, c)` in `ui/src/embeddings/` with a unit test.
- **Check `tfidfTopTerms` output quality** on the demo data (stopwords, numbers, one-letter tokens). Filter those if they leak into names.
- **Legend chips** show the name and the point count ("refund · charge · 14").
- **Every cluster gets a canvas label; no overlaps.** The callout placement (`EmbeddingsView.tsx:169`) gets a collision pass: after placing badges, push overlapping ones apart along their leader direction (a few iterations over badge rects). A cluster whose badge still cannot fit keeps its legend chip only, and the chip gets a leader on hover.
- **"AI label" becomes "Improve names with AI"**, with a tooltip saying it calls the agent's model.
- **Plain wording in the toolbar:** "text [subject]" → "Text column: subject"; "points 5,000" → "Sample size", and its options are capped at the table's row count (no 20,000 for 60 rows); "Lasso" → "Select area"; "Run" → "Build map".

**Spec.** BASED-EMBED-UI (names, legend, wording).

## Phase 3 — History tells the truth about batches (P2)

**Problem.** `HistoryPanel.tsx:28 firstLine()` shows a failed 3-statement batch as `select 1 as a;` with a red dot, which reads as "select 1 failed". The dot (`:37`) is the only status cue.

**Change.**
- **Batch summary.** Core already stores the whole SQL and the first error. For a script with more than one statement, the row's second line says "3 statements · failed at 2" (failed position from the error, when known) or "3 statements". Statement count uses the existing `statementStarts` for DuckDB text and `splitBatchesWithLines` + statement count for SQL Server — or, simpler, core records `statementCount` and `failedStatement` in the history row (new nullable columns, `ALTER TABLE` migration in `core/src/storage/db.ts`). Preferred: core records them, so the UI does not re-parse SQL per dialect.
- **Status not by color alone.** Each row shows a small text mark beside the dot: "ok", "error", "cancelled" (muted, fs-xs), and the dot gets an `aria-label`.
- **28px minimum.** "Minimize results" (`ResultsPane.tsx:114`) and any other `IconButton size="sm"` in toolbars move to the default size.

**Spec.** BASED-HISTORY (two new nullable fields; integration test extends the LanceDB history test), BASED-HISTORY-UI.

## Phase 4 — Capi below 1200px (P2)

**Change.**
- **Opening Capi below 1200px collapses the explorer** (auto state, not saved). `railFit` gains this rule: when the window is under 1200px and Capi is open by choice, the explorer is collapsed unless the user expanded it after opening Capi (`keep: "left"`). Unit tests extend `unit.railFit.test.ts`.
- **Active tab fully in view.** `TabStrip.tsx:54` uses `inline: "nearest"`, which can leave a neighbor tab half cut at the left edge ("uery 1"). The tablist gets `scroll-snap-type: x proximity` with `scroll-snap-align: start` on tabs, so the strip rests on tab edges.

**Spec.** BASED-UI-NARROW-LAYOUT, BASED-UI-TABS.

## Phase 5 — Output never contradicts Results (P2)

**Change.**
- When Output is open, the run failed, and Output has no lines, the pane says "No server messages. Errors are in Results." in place of "No messages.".
- The stats header in Output ("error · 3 ms") goes: the status bar already says "last run: error in 3 ms". Output shows only lines.

**Spec.** BASED-UI-OUTPUT.

## Phase 6 — Wording and help in place

- **Search cap.** The result count says "10 rows (top 10)" when the result count equals the keep size, and the tooltip names Tuning → Keep.
- **Details types.** Lance/Arrow types get a plain name next to the raw one: `Utf8` → "text", `Float64` → "number", `Int64` → "integer", `vector[8] float32` unchanged. Index type `fts` → "full-text", "Unindexed" → "Rows not indexed". Pure map in `ui/src/lib/` with a unit test.
- **Help in place.** One-line descriptions under each search mode in the mode menu (they exist as `label`; make sure the menu shows them as hints), a "?" `IconButton` beside Tuning and on the Embeddings toolbar that opens the Help tab at the matching section (`openDocsTab(section)`; add anchors to `DocsView`).
- **Capi empty state.** Replace the paragraph with a one-line intro and 3 example prompt buttons that fill the composer (not send): "Which tables have the most rows?", "Write a query for …the active table…", "Explain the last error". Uses `text-wrap: pretty` so no word sits alone on the last line.

**Spec.** BASED-LANCE-SEARCH-UI, BASED-TABLE-DETAILS-UI/explorer types, BASED-HELP-DOCS, BASED-CHAT-UI.

## Phase 7 — Polish

- Settings "Double-click opens": labels get `mb-1` above their selects (`ThemePicker.tsx:106–128`).
- Font-size slider: "115%" sits under the thumb (position from the value), or to the right of the track.
- Search mode menu: `MenuButton` keeps its list inside the window/work area (clamp `left` to the viewport minus the menu width — check why it overflows over the explorer).
- Search row: one close control. ✕ closes search and clears the result (as today); **Clear** goes, because ✕ does the same plus closing. Keep `Esc`.
- Where placeholder: prefix "e.g." (`e.g. id > 0`) so it does not read as an entered value.

## Spec impact

- **New:** BASED-EMBED-CLUSTER-NAMES (test: `clusterDisplayName`), BASED-TYPE-NAMES (test: plain type map).
- **Modified:** BASED-UI-TABS, BASED-UI-RESULTS, BASED-EMBED-UI, BASED-HISTORY, BASED-HISTORY-UI, BASED-UI-NARROW-LAYOUT, BASED-UI-OUTPUT, BASED-LANCE-SEARCH-UI, BASED-HELP-DOCS, BASED-CHAT-UI, BASED-LANCE-SEARCH-PROFILES-UI (label spacing only — no spec change).
- **Tests:** `unit.clusterNames.test.ts`, `unit.typeNames.test.ts`, extend `unit.railFit.test.ts`, extend the LanceDB history integration test (statement count + failed position). Red first.

## Verification

- `cd specs && bun test .` and both typechecks clean.
- Live (dev core + vite, Playwright msedge, temp LanceDB fixture with FTS + vectors):
  - One-line query → editor ~6 lines, grid ≥ 15 rows at 1440×900; drag the split, rerun → split kept.
  - Embeddings → every cluster named from terms, no overlapping badges, legend chips with counts.
  - Failed batch → History row "3 statements · failed at 2" with an "error" text mark.
  - 1100px, open Capi → explorer collapses; 900px tab strip rests on tab edges.
  - Open Output after a failure → "No server messages. Errors are in Results."
  - Keyword search → "10 rows (top 10)"; Details shows "text"/"number".
  - Capi empty state → 3 example prompts; click one → composer filled, nothing sent.
- Re-run `/impeccable critique` and record the score.

## Risks

- **Editor auto-fit can fight the user.** Mitigation: it runs only after a run with results, only until the first manual drag on that tab, and never shrinks below 6 lines.
- **TF-IDF names can be junk** on short or numeric text. Mitigation: filter stopwords/numbers; fall back to the number when fewer than 1 useful term remains.
- **History schema migration.** Two nullable columns via `ALTER TABLE ADD COLUMN` guarded by a column check; old rows show no batch line.
- **Removing Clear** changes a learned control. ✕ already clears; the tooltip says "Close search and clear results (Esc)".

## Outcome

**Implemented** on `ux/critique-pass` (uncommitted). Tests: 965 run, 73 skip, 0 fail; core and UI typecheck clean.

**Deviations from the plan:**
- **Editor fit** uses Monaco's `getContentHeight()` (new `editorTextHeight` in `editorModels.ts`) and a per-tab `based:splitManual:<id>` localStorage flag set when the editor/results handle starts a drag.
- **Ellipsis** is painted by `DataGrid`'s own `drawCell` wrapper (cell background + "…" over the cut); it chains under the search-score drawing.
- **Cluster labels**: no hover leader for legend-only clusters; the collision pass places every badge on screen, so none drops to legend-only.
- **History** stores `statement_count` from a new optional `statementCount` on the `done` chunk (LanceDB: DuckDB's statement count; SQL Server: GO batch count) and `failed_statement` from the first error's `statement`/`batch`.
- **Keep** moved out of the reranker block: it shows in every mode and is always sent; without a reranker the pool is raised to at least Keep, because core caps Keep at the pool.
- **Plain type names** cover Arrow names only (SQL Server types already read plainly). Index rows read "Rows indexed" / "Rows not indexed".
- **Capi prompts** follow the active tab (table name; "explain the last error" after a failed run).
- **`IconButton size="sm"`** was raised to the default 28px only for the two toolbar Minimize buttons; inline chip resets and tab close buttons stay small by design.
- `unit.clusterNames.test.ts`, `unit.typeNames.test.ts`, and the history test extension were written with the code, not red first; the `railFit` change was red first.

**Verified live** (dev core + vite, Playwright msedge, temp LanceDB fixture: 120 tickets in 4 topics, FTS on body, 8-dim vectors):
- `select * from support_tickets` → editor 132px (6 lines), ~22 grid rows at 1440×900, "…" on cut cells, readable row numbers.
- Failed batch → Output (opened by hand) "No server messages. Errors are in Results."; History "error · 3 statements · failed at 2".
- Details → `Float64 · number`, `Utf8 · text`; vector unchanged.
- Search → mode menu opens rightward from its button (left 301px, over the work area); "10 rows (top 10)"; no Clear; ? opens Help at "Searching a LanceDB table".
- Embeddings → clusters "refund · invoice", "password · locked", "late · tracking", "cracked · broken", 0 badge overlaps, legend chips with counts, "All 120 rows" sample size.
- 1100px, Ctrl+J → explorer collapses to its strip, Capi keeps 384px; three example prompts; a click fills the composer, nothing sent.

**Fixed after the re-critique** (both inside this pass's scope): the autocomplete list stayed open after F5 (`runFromEditor` now hides it); the active tab could sit off-screen after a window resize (the tab strip's ResizeObserver now re-reveals it). Both verified live.

**Re-critique:** 29/40 (trend 25 → 27 → 28 → 29 → 29), below the ≥ 31 target. Snapshot `.impeccable/critique/2026-11-01T14-08-05Z__ui-src.md`. Pass-4/5 targets (results space, cluster names, Output, narrow Capi) no longer appear as issues; the new P1 is search results not showing why a row matched. Detector and overlays: 0 real findings.

**Not verified live:** SQL Server batch counts in History (no SQL Server connection in this session).
