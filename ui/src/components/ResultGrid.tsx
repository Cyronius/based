import { useCallback, useMemo, useState } from "react";
import {
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import type { ResultSetData } from "../store";
import { useStore } from "../store";
import { cellText, type WireValue } from "../api/types";
import { gridThemeFromCss, gridCellOverrides } from "../theme";

const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)$/;

export function ResultGrid({
  rs,
  version,
  onSelectionData,
}: {
  rs: ResultSetData;
  version: number;
  onSelectionData: (fn: () => string) => void;
}) {
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [selection, setSelection] = useState<GridSelection | undefined>(undefined);
  const themeId = useStore((s) => s.theme);
  const gridTheme = useMemo(() => gridThemeFromCss(), [themeId]);
  const nullText = useMemo(() => gridCellOverrides().nullText, [themeId]);

  const columns = useMemo<GridColumn[]>(
    () =>
      rs.columns.map((c, i) => ({
        title: c.name,
        id: String(i),
        width: widths[i] ?? Math.min(320, Math.max(72, c.name.length * 9 + 40)),
      })),
    [rs.columns, widths],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = rs.rows[row]?.[col];
      if (v === null || v === undefined) {
        return {
          kind: GridCellKind.Text,
          data: "",
          displayData: "NULL",
          allowOverlay: false,
          themeOverride: { textDark: nullText, baseFontStyle: "italic 12px" },
        };
      }
      if (typeof v === "number" && NUMERIC_TYPES.test(rs.columns[col]?.type ?? "")) {
        return { kind: GridCellKind.Number, data: v, displayData: String(v), allowOverlay: false, contentAlign: "right" };
      }
      const text = typeof v === "object" ? cellText(v) : String(v);
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rs, version, nullText],
  );

  const selectionToText = useCallback(() => {
    const fmt = (v: WireValue) => (v === null ? "NULL" : typeof v === "object" ? cellText(v) : String(v));
    const rowText = (r: number, cols: number[]) => cols.map((c) => fmt(rs.rows[r]?.[c] ?? null)).join("\t");
    const allCols = rs.columns.map((_, i) => i);

    // Whole rows selected → every column of each selected row (no header, like a range copy).
    const rows = selection?.rows;
    if (rows && rows.length > 0) return rows.toArray().map((r) => rowText(r, allCols)).join("\r\n");

    // Whole columns selected → those columns (with their names) across every row.
    const cols = selection?.columns;
    if (cols && cols.length > 0) {
      const idx = cols.toArray();
      const header = idx.map((c) => rs.columns[c]!.name).join("\t");
      return [header, ...rs.rows.map((_, r) => rowText(r, idx))].join("\r\n");
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
    const header = rs.columns.map((c) => c.name).join("\t");
    return [header, ...rs.rows.map((_, r) => rowText(r, allCols))].join("\r\n");
  }, [selection, rs]);

  onSelectionData(selectionToText);

  return (
    <DataEditor
      columns={columns}
      rows={rs.rows.length}
      getCellContent={getCellContent}
      getCellsForSelection={true}
      rowMarkers="clickable-number"
      smoothScrollX
      smoothScrollY
      width="100%"
      height="100%"
      theme={gridTheme}
      key={themeId}
      gridSelection={selection}
      onGridSelectionChange={setSelection}
      onColumnResize={(_c, newSize, colIndex) => setWidths((w) => ({ ...w, [colIndex]: newSize }))}
    />
  );
}
