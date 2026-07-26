// Traces: BASED-GRID-COPY-MD
// Shared clipboard/export formatting for a glide-data-grid GridSelection, used by the SQL results
// grid, the Data tab grid, and the embeddings Selection grid so Copy behaves identically in all.
// The selection semantics live in computeSelectionSlice; TSV / markdown / raw-value forms are
// layered on top of the same slice.
import type { GridSelection, Item } from "@glideapps/glide-data-grid";
import { cellText, type WireValue } from "./api/types";

export interface SelectionSlice {
  /** Column indexes involved, in display order. */
  colIndexes: number[];
  /** Row indexes involved, or null meaning every row. */
  rowIndexes: number[] | null;
  /** Whether the tab-separated form includes a header row (column & whole-grid copies do). */
  header: boolean;
}

/** Row/column/range selection semantics, falling back to the whole grid (with a header row) when
 *  nothing is selected. */
export function computeSelectionSlice(selection: GridSelection | undefined, colCount: number): SelectionSlice {
  const allCols = Array.from({ length: colCount }, (_, i) => i);

  // Whole rows selected → every column of each selected row (no header, like a range copy).
  const selRows = selection?.rows;
  if (selRows && selRows.length > 0) return { colIndexes: allCols, rowIndexes: selRows.toArray(), header: false };

  // Whole columns selected → those columns (with their names) across every row.
  const selCols = selection?.columns;
  if (selCols && selCols.length > 0) return { colIndexes: selCols.toArray(), rowIndexes: null, header: true };

  // Cell range → the selected rectangle.
  const range = selection?.current?.range;
  if (range) {
    return {
      colIndexes: Array.from({ length: range.width }, (_, i) => range.x + i),
      rowIndexes: Array.from({ length: range.height }, (_, i) => range.y + i),
      header: false,
    };
  }

  // Nothing selected → the whole grid with a header row.
  return { colIndexes: allCols, rowIndexes: null, header: true };
}

const fmt = (v: WireValue) => (v === null ? "NULL" : typeof v === "object" ? cellText(v) : String(v));

const rowIndexesOf = (slice: SelectionSlice, rowCount: number): number[] =>
  slice.rowIndexes ?? Array.from({ length: rowCount }, (_, i) => i);

/** Raw values of the slice — feeds selection-scoped file export (/api/export columns + rows). */
export function sliceRows(
  slice: SelectionSlice,
  columns: { name: string }[],
  rows: WireValue[][],
): { columns: { name: string }[]; rows: WireValue[][] } {
  return {
    columns: slice.colIndexes.map((c) => ({ name: columns[c]?.name ?? "" })),
    rows: rowIndexesOf(slice, rows.length).map((r) => slice.colIndexes.map((c) => rows[r]?.[c] ?? null)),
  };
}

/** Tab-separated text of the slice — Excel-pasteable, header only when the slice carries one. */
export function selectionTsv(slice: SelectionSlice, columns: { name: string }[], rows: WireValue[][]): string {
  const lines: string[] = [];
  if (slice.header) lines.push(slice.colIndexes.map((c) => columns[c]?.name ?? "").join("\t"));
  for (const r of rowIndexesOf(slice, rows.length)) {
    lines.push(slice.colIndexes.map((c) => fmt(rows[r]?.[c] ?? null)).join("\t"));
  }
  return lines.join("\r\n");
}

/** Markdown table of the slice — always emits a header row (a markdown table requires one);
 *  pipes escaped, newlines become <br> so multi-line cells survive the table syntax. */
export function selectionMarkdown(slice: SelectionSlice, columns: { name: string }[], rows: WireValue[][]): string {
  const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\r\n|[\r\n]/g, "<br>");
  const line = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const out = [
    line(slice.colIndexes.map((c) => esc(columns[c]?.name ?? ""))),
    line(slice.colIndexes.map(() => "---")),
  ];
  for (const r of rowIndexesOf(slice, rows.length)) {
    out.push(line(slice.colIndexes.map((c) => esc(fmt(rows[r]?.[c] ?? null)))));
  }
  return out.join("\n");
}

/** The original Copy behavior: TSV of the selection slice. */
export function computeSelectionText(
  selection: GridSelection | undefined,
  columns: { name: string }[],
  rows: WireValue[][],
): string {
  return selectionTsv(computeSelectionSlice(selection, columns.length), columns, rows);
}

/** True when the cell lies inside the current selection (any range, selected row, or column). */
export function selectionContains(selection: GridSelection | undefined, [col, row]: Item): boolean {
  if (!selection) return false;
  if (selection.rows.hasIndex(row) || selection.columns.hasIndex(col)) return true;
  const cur = selection.current;
  if (!cur) return false;
  const inRange = (r: { x: number; y: number; width: number; height: number }) =>
    col >= r.x && col < r.x + r.width && row >= r.y && row < r.y + r.height;
  return inRange(cur.range) || cur.rangeStack.some(inRange);
}
