// Shared clipboard-text formatting for a glide-data-grid GridSelection, used by both the SQL
// results grid and the Data tab grid so Copy behaves identically in both.
import type { GridSelection } from "@glideapps/glide-data-grid";
import { cellText, type WireValue } from "./api/types";

/** Row/column/range copy semantics, falling back to the whole grid (with a header row) when
 *  nothing is selected. */
export function computeSelectionText(
  selection: GridSelection | undefined,
  columns: { name: string }[],
  rows: WireValue[][],
): string {
  const fmt = (v: WireValue) => (v === null ? "NULL" : typeof v === "object" ? cellText(v) : String(v));
  const rowText = (r: number, cols: number[]) => cols.map((c) => fmt(rows[r]?.[c] ?? null)).join("\t");
  const allCols = columns.map((_, i) => i);

  // Whole rows selected → every column of each selected row (no header, like a range copy).
  const selRows = selection?.rows;
  if (selRows && selRows.length > 0) return selRows.toArray().map((r) => rowText(r, allCols)).join("\r\n");

  // Whole columns selected → those columns (with their names) across every row.
  const selCols = selection?.columns;
  if (selCols && selCols.length > 0) {
    const idx = selCols.toArray();
    const header = idx.map((c) => columns[c]!.name).join("\t");
    return [header, ...rows.map((_, r) => rowText(r, idx))].join("\r\n");
  }

  // Cell range → the selected rectangle.
  const range = selection?.current?.range;
  if (range) {
    const rangeCols = Array.from({ length: range.width }, (_, i) => range.x + i);
    const lines: string[] = [];
    for (let r = range.y; r < range.y + range.height; r++) lines.push(rowText(r, rangeCols));
    return lines.join("\r\n");
  }

  // Nothing selected → the whole result set with a header row.
  const header = columns.map((c) => c.name).join("\t");
  return [header, ...rows.map((_, r) => rowText(r, allCols))].join("\r\n");
}
