import { useCallback, useMemo, useState } from "react";
import {
  DataEditor,
  GridCellKind,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type Theme,
} from "@glideapps/glide-data-grid";
import type { ResultSetData } from "../store";
import { cellText } from "../api/types";

const ledgerGridTheme: Partial<Theme> = {
  accentColor: "#d2a24c",
  accentLight: "#d2a24c22",
  bgCell: "#15181d",
  bgCellMedium: "#1a1e24",
  bgHeader: "#1a1e24",
  bgHeaderHasFocus: "#20252c",
  bgHeaderHovered: "#20252c",
  textDark: "#e9e6de",
  textMedium: "#8d929c",
  textLight: "#5a606a",
  textHeader: "#8d929c",
  borderColor: "#272d36",
  horizontalBorderColor: "#1f242c",
  drilldownBorder: "#272d36",
  linkColor: "#7fa8c9",
  cellHorizontalPadding: 8,
  cellVerticalPadding: 3,
  headerFontStyle: "600 11px",
  baseFontStyle: "12px",
  fontFamily: "IBM Plex Mono, monospace",
};

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
          themeOverride: { textDark: "#5a606a", baseFontStyle: "italic 12px" },
        };
      }
      if (typeof v === "number" && NUMERIC_TYPES.test(rs.columns[col]?.type ?? "")) {
        return { kind: GridCellKind.Number, data: v, displayData: String(v), allowOverlay: false, contentAlign: "right" };
      }
      const text = typeof v === "object" ? cellText(v) : String(v);
      return { kind: GridCellKind.Text, data: text, displayData: text, allowOverlay: false };
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rs, version],
  );

  const selectionToText = useCallback(() => {
    const range = selection?.current?.range;
    const tsvRow = (r: number, x0: number, x1: number) =>
      rs.rows[r]!.slice(x0, x1)
        .map((v) => (v === null ? "NULL" : typeof v === "object" ? cellText(v) : String(v)))
        .join("\t");
    if (range) {
      const lines: string[] = [];
      for (let r = range.y; r < range.y + range.height; r++) lines.push(tsvRow(r, range.x, range.x + range.width));
      return lines.join("\r\n");
    }
    const header = rs.columns.map((c) => c.name).join("\t");
    return [header, ...rs.rows.map((_, r) => tsvRow(r, 0, rs.columns.length))].join("\r\n");
  }, [selection, rs]);

  onSelectionData(selectionToText);

  return (
    <DataEditor
      columns={columns}
      rows={rs.rows.length}
      getCellContent={getCellContent}
      getCellsForSelection={true}
      rowMarkers="number"
      smoothScrollX
      smoothScrollY
      width="100%"
      height="100%"
      theme={ledgerGridTheme}
      gridSelection={selection}
      onGridSelectionChange={setSelection}
      onColumnResize={(_c, newSize, colIndex) => setWidths((w) => ({ ...w, [colIndex]: newSize }))}
    />
  );
}
