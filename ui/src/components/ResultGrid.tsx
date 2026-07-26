// Traces: BASED-UI-RESULTS, BASED-GRID-SORT, BASED-GRID-FILTER, BASED-GRID-CONTEXT-MENU
import { useCallback, useMemo, useState } from "react";
import { CompactSelection, GridCellKind, type GridCell, type GridSelection, type Item } from "@glideapps/glide-data-grid";
import type { ResultSetData } from "../store";
import { useStore } from "../store";
import { cellText } from "../api/types";
import { gridCellOverrides } from "../theme";
import { computeSelectionSlice, selectionContains, type SelectionSlice } from "../gridSelectionText";
import { computeViewIndex, NUMERIC_TYPES, type ColumnFilters, type SortState } from "../gridView";
import { cellDisplayText, DataGrid, type DataGridColumnDef } from "./DataGrid";
import { GridColumnMenu } from "./GridColumnMenu";

export function ResultGrid({
  rs,
  version,
  onSelectionSlice,
  onViewRows,
  onFitColumns,
  onCellTextChange,
  onCellActivate,
  onCellContextMenu,
}: {
  rs: ResultSetData;
  version: number;
  /** Registration callback: hands the caller a getter for the current selection slice, feeding the
   *  shared copy/markdown/export actions (view-row indexed — pair with onViewRows). */
  onSelectionSlice?: (fn: () => SelectionSlice) => void;
  /** Registration callback: hands the caller a getter for the current sorted/filtered rows so
   *  copy/CSV/Excel export are WYSIWYG (BASED-GRID-SORT). */
  onViewRows?: (fn: () => typeof rs.rows) => void;
  onFitColumns: (fn: () => void) => void;
  /** Fires on every selection change with the selected cell's full text (or null if none selected). */
  onCellTextChange?: (text: string | null) => void;
  /** Fires on double-click/Enter/Space on a cell, with its full text — opens the Cell viewer tab. */
  onCellActivate?: (text: string) => void;
  /** Fires on cell right-click (after moving the selection to the cell when it was outside) with
   *  the mouse's screen position — the host renders the shared GridContextMenu there. */
  onCellContextMenu?: (pos: { x: number; y: number }) => void;
}) {
  const [selection, setSelection] = useState<GridSelection | undefined>(undefined);
  const [sort, setSort] = useState<SortState>(null);
  const [filters, setFilters] = useState<ColumnFilters>({});
  const [menu, setMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const themeId = useStore((s) => s.theme);
  const nullText = useMemo(() => gridCellOverrides().nullText, [themeId]);

  // The derived view: original row indices after filter + stable sort; null = identity.
  const viewIndex = useMemo(
    () => computeViewIndex(rs.rows, rs.columns, sort, filters),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rs, version, sort, filters],
  );
  const viewRows = useMemo(
    () => (viewIndex ? viewIndex.map((i) => rs.rows[i]!) : rs.rows),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rs, version, viewIndex],
  );
  const filtersActive = Object.values(filters).some((f) => f.trim() !== "");

  const columns = useMemo<DataGridColumnDef[]>(
    () =>
      rs.columns.map((c, i) => {
        const arrow = sort?.col === i ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
        const mark = (filters[i] ?? "").trim() ? " •" : "";
        return { id: String(i), title: `${c.name}${mark}${arrow}`, hasMenu: true };
      }),
    [rs.columns, sort, filters],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const v = viewRows[row]?.[col];
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
    [rs, version, viewRows, nullText],
  );

  const selectionToSlice = useCallback(() => computeSelectionSlice(selection, rs.columns.length), [selection, rs]);

  onSelectionSlice?.(selectionToSlice);
  onViewRows?.(() => viewRows);

  const handleSelectionChange = useCallback(
    (sel: GridSelection) => {
      setSelection(sel);
      const cell = sel.current?.cell;
      onCellTextChange?.(cell ? cellDisplayText(getCellContent(cell)) : null);
    },
    [getCellContent, onCellTextChange],
  );

  // Right-click outside the current selection first selects the clicked cell (standard behavior),
  // then bubbles the screen position up for the host's context menu.
  const handleCellContextMenu = useCallback(
    (cell: Item, pos: { x: number; y: number }) => {
      if (!selectionContains(selection, cell)) {
        handleSelectionChange({
          current: { cell, range: { x: cell[0], y: cell[1], width: 1, height: 1 }, rangeStack: [] },
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
        });
      }
      onCellContextMenu?.(pos);
    },
    [selection, handleSelectionChange, onCellContextMenu],
  );

  const handleCellActivated = useCallback(
    (cell: Item) => onCellActivate?.(cellDisplayText(getCellContent(cell))),
    [getCellContent, onCellActivate],
  );

  // Header click cycles this column asc → desc → none (BASED-GRID-SORT).
  const handleHeaderClicked = useCallback(
    (col: number) => {
      setSort((prev) => {
        if (prev?.col !== col) return { col, dir: "asc" };
        return prev.dir === "asc" ? { col, dir: "desc" } : null;
      });
      setSelection(undefined);
    },
    [],
  );

  const handleHeaderMenuClick = useCallback((col: number, bounds: { x: number; y: number; height: number }) => {
    setMenu({ col, x: bounds.x, y: bounds.y + bounds.height });
  }, []);

  const viewKey = `${sort ? `${sort.col}:${sort.dir}` : ""}|${Object.entries(filters)
    .filter(([, f]) => f.trim())
    .map(([c, f]) => `${c}=${f}`)
    .join(",")}`;

  return (
    <div className="h-full w-full flex flex-col">
      {filtersActive && (
        <div className="flex items-center gap-2 px-3 py-1 text-[length:var(--fs-sm)] bg-ink-800/60 border-b border-line-soft shrink-0">
          <span className="text-muted font-mono">
            {viewRows.length.toLocaleString()} of {rs.rows.length.toLocaleString()} rows
          </span>
          <button
            className="text-brass hover:underline"
            onClick={() => {
              setFilters({});
              setSelection(undefined);
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      <div className="flex-1 min-h-0">
        <DataGrid
          columns={columns}
          rowCount={viewRows.length}
          getCellContent={getCellContent}
          dataVersion={`${version}:${viewKey}`}
          gridSelection={selection}
          onGridSelectionChange={handleSelectionChange}
          rowMarkers="clickable-number"
          onFitColumns={onFitColumns}
          onCellActivated={handleCellActivated}
          onHeaderClicked={handleHeaderClicked}
          onHeaderMenuClick={handleHeaderMenuClick}
          onCellContextMenu={onCellContextMenu ? handleCellContextMenu : undefined}
          onHeaderContextMenu={handleHeaderMenuClick}
        />
      </div>
      {menu && (
        <GridColumnMenu
          columnName={rs.columns[menu.col]?.name ?? ""}
          x={menu.x}
          y={menu.y}
          sortDir={sort?.col === menu.col ? sort.dir : null}
          filter={filters[menu.col] ?? ""}
          onSort={(dir) => {
            setSort(dir ? { col: menu.col, dir } : null);
            setSelection(undefined);
          }}
          onFilterChange={(expr) => {
            setFilters((prev) => ({ ...prev, [menu.col]: expr }));
            setSelection(undefined);
          }}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
