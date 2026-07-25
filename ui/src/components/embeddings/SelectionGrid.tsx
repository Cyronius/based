// Traces: BASED-EMBED-UI
// Lasso-selection results as a real grid: synthesizes a ResultSetData from the vector sample's
// non-vector cells and renders the existing ResultGrid (sort/filter/copy come free).
import { useMemo } from "react";
import type { VectorSampleHeader } from "../../api/types";
import type { ResultSetData } from "../../store";
import { ResultGrid } from "../ResultGrid";

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
  return (
    <ResultGrid
      rs={rs}
      version={indices.length}
      onSelectionData={() => {}}
      onFitColumns={() => {}}
      onCellTextChange={onCellTextChange}
      onCellActivate={onCellActivate}
    />
  );
}
