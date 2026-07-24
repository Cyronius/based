// Shared canvas grid: theme wiring, column resize + content-aware auto-fit, and a hover tooltip for
// cells whose text is cut off by their column width. Used by both ResultGrid (SQL query results) and
// TableDataGrid (Data tab, mssql + LanceDB). Selection state and cell-value semantics (NULL/dirty/
// numeric formatting) stay with the caller — this component only owns grid chrome.
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  DataEditor,
  measureTextCached,
  type DataEditorProps,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridMouseEventArgs,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import { useStore } from "../store";
import { gridThemeFromCss } from "../theme";
import { computeAutoFitWidths, GRID_COL_MAX_WIDTH, GRID_COL_MIN_WIDTH, measureCtx } from "../gridAutoFit";

export interface DataGridColumnDef {
  id: string;
  title: string;
}

interface HoverTooltip {
  x: number;
  y: number;
  text: string;
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
}) {
  const themeId = useStore((s) => s.theme);
  const gridTheme = useMemo(() => gridThemeFromCss(), [themeId]);

  const [manualWidths, setManualWidths] = useState<Record<string, number>>({});
  const [autoWidths, setAutoWidths] = useState<Record<string, number>>({});
  const [hover, setHover] = useState<HoverTooltip | null>(null);
  const hoverKeyRef = useRef<string | null>(null);
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
    () => columns.map((c) => ({ id: c.id, title: c.title, width: manualWidths[c.id] ?? autoWidths[c.id] ?? GRID_COL_MIN_WIDTH })),
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

  const clearHover = useCallback(() => {
    if (hoverKeyRef.current === null) return;
    hoverKeyRef.current = null;
    setHover(null);
  }, []);

  const handleMouseMove = useCallback(
    (args: GridMouseEventArgs) => {
      if (args.kind !== "cell") {
        clearHover();
        return;
      }
      const [col, row] = args.location;
      const key = `${col}:${row}`;
      if (hoverKeyRef.current === key) return;
      hoverKeyRef.current = key;
      const cell = getCellContent([col, row]);
      const text = "displayData" in cell && typeof cell.displayData === "string" ? cell.displayData : "";
      if (!text) {
        setHover(null);
        return;
      }
      const available = args.bounds.width - horizontalPadding * 2;
      const measured = measureTextCached(text, measureCtx(), bodyFont).width;
      if (measured <= available) {
        setHover(null);
        return;
      }
      // args.bounds is viewport-relative (canvas.getBoundingClientRect()-based) — matches
      // position:fixed's coordinate space directly, no wrapper-rect math needed.
      setHover({ x: args.bounds.x, y: args.bounds.y + args.bounds.height + 4, text });
    },
    [getCellContent, bodyFont, horizontalPadding, clearHover],
  );

  return (
    <div className="relative h-full w-full" onMouseLeave={clearHover}>
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
        onMouseMove={handleMouseMove}
        onVisibleRegionChanged={clearHover}
        minColumnWidth={GRID_COL_MIN_WIDTH}
      />
      {hover && (
        <div
          className="fixed z-50 pointer-events-none max-w-md px-2 py-1 rounded border border-line bg-ink-950 text-paper text-[length:var(--fs-sm)] font-mono shadow-lg shadow-black/40 whitespace-pre-wrap break-words"
          style={{ left: hover.x, top: hover.y }}
        >
          {hover.text}
        </div>
      )}
    </div>
  );
}
