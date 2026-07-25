// Shared canvas grid: theme wiring, column resize + content-aware auto-fit. Used by both ResultGrid
// (SQL query results) and TableDataGrid (Data tab, mssql + LanceDB). Selection state and cell-value
// semantics (NULL/dirty/numeric formatting) stay with the caller — this component only owns grid chrome.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DataEditor,
  type DataEditorProps,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import { useStore } from "../store";
import { gridThemeFromCss } from "../theme";
import { computeAutoFitWidths, GRID_COL_MAX_WIDTH, GRID_COL_MIN_WIDTH } from "../gridAutoFit";

export interface DataGridColumnDef {
  id: string;
  title: string;
  /** Show Glide's header menu icon; clicks arrive via onHeaderMenuClick (BASED-GRID-FILTER). */
  hasMenu?: boolean;
}

/** Full display text for a cell, e.g. to show in the Cell viewer or feed into an activation handler. */
export function cellDisplayText(cell: GridCell): string {
  return "displayData" in cell && typeof cell.displayData === "string" ? cell.displayData : "";
}

const AUTOFIT_DEBOUNCE_MS = 200;

export function DataGrid({
  columns,
  rowCount,
  getCellContent,
  dataVersion,
  gridSelection,
  onGridSelectionChange,
  onCellEdited,
  rowMarkers = "clickable-number",
  rowSelectionMode,
  onFitColumns,
  onCellActivated,
  onHeaderClicked,
  onHeaderMenuClick,
}: {
  columns: DataGridColumnDef[];
  rowCount: number;
  getCellContent: (item: Item) => GridCell;
  /** Cache key for auto-fit recompute — bump/change whenever the underlying data changes
   *  (e.g. tab.version for streaming results, an edit-count composite for the Data tab). */
  dataVersion: string | number;
  gridSelection?: GridSelection;
  onGridSelectionChange?: (sel: GridSelection) => void;
  onCellEdited?: (item: Item, newValue: EditableGridCell) => void;
  rowMarkers?: DataEditorProps["rowMarkers"];
  rowSelectionMode?: DataEditorProps["rowSelectionMode"];
  /** Registration callback (same idiom as ResultGrid's onSelectionData): hands the caller a
   *  fit-to-content function to store and invoke from a toolbar button. */
  onFitColumns?: (fn: () => void) => void;
  /** Fires on double-click, Enter, or Space on a cell — used to open the Cell viewer tab. */
  onCellActivated?: (cell: Item) => void;
  /** Header click (sort cycling — BASED-GRID-SORT). */
  onHeaderClicked?: (colIndex: number) => void;
  /** Header menu-icon click with the header's screen bounds (filter popover — BASED-GRID-FILTER). */
  onHeaderMenuClick?: (colIndex: number, bounds: { x: number; y: number; width: number; height: number }) => void;
}) {
  const themeId = useStore((s) => s.theme);
  const gridTheme = useMemo(() => gridThemeFromCss(), [themeId]);

  const [manualWidths, setManualWidths] = useState<Record<string, number>>({});
  const [autoWidths, setAutoWidths] = useState<Record<string, number>>({});
  const manualWidthsRef = useRef<Record<string, number>>({});
  const prevSigRef = useRef<string | null>(null);

  const headerFont = `${gridTheme.headerFontStyle} ${gridTheme.fontFamily}`;
  const bodyFont = `${gridTheme.baseFontStyle} ${gridTheme.fontFamily}`;
  const horizontalPadding = gridTheme.cellHorizontalPadding ?? 8;

  const columnsSig = useMemo(() => columns.map((c) => c.id).join(""), [columns]);

  const recompute = useCallback(() => {
    const widths = computeAutoFitWidths(columns, rowCount, getCellContent, {
      headerFont,
      bodyFont,
      horizontalPadding,
      min: GRID_COL_MIN_WIDTH,
      max: GRID_COL_MAX_WIDTH,
      skipIds: new Set(Object.keys(manualWidthsRef.current)),
    });
    setAutoWidths((prev) => ({ ...prev, ...widths }));
  }, [columns, rowCount, getCellContent, headerFont, bodyFont, horizontalPadding]);

  const fitColumns = useCallback(() => {
    manualWidthsRef.current = {};
    setManualWidths({});
    setAutoWidths({});
    recompute();
  }, [recompute]);

  onFitColumns?.(fitColumns);

  // Recompute on a genuinely new column set (switching tables/result-tabs) immediately and clear
  // manual overrides; on a same-columns data change (streaming rows, an edit) debounce so bursts
  // coalesce. Deliberately decoupled from query "running/complete" state — treats streaming and
  // editing identically.
  useLayoutEffect(() => {
    const isNewColumnSet = columnsSig !== prevSigRef.current;
    prevSigRef.current = columnsSig;
    if (isNewColumnSet) {
      manualWidthsRef.current = {};
      setManualWidths({});
      setAutoWidths({});
      recompute();
      return;
    }
    const t = setTimeout(recompute, AUTOFIT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [columnsSig, dataVersion, recompute]);

  const gridColumns = useMemo<GridColumn[]>(
    () =>
      columns.map((c) => ({
        id: c.id,
        title: c.title,
        width: manualWidths[c.id] ?? autoWidths[c.id] ?? GRID_COL_MIN_WIDTH,
        hasMenu: c.hasMenu,
      })),
    [columns, manualWidths, autoWidths],
  );

  const handleColumnResize = useCallback(
    (_column: GridColumn, newSize: number, colIndex: number) => {
      const id = columns[colIndex]?.id;
      if (!id) return;
      manualWidthsRef.current = { ...manualWidthsRef.current, [id]: newSize };
      setManualWidths(manualWidthsRef.current);
    },
    [columns],
  );

  return (
    <div className="relative h-full w-full">
      <DataEditor
        columns={gridColumns}
        rows={rowCount}
        getCellContent={getCellContent}
        onCellEdited={onCellEdited}
        getCellsForSelection={true}
        rowMarkers={rowMarkers}
        rowSelectionMode={rowSelectionMode}
        smoothScrollX
        smoothScrollY
        width="100%"
        height="100%"
        theme={gridTheme}
        key={themeId}
        gridSelection={gridSelection}
        onGridSelectionChange={onGridSelectionChange}
        onColumnResize={handleColumnResize}
        onCellActivated={onCellActivated}
        onHeaderClicked={onHeaderClicked ? (colIndex) => onHeaderClicked(colIndex) : undefined}
        onHeaderMenuClick={onHeaderMenuClick ? (col, bounds) => onHeaderMenuClick(col, bounds) : undefined}
        minColumnWidth={GRID_COL_MIN_WIDTH}
      />
    </div>
  );
}
