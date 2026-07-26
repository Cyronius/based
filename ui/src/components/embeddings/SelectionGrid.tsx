// Traces: BASED-EMBED-UI, BASED-GRID-EXPORT-STANDARD
// Lasso-selection results as a real grid: synthesizes a ResultSetData from the vector sample's
// non-vector cells and renders the existing ResultGrid (sort/filter/copy come free), topped with
// the standard grid toolbar (Fit / Copy / Markdown / CSV / Excel) and right-click context menu so
// the Selection grid exports like every other grid.
import { useMemo, useRef, useState } from "react";
import type { VectorSampleHeader } from "../../api/types";
import type { ResultSetData } from "../../store";
import { computeSelectionSlice, type SelectionSlice } from "../../gridSelectionText";
import { ResultGrid } from "../ResultGrid";
import { GridContextMenu } from "../GridContextMenu";
import { GridToolbarActions, useGridExportActions } from "../GridToolbarActions";

export function SelectionGrid({
  header,
  indices,
  onCellTextChange,
  onCellActivate,
}: {
  header: VectorSampleHeader;
  indices: number[];
  /** Fires on every selection change with the selected cell's full text (or null if none selected). */
  onCellTextChange?: (text: string | null) => void;
  /** Fires on double-click/Enter/Space on a cell, with its full text — re-expands the Cell pane. */
  onCellActivate?: (text: string) => void;
}) {
  const rs = useMemo<ResultSetData>(
    () => ({
      columns: header.columns.map((c) => ({ name: c.name, type: c.type })),
      rows: indices.map((i) => header.rows[i] ?? []),
      rowCount: indices.length,
      truncated: false,
      complete: true,
    }),
    [header, indices],
  );

  const selectionSliceRef = useRef<(() => SelectionSlice) | null>(null);
  const viewRowsRef = useRef<(() => ResultSetData["rows"]) | null>(null);
  const fitColumnsRef = useRef<() => void>(() => {});
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  // One shared action set feeds both the toolbar buttons and the right-click context menu.
  const exportActions = useGridExportActions({
    columns: rs.columns,
    getRows: () => viewRowsRef.current?.() ?? rs.rows,
    getSlice: () => selectionSliceRef.current?.() ?? computeSelectionSlice(undefined, rs.columns.length),
  });

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-line-soft shrink-0">
        <span className="text-[length:var(--fs-sm)] text-muted font-mono">{rs.rowCount.toLocaleString()} rows</span>
        <div className="flex-1" />
        <GridToolbarActions actions={exportActions} onFitColumns={() => fitColumnsRef.current()} />
      </div>
      <div className="flex-1 min-h-0">
        <ResultGrid
          rs={rs}
          version={indices.length}
          onSelectionSlice={(fn) => {
            selectionSliceRef.current = fn;
          }}
          onViewRows={(fn) => {
            viewRowsRef.current = fn;
          }}
          onFitColumns={(fn) => {
            fitColumnsRef.current = fn;
          }}
          onCellTextChange={onCellTextChange}
          onCellActivate={onCellActivate}
          onCellContextMenu={setCtxMenu}
        />
      </div>
      {ctxMenu && <GridContextMenu x={ctxMenu.x} y={ctxMenu.y} actions={exportActions} onClose={() => setCtxMenu(null)} />}
    </div>
  );
}
