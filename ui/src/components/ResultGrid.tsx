import { useCallback, useMemo, useState } from "react";
import { GridCellKind, type GridCell, type GridSelection, type Item } from "@glideapps/glide-data-grid";
import type { ResultSetData } from "../store";
import { useStore } from "../store";
import { cellText } from "../api/types";
import { gridCellOverrides } from "../theme";
import { computeSelectionText } from "../gridSelectionText";
import { DataGrid, type DataGridColumnDef } from "./DataGrid";

const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)$/;

export function ResultGrid({
  rs,
  version,
  onSelectionData,
  onFitColumns,
}: {
  rs: ResultSetData;
  version: number;
  onSelectionData: (fn: () => string) => void;
  onFitColumns: (fn: () => void) => void;
}) {
  const [selection, setSelection] = useState<GridSelection | undefined>(undefined);
  const themeId = useStore((s) => s.theme);
  const nullText = useMemo(() => gridCellOverrides().nullText, [themeId]);

  const columns = useMemo<DataGridColumnDef[]>(() => rs.columns.map((c, i) => ({ id: String(i), title: c.name })), [rs.columns]);

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

  const selectionToText = useCallback(() => computeSelectionText(selection, rs.columns, rs.rows), [selection, rs]);

  onSelectionData(selectionToText);

  return (
    <DataGrid
      columns={columns}
      rowCount={rs.rows.length}
      getCellContent={getCellContent}
      dataVersion={version}
      gridSelection={selection}
      onGridSelectionChange={setSelection}
      rowMarkers="clickable-number"
      onFitColumns={onFitColumns}
    />
  );
}
