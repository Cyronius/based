# Grid export standardization: shared actions, markdown copy, context menu

## Context

The embeddings Selection grid (lasso results) lacks the export toolbar the SQL results and Data
grids share (`GridToolbarActions`: Fit columns / Copy / CSV / Excel). Export actions should be a
standard on every grid. We also want a "copy as markdown table" action, and a right-click context
menu on cells/selections exposing the same shared actions. Bonus fix: the CSV/Excel icon buttons in
the toolbar render at a different height than the text buttons beside them.

User decisions (2026-07-25):
- Context menu = the same shared action set the toolbars use: Copy, Copy as Markdown, Save as CSV,
  Open in Excel. Menu file-exports scope to the selection when one exists, else the whole view.
- Copy as Markdown lives in both the toolbar and the context menu.
- Header right-click opens the existing sort/filter column menu (`GridColumnMenu`).

## Spec impact

New requirements in `spec.md`:
- **BASED-GRID-EXPORT-STANDARD** (manual) — every data grid (SQL results, Data tab, embeddings
  Selection) exposes the standard toolbar action set.
- **BASED-GRID-COPY-MD** (unit) — markdown-table clipboard formatting semantics.
- **BASED-GRID-CONTEXT-MENU** (manual) — right-click cell/selection menu with the shared actions;
  right-click outside the selection selects the clicked cell; header right-click opens the column menu.

## Implementation

1. `ui/src/gridSelectionText.ts` — extract the selection semantics into
   `computeSelectionSlice(selection, rowCount, colCount) → { colIndexes, rowIndexes|null, header }`
   (rows → all cols no header; columns → those cols with header; range → rect no header;
   nothing → whole grid with header). Layer formatters on top: `selectionTsv` (keeps existing
   `computeSelectionText` behavior byte-for-byte), new `selectionMarkdown` (always emits a header
   row from the involved column names; escapes `|`, converts newlines to `<br>`, NULL renders as
   `NULL`), `sliceRows` (raw `WireValue[][]` for selection-scoped file export), and
   `selectionContains(sel, cell)`.
2. `specs/based/tests/unit.gridSelectionText.test.ts` — failing-first unit tests for slice + TSV
   parity + markdown (Traces: BASED-GRID-COPY-MD).
3. `ui/src/components/GridToolbarActions.tsx` — extract `useGridExportActions({columns, getRows,
   getSelection})` hook returning `{ notice, copy, copyMarkdown, exportFile(format, {openAfter,
   scope}) }`. Toolbar renders from the hook (adds a Copy-MD icon button; CSV/Excel keep whole-view
   scope). Fix button heights: text + icon buttons share one explicit height.
4. `ui/src/components/GridContextMenu.tsx` (new, patterned on `TabContextMenu`) — popover listing
   the four shared actions from the same hook instance; file exports use selection scope.
5. `ui/src/components/DataGrid.tsx` — wire glide's `onCellContextMenu` / `onHeaderContextMenu`
   (preventDefault; screen pos = `bounds.x + localEventX`).
6. `ui/src/components/ResultGrid.tsx` — on cell right-click: if the cell is outside the current
   selection, select it (single-cell `GridSelection`), then bubble `{x,y}` up via new
   `onCellContextMenu` prop. Registration `onSelectionData` now also exposes the raw slice for
   markdown/export (hosts own the hook). Header right-click → same handler as the menu icon.
7. Hosts create ONE `useGridExportActions` instance each and render both `GridToolbarActions` and
   `GridContextMenu` from it:
   - `ui/src/components/ResultsPane.tsx` (SQL results)
   - `ui/src/components/TableDataGrid.tsx` (Data tab; header right-click respects the existing
     pending-edits gate)
   - `ui/src/components/embeddings/SelectionGrid.tsx` (gains a slim toolbar row above the grid —
     this is the standardization ask)
8. Spec: add the three requirements; append manual verification procedures to
   `specs/based/tests/manual.ui.test.ts`; archive this plan.

## Verification

- `bun test` (or vitest) over `specs/based/tests/unit.gridSelectionText.test.ts` — markdown/TSV
  semantics.
- `tsc`/build for ui.
- Manual: lasso a selection in the embeddings view → Selection tab shows toolbar; Copy MD produces
  a pasteable markdown table; right-click a cell in all three grids → menu; right-click outside
  selection moves it; header right-click opens sort/filter menu; toolbar buttons equal height.
