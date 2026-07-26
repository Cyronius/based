// Traces: BASED-UI-TABLE-EDIT (manual), BASED-LANCE-SEARCH-UI
// SSMS-style editable data grid for a table tab's Data view. Browses rows page-by-page and, when the
// table has a primary key, edits cells / inserts / deletes rows into a pending change set, previews the
// generated parameterized SQL (Review SQL), and commits it in one transaction. Pending edits, new rows,
// and deletions live in local state; nothing touches the DB until Commit.
// When `searchCapable` (LanceDB), the search toolbar (vector/keyword/hybrid) is always shown above
// the browse toolbar. The grid itself shows the raw browsed page until a search is run; the search
// result then takes over (read-only) until cleared, by normalizing SearchRows into a TablePage shape
// (BASED-LANCE-SEARCH-UI).
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import {
  CompactSelection,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import type { TableTabState } from "../store";
import { useStore } from "../store";
import { commitTableEdit, fetchTablePage, previewTableEdit, runLanceSearch } from "../api/client";
import {
  cellText,
  type DbCommandPreview,
  type LanceSearchMode,
  type SearchRows,
  type TableChangeSet,
  type TableFilter,
  type TablePage,
  type TableSort,
  type WireValue,
} from "../api/types";
import { gridCellOverrides } from "../theme";
import { computeSelectionSlice, selectionContains } from "../gridSelectionText";
import { parseFilterToTableFilter } from "../gridView";
import { cellDisplayText, DataGrid, type DataGridColumnDef } from "./DataGrid";
import { GridColumnMenu } from "./GridColumnMenu";
import { GridContextMenu } from "./GridContextMenu";
import { GridToolbarActions, useGridExportActions } from "./GridToolbarActions";
import { ImportCsvDialog } from "./ImportCsvDialog";
import { IconButton } from "./IconButton";
import { TrashIcon } from "./icons";

const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)$/;

type DisplayRef = { kind: "existing"; orig: number } | { kind: "new"; idx: number };

/** Coerce an overlay-edited string to the wire value: numbers for numeric columns, string otherwise. */
function coerceCell(colType: string, raw: string): WireValue {
  if (NUMERIC_TYPES.test(colType) && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

/** Normalize a search result into the same shape the browse path already renders — every column comes
 *  back `isPrimaryKey: false`, so the existing `editable` check makes search results read-only for free. */
function toTablePage(res: SearchRows): TablePage {
  return {
    columns: res.columns.map((c) => ({
      name: c.name,
      type: c.type,
      maxLength: null,
      precision: null,
      scale: null,
      nullable: true,
      isPrimaryKey: false,
      isForeignKey: false,
      fkTarget: null,
    })),
    rows: res.rows,
    orderBy: [],
  };
}

const numOrUndef = (s: string): number | undefined => (s.trim() === "" ? undefined : Number(s));

const SEARCH_MODES: { id: LanceSearchMode; label: string; icon: (props: { className?: string }) => ReactElement }[] = [
  {
    id: "vector",
    label: "Vector — meaning-based search over embeddings",
    icon: (p) => (
      <svg {...p} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <line x1="3" y1="13" x2="12" y2="4" />
        <path d="M7 4h5v5" strokeLinejoin="round" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "text",
    label: "Keyword — BM25 full-text search",
    icon: (p) => (
      <svg {...p} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="6.5" cy="6.5" r="4" />
        <line x1="9.8" y1="9.8" x2="13.5" y2="13.5" strokeLinecap="round" />
      </svg>
    ),
  },
  {
    id: "hybrid",
    label: "Hybrid — vector + keyword combined",
    icon: (p) => (
      <svg {...p} width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
        <circle cx="6" cy="8" r="4.2" />
        <circle cx="10" cy="8" r="4.2" />
      </svg>
    ),
  },
];

export function TableDataGrid({
  tab,
  searchCapable,
  onCellTextChange,
  onCellActivate,
}: {
  tab: TableTabState;
  searchCapable: boolean;
  /** Fires on every selection change with the selected cell's full text (or null if none selected). */
  onCellTextChange?: (text: string | null) => void;
  /** Fires on double-click/Enter/Space on a cell, with its full text — opens the Cell viewer tab. */
  onCellActivate?: (text: string) => void;
}) {
  const [page, setPage] = useState<TablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Traces: BASED-TABLE-FILTER-UI — server-side sort + per-column filter expressions (mini-language,
  // parsed into structured TableFilters at fetch time). Gated on capabilities.orderedBrowse.
  const [sort, setSort] = useState<TableSort | null>(null);
  const [filterExprs, setFilterExprs] = useState<Record<string, string>>({});
  const [headerMenu, setHeaderMenu] = useState<{ col: number; x: number; y: number } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);
  const [gateNotice, setGateNotice] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const capabilities = useStore((s) => s.capabilities);
  const orderedBrowse = capabilities?.orderedBrowse === true;

  const [searchMode, setSearchMode] = useState<LanceSearchMode>("vector");
  const [query, setQuery] = useState("");
  const [whereText, setWhereText] = useState("");
  const [embeddingProfileId, setEmbeddingProfileId] = useState("");
  const [rerankerProfileId, setRerankerProfileId] = useState("");
  const [rerankTopN, setRerankTopN] = useState("");
  const [rerankTemperature, setRerankTemperature] = useState("");
  const [rerankTextColumn, setRerankTextColumn] = useState("");
  const [sampleSize, setSampleSize] = useState("50");
  const [keepSize, setKeepSize] = useState("10");
  const [floorText, setFloorText] = useState("");
  const [deltaText, setDeltaText] = useState("");
  const [searchResult, setSearchResult] = useState<SearchRows | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const embeddingProfiles = useStore((s) => s.embeddingProfiles);
  const rerankerProfiles = useStore((s) => s.rerankerProfiles);

  // Pending change set (all keyed against the *current* page's original row indexes).
  const [edits, setEdits] = useState<Record<number, Record<string, WireValue>>>({});
  const [newRows, setNewRows] = useState<Array<Record<string, WireValue>>>([]);
  const [deleted, setDeleted] = useState<Set<number>>(new Set());
  const [selection, setSelection] = useState<GridSelection | undefined>(undefined);

  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [review, setReview] = useState<DbCommandPreview[] | null>(null);

  const themeId = useStore((s) => s.theme);
  const pageSize = useStore((s) => s.rowPageSize);
  const overrides = useMemo(() => gridCellOverrides(), [themeId]);
  const fitFnRef = useRef<() => void>(() => {});

  // No search has been run (or its results were cleared) — show the raw browsed page. Once a search
  // result comes back, every result column is isPrimaryKey:false, so hasPk (and therefore editable)
  // is naturally false with no extra gating — search results render read-only for free.
  const hasSearchResult = searchResult !== null;
  const effectivePage = hasSearchResult ? toTablePage(searchResult) : page;
  const hasPk = !!effectivePage?.columns.some((c) => c.isPrimaryKey);
  const editable = !hasSearchResult && tab.objectType === "table" && hasPk;

  const clearPending = useCallback(() => {
    setEdits({});
    setNewRows([]);
    setDeleted(new Set());
    setSelection(undefined);
    onCellTextChange?.(null);
    setReview(null);
    setCommitError(null);
  }, [onCellTextChange]);

  const pendingCount = useMemo(() => {
    const dirtyUpdates = Object.entries(edits).filter(
      ([i, changed]) => !deleted.has(Number(i)) && Object.keys(changed).length > 0,
    ).length;
    const inserts = newRows.filter((r) => Object.keys(r).length > 0).length;
    return dirtyUpdates + inserts + deleted.size;
  }, [edits, newRows, deleted]);

  /** Structured server-side filters from the per-column expressions (empty → undefined). */
  const buildFilters = useCallback(
    (exprs: Record<string, string>, cols: TablePage["columns"] | undefined): TableFilter[] | undefined => {
      if (!cols) return undefined;
      const out: TableFilter[] = [];
      for (const [name, expr] of Object.entries(exprs)) {
        const col = cols.find((c) => c.name === name);
        if (!col) continue;
        const f = parseFilterToTableFilter(name, col.type, expr);
        if (f) out.push(f);
      }
      return out.length > 0 ? out : undefined;
    },
    [],
  );

  const load = useCallback(
    async (off: number, sortArg?: TableSort | null, filtersArg?: Record<string, string>) => {
      setLoading(true);
      setLoadError(null);
      const effSort = sortArg === undefined ? sort : sortArg;
      const effExprs = filtersArg === undefined ? filterExprs : filtersArg;
      try {
        const p = await fetchTablePage(
          tab.schema,
          tab.table,
          off,
          pageSize,
          effSort ? [effSort] : undefined,
          buildFilters(effExprs, page?.columns),
        );
        setPage(p);
        setOffset(off);
        clearPending();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tab.schema, tab.table, pageSize, clearPending, sort, filterExprs, page?.columns, buildFilters],
  );

  useEffect(() => {
    // Reload when the target table changes, or the page size changes — start over at page 1 with
    // sort/filters reset (they belong to the previous table's columns).
    setSort(null);
    setFilterExprs({});
    setHeaderMenu(null);
    setRerankTextColumn("");
    void load(0, null, {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.schema, tab.table, pageSize]);

  // Sort changes reload immediately; filter expressions debounce (typed live in the header menu).
  const viewInitRef = useRef(true);
  const sortKey = sort ? `${sort.column}:${sort.dir}` : "";
  const filtersKey = JSON.stringify(filterExprs);
  useEffect(() => {
    if (viewInitRef.current) {
      viewInitRef.current = false;
      return;
    }
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sortKey]);
  const filtersInitRef = useRef(true);
  useEffect(() => {
    if (filtersInitRef.current) {
      filtersInitRef.current = false;
      return;
    }
    const t = setTimeout(() => void load(0), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtersKey]);

  // Header interactions are blocked while edits are pending — a reload clears pending state and
  // silently losing edits is unacceptable (BASED-TABLE-FILTER-UI).
  const showGateNotice = useCallback(() => {
    setGateNotice(true);
    setTimeout(() => setGateNotice(false), 3000);
  }, []);

  const display = useMemo<DisplayRef[]>(() => {
    if (!effectivePage) return [];
    const existing: DisplayRef[] = effectivePage.rows.map((_, i) => i).filter((i) => !deleted.has(i)).map((orig) => ({ kind: "existing", orig }));
    const created: DisplayRef[] = newRows.map((_, idx) => ({ kind: "new", idx }));
    return [...existing, ...created];
  }, [effectivePage, newRows, deleted]);

  /** Resolves a display row's current value for one column — committed page value, overridden by a
   *  pending edit, or a new row's in-progress value. Shared by getCellContent and displayRows so
   *  Copy/Export always reflect exactly what's rendered. */
  const valueAt = useCallback(
    (ref: DisplayRef, colIdx: number): WireValue => {
      const meta = effectivePage?.columns[colIdx];
      if (!meta) return null;
      if (ref.kind === "existing") {
        const edit = edits[ref.orig]?.[meta.name];
        return edit !== undefined ? edit : (effectivePage!.rows[ref.orig]?.[colIdx] ?? null);
      }
      return newRows[ref.idx]?.[meta.name] ?? null;
    },
    [effectivePage, edits, newRows],
  );

  /** What's currently rendered — pending edits overlaid, new rows included, deleted rows excluded.
   *  Feeds Copy/CSV/Excel export so they match the grid, not the last-committed page. */
  const displayRows = useMemo<WireValue[][]>(
    () => (effectivePage ? display.map((ref) => effectivePage.columns.map((_, colIdx) => valueAt(ref, colIdx))) : []),
    [display, effectivePage, valueAt],
  );

  // One shared action set feeds both the toolbar buttons and the right-click context menu
  // (BASED-GRID-EXPORT-STANDARD). Columns come from the effective page so search results export too.
  const exportActions = useGridExportActions({
    columns: effectivePage?.columns ?? [],
    getRows: () => displayRows,
    getSlice: () => computeSelectionSlice(selection, effectivePage?.columns.length ?? 0),
  });

  const headerInteractive = orderedBrowse && !hasSearchResult;
  const columns = useMemo<DataGridColumnDef[]>(
    () =>
      (effectivePage?.columns ?? []).map((c) => {
        const base = c.isPrimaryKey ? `⚿ ${c.name}` : c.name;
        if (!headerInteractive) return { id: c.name, title: base };
        const arrow = sort?.column === c.name ? (sort.dir === "asc" ? " ▲" : " ▼") : "";
        const mark = (filterExprs[c.name] ?? "").trim() ? " •" : "";
        return { id: c.name, title: `${base}${mark}${arrow}`, hasMenu: true };
      }),
    [effectivePage?.columns, headerInteractive, sort, filterExprs],
  );

  const handleHeaderClicked = useCallback(
    (colIndex: number) => {
      if (!headerInteractive) return;
      const col = effectivePage?.columns[colIndex];
      if (!col) return;
      if (pendingCount > 0) {
        showGateNotice();
        return;
      }
      setSort((prev) => {
        if (prev?.column !== col.name) return { column: col.name, dir: "asc" };
        return prev.dir === "asc" ? { column: col.name, dir: "desc" } : null;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [headerInteractive, effectivePage?.columns, pendingCount, showGateNotice],
  );

  const handleHeaderMenuClick = useCallback(
    (colIndex: number, bounds: { x: number; y: number; height: number }) => {
      if (!headerInteractive) return;
      if (pendingCount > 0) {
        showGateNotice();
        return;
      }
      setHeaderMenu({ col: colIndex, x: bounds.x, y: bounds.y + bounds.height });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [headerInteractive, pendingCount, showGateNotice],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const ref = display[row];
      const meta = effectivePage?.columns[col];
      if (!ref || !meta) return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false };
      const value = valueAt(ref, col);
      const dirty = ref.kind === "existing" && edits[ref.orig]?.[meta.name] !== undefined;
      const cellEditable = editable || ref.kind === "new";
      const text = value === null ? "" : typeof value === "object" ? cellText(value) : String(value);
      const themeOverride =
        ref.kind === "new" ? overrides.fresh : dirty ? overrides.dirty : value === null ? { textDark: overrides.nullText } : undefined;
      return {
        kind: GridCellKind.Text,
        data: text,
        displayData: value === null ? "NULL" : text,
        allowOverlay: cellEditable,
        readonly: !cellEditable,
        themeOverride,
      };
    },
    [display, effectivePage, valueAt, edits, editable, overrides],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      const ref = display[row];
      const meta = effectivePage?.columns[col];
      if (!ref || !meta) return;
      if (newValue.kind !== GridCellKind.Text) return;
      const wire = coerceCell(meta.type, newValue.data);
      if (ref.kind === "existing") {
        setEdits((prev) => ({ ...prev, [ref.orig]: { ...prev[ref.orig], [meta.name]: wire } }));
      } else {
        setNewRows((prev) => prev.map((r, i) => (i === ref.idx ? { ...r, [meta.name]: wire } : r)));
      }
    },
    [display, effectivePage],
  );

  const handleSelectionChange = useCallback(
    (sel: GridSelection) => {
      setSelection(sel);
      const cell = sel.current?.cell;
      onCellTextChange?.(cell ? cellDisplayText(getCellContent(cell)) : null);
    },
    [getCellContent, onCellTextChange],
  );

  const handleCellActivated = useCallback(
    (cell: Item) => onCellActivate?.(cellDisplayText(getCellContent(cell))),
    [getCellContent, onCellActivate],
  );

  // Right-click outside the current selection first selects the clicked cell (standard behavior),
  // then opens the shared context menu at the mouse position (BASED-GRID-CONTEXT-MENU).
  const handleCellContextMenu = useCallback(
    (cell: Item, pos: { x: number; y: number }) => {
      if (!selectionContains(selection, cell)) {
        handleSelectionChange({
          current: { cell, range: { x: cell[0], y: cell[1], width: 1, height: 1 }, rangeStack: [] },
          columns: CompactSelection.empty(),
          rows: CompactSelection.empty(),
        });
      }
      setCtxMenu(pos);
    },
    [selection, handleSelectionChange],
  );

  const addRow = () => setNewRows((prev) => [...prev, {}]);

  const deleteSelected = () => {
    const rows = selection?.rows?.toArray() ?? [];
    if (rows.length === 0) return;
    const nextDeleted = new Set(deleted);
    const removeNew = new Set<number>();
    for (const r of rows) {
      const ref = display[r];
      if (!ref) continue;
      if (ref.kind === "existing") nextDeleted.add(ref.orig);
      else removeNew.add(ref.idx);
    }
    setDeleted(nextDeleted);
    if (removeNew.size > 0) setNewRows((prev) => prev.filter((_, i) => !removeNew.has(i)));
    setSelection(undefined);
    onCellTextChange?.(null);
  };

  const changeSet = useCallback((): TableChangeSet => {
    const cols = page!.columns;
    const pkCols = cols.filter((c) => c.isPrimaryKey).map((c) => c.name);
    const colIndex = (name: string) => cols.findIndex((c) => c.name === name);
    const keyOf = (orig: number): Record<string, WireValue> =>
      Object.fromEntries(pkCols.map((pk) => [pk, page!.rows[orig]![colIndex(pk)]!]));
    const updates = Object.entries(edits)
      .filter(([i, changed]) => !deleted.has(Number(i)) && Object.keys(changed).length > 0)
      .map(([i, changed]) => ({ key: keyOf(Number(i)), set: changed }));
    const deletes = [...deleted].map((i) => keyOf(i));
    const inserts = newRows.filter((r) => Object.keys(r).length > 0);
    return {
      schema: tab.schema,
      table: tab.table,
      columns: cols.map((c) => ({ name: c.name, isPrimaryKey: c.isPrimaryKey })),
      updates,
      inserts,
      deletes,
    };
  }, [page, edits, deleted, newRows, tab.schema, tab.table]);

  const openReview = async () => {
    try {
      const { commands } = await previewTableEdit(changeSet());
      setReview(commands);
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    }
  };

  const commit = async () => {
    setCommitting(true);
    setCommitError(null);
    try {
      const res = await commitTableEdit(changeSet());
      if (res.error) {
        setCommitError(res.error); // rolled back — keep the pending edits so the grid still shows pre-commit state
      } else {
        await load(offset); // refresh from the DB; clears pending
      }
    } catch (err) {
      setCommitError(err instanceof Error ? err.message : String(err));
    } finally {
      setCommitting(false);
    }
  };

  const rangeLabel = page ? `${page.rows.length === 0 ? 0 : offset + 1}–${offset + page.rows.length}` : "";
  const searchRangeLabel = searchResult ? `${searchResult.rows.length} row${searchResult.rows.length === 1 ? "" : "s"}` : "";

  // Reranking only makes sense over an embedding-scored candidate set; floor/delta trim that score,
  // and sample/keep tune the reranker's candidate pool — each is meaningless without its prerequisite.
  const hasEmbedding = searchMode !== "text" && !!embeddingProfileId;
  const hasReranker = hasEmbedding && !!rerankerProfileId;

  // Candidate "document text" columns for the reranker — the table's string columns (from the
  // browsed page, which always has the base schema; search results add score columns).
  const rerankColumnOptions = useMemo(
    () => (page?.columns ?? []).filter((c) => /utf8|string/i.test(c.type)).map((c) => c.name),
    [page?.columns],
  );

  async function runSearch() {
    clearPending();
    setSearching(true);
    setSearchError(null);
    setSelection(undefined);
    onCellTextChange?.(null);
    try {
      const res = await runLanceSearch({
        schema: tab.schema || undefined,
        table: tab.table,
        mode: searchMode,
        query: query.trim() || undefined,
        where: whereText.trim() || undefined,
        sampleSize: hasReranker ? numOrUndef(sampleSize) : undefined,
        keepSize: hasReranker ? numOrUndef(keepSize) : undefined,
        embeddingProfileId: hasEmbedding ? embeddingProfileId : undefined,
        rerankerProfileId: hasEmbedding && rerankerProfileId ? rerankerProfileId : undefined,
        rerankerOptions:
          hasReranker && (rerankTopN.trim() || rerankTemperature.trim())
            ? { topN: numOrUndef(rerankTopN), temperature: numOrUndef(rerankTemperature) }
            : undefined,
        rerankTextColumn: hasReranker && rerankTextColumn ? rerankTextColumn : undefined,
        floor: hasEmbedding ? numOrUndef(floorText) : undefined,
        delta: hasEmbedding ? numOrUndef(deltaText) : undefined,
      });
      setSearchResult(res);
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err));
      setSearchResult(null);
    } finally {
      setSearching(false);
    }
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-ink-900">
      <div className="flex flex-col border-b border-line-soft shrink-0">
        {searchCapable && (
          <div className={`flex items-center gap-1.5 px-3 py-1.5 text-[length:var(--fs-base)]${!hasSearchResult ? " border-b border-line-soft" : ""}`}>
            <div className="flex rounded border border-line overflow-hidden shrink-0">
              {SEARCH_MODES.map((m, i) => (
                <button
                  key={m.id}
                  type="button"
                  title={m.label}
                  aria-label={m.label}
                  aria-pressed={searchMode === m.id}
                  onClick={() => setSearchMode(m.id)}
                  className={`grid place-items-center h-[26px] w-[26px] ${i > 0 ? "border-l border-line" : ""} ${
                    searchMode === m.id ? "bg-brass/20 text-brass" : "text-muted hover:text-paper hover:bg-ink-950/60"
                  }`}
                >
                  <m.icon />
                </button>
              ))}
            </div>
            <input
              className="px-2 py-1 rounded border border-line bg-ink-950 text-paper placeholder:text-faint min-w-[10rem]"
              placeholder="where (prefilter)"
              value={whereText}
              onChange={(e) => setWhereText(e.target.value)}
              title='LanceDB filter predicate, e.g. "year > 2020"'
            />
            <input
              className="px-2 py-1 rounded border border-line bg-ink-950 text-paper placeholder:text-faint min-w-[16rem]"
              placeholder={searchMode === "vector" ? "meaning to search for…" : "keywords…"}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && void runSearch()}
            />
            {searchMode !== "text" && (
              <select
                className="pl-2 pr-7 py-1 rounded border border-line bg-ink-950 text-paper max-w-[12rem]"
                value={embeddingProfileId}
                onChange={(e) => setEmbeddingProfileId(e.target.value)}
                title="Embedding profile"
              >
                <option value="">Embedding: none</option>
                {embeddingProfiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {hasEmbedding && (
              <>
                <select
                  className="pl-2 pr-7 py-1 rounded border border-line bg-ink-950 text-paper max-w-[12rem]"
                  value={rerankerProfileId}
                  onChange={(e) => setRerankerProfileId(e.target.value)}
                  title="Reranker profile"
                >
                  <option value="">Reranker: none</option>
                  {rerankerProfiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
                <input
                  className="w-16 px-2 py-1 rounded border border-line bg-ink-950 text-paper placeholder:text-faint"
                  placeholder="floor"
                  value={floorText}
                  onChange={(e) => setFloorText(e.target.value)}
                  title="Drop results worse than this score"
                />
                <input
                  className="w-16 px-2 py-1 rounded border border-line bg-ink-950 text-paper placeholder:text-faint"
                  placeholder="delta"
                  value={deltaText}
                  onChange={(e) => setDeltaText(e.target.value)}
                  title="Drop results trailing the top result's score by more than this"
                />
              </>
            )}
            {hasReranker && (
              <>
                <select
                  className="pl-2 pr-7 py-1 rounded border border-line bg-ink-950 text-paper max-w-[10rem]"
                  value={rerankTextColumn}
                  onChange={(e) => setRerankTextColumn(e.target.value)}
                  title="Column sent to the reranker as document text — auto prefers a content-named or longest text column"
                >
                  <option value="">Rerank col: auto</option>
                  {rerankColumnOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
                <input
                  className="w-16 px-2 py-1 rounded border border-line bg-ink-950 text-paper placeholder:text-faint"
                  placeholder="top_n"
                  value={rerankTopN}
                  onChange={(e) => setRerankTopN(e.target.value)}
                  title="Rerank top_n"
                />
                <input
                  className="w-16 px-2 py-1 rounded border border-line bg-ink-950 text-paper placeholder:text-faint"
                  placeholder="temp"
                  value={rerankTemperature}
                  onChange={(e) => setRerankTemperature(e.target.value)}
                  title="Rerank temperature"
                />
                <input
                  className="w-16 px-2 py-1 rounded border border-line bg-ink-950 text-paper placeholder:text-faint"
                  placeholder="sample"
                  value={sampleSize}
                  onChange={(e) => setSampleSize(e.target.value)}
                  title="Sample size (initial candidate pool)"
                />
                <input
                  className="w-14 px-2 py-1 rounded border border-line bg-ink-950 text-paper placeholder:text-faint"
                  placeholder="keep"
                  value={keepSize}
                  onChange={(e) => setKeepSize(e.target.value)}
                  title="Keep size (final result count)"
                />
              </>
            )}

            <div className="flex-1" />

            {searchResult && <span className="text-faint font-mono">{searchRangeLabel}</span>}
            <button
              className="px-2.5 py-1 rounded border border-brass-soft bg-brass/15 text-brass hover:bg-brass/25 disabled:opacity-40"
              disabled={searching || !query.trim()}
              onClick={() => void runSearch()}
            >
              {searching ? "Searching…" : "Run"}
            </button>
            {searchResult && (
              <button className="px-2 py-1 rounded border border-line text-muted hover:text-paper" onClick={() => setSearchResult(null)}>
                Clear
              </button>
            )}
          </div>
        )}

        {!hasSearchResult && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 text-[length:var(--fs-base)]">
            <button
              className="px-2 py-1 rounded border border-line text-muted hover:text-paper disabled:opacity-35"
              disabled={loading || offset === 0 || pendingCount > 0}
              onClick={() => void load(Math.max(0, offset - pageSize))}
              title={pendingCount > 0 ? "Commit or discard pending changes first" : "Previous page"}
            >
              ‹ Prev
            </button>
            <button
              className="px-2 py-1 rounded border border-line text-muted hover:text-paper disabled:opacity-35"
              disabled={loading || !page || page.rows.length < pageSize || pendingCount > 0}
              onClick={() => void load(offset + pageSize)}
              title={pendingCount > 0 ? "Commit or discard pending changes first" : "Next page"}
            >
              Next ›
            </button>
            <span className="text-faint font-mono">{rangeLabel}</span>
            {Object.values(filterExprs).some((f) => f.trim()) && (
              <button
                className="rounded-full border border-brass px-2 py-px text-[length:var(--fs-xs)] text-brass hover:bg-brass/10"
                title="Server-side filters are active — click to clear"
                onClick={() => {
                  if (pendingCount > 0) {
                    showGateNotice();
                    return;
                  }
                  setFilterExprs({});
                }}
              >
                filtered · clear
              </button>
            )}
            {gateNotice && (
              <span className="text-[length:var(--fs-sm)] text-brass">Commit or discard {pendingCount} pending changes first</span>
            )}

            <div className="w-px h-4 bg-line mx-1" />

            {editable ? (
              <>
                <IconButton title="Add row" aria-label="Add row" className="text-lg text-muted hover:text-paper" onClick={addRow}>
                  +
                </IconButton>
                <button
                  className="px-2 py-1 rounded border border-line text-muted hover:text-paper"
                  title="Import rows from a CSV file"
                  onClick={() => setImportOpen(true)}
                >
                  Import CSV
                </button>
                <IconButton
                  title="Delete row"
                  aria-label="Delete row"
                  className="text-muted hover:text-err"
                  disabled={(selection?.rows?.length ?? 0) === 0}
                  onClick={deleteSelected}
                >
                  <TrashIcon />
                </IconButton>
              </>
            ) : (
              <span className="text-[length:var(--fs-sm)] text-faint italic">
                {tab.objectType === "view" ? "Views are read-only." : "No primary key — read-only. Add a PK to edit."}
              </span>
            )}

            <div className="flex-1" />

            {page && <GridToolbarActions actions={exportActions} onFitColumns={() => fitFnRef.current()} />}

            {pendingCount > 0 && <span className="text-brass font-mono text-[length:var(--fs-sm)]">{pendingCount} pending</span>}
            <button
              className="px-2 py-1 rounded border border-line text-muted hover:text-paper disabled:opacity-35"
              disabled={pendingCount === 0}
              onClick={() => void openReview()}
            >
              Review SQL
            </button>
            <button
              className="px-2.5 py-1 rounded border border-ok/40 text-ok hover:bg-ok/10 disabled:opacity-35"
              disabled={pendingCount === 0 || committing}
              onClick={() => void commit()}
            >
              {committing ? "Committing…" : "Commit"}
            </button>
            <button
              className="px-2 py-1 rounded border border-line text-muted hover:text-paper disabled:opacity-35"
              disabled={pendingCount === 0 || committing}
              onClick={clearPending}
            >
              Discard
            </button>
          </div>
        )}
      </div>

      {commitError && (
        <div className="mx-3 mt-2 px-3 py-2 text-[length:var(--fs-base)] text-err bg-err/10 border border-err/30 rounded font-mono whitespace-pre-wrap">
          {commitError}
        </div>
      )}

      {review && (
        <div className="mx-3 mt-2 border border-line rounded bg-ink-950 text-[length:var(--fs-sm)] font-mono max-h-48 overflow-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-line-soft sticky top-0 bg-ink-950">
            <span className="ledger-label">Review SQL — {review.length} command(s), parameterized</span>
            <IconButton size="sm" title="Close" aria-label="Close review" className="text-muted hover:text-paper" onClick={() => setReview(null)}>
              ✕
            </IconButton>
          </div>
          <div className="p-3 space-y-2">
            {review.length === 0 && <div className="text-faint">No commands.</div>}
            {review.map((cmd, i) => (
              <div key={i}>
                <div className="text-paper-dim whitespace-pre-wrap">{cmd.sql}</div>
                {cmd.params.length > 0 && (
                  <div className="text-faint">
                    {cmd.params.map((p) => `@${p.name} = ${p.value === null ? "NULL" : JSON.stringify(p.value)}`).join("  ·  ")}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex-1 min-h-0 mt-2">
        {searching && <div className="px-5 py-3 text-muted pulse-soft text-[length:var(--fs-base)]">Searching…</div>}
        {!searching && !hasSearchResult && loading && (
          <div className="px-5 py-3 text-muted pulse-soft text-[length:var(--fs-base)]">Loading rows…</div>
        )}
        {!searching && !hasSearchResult && loadError && (
          <div className="mx-3 px-3 py-2 text-[length:var(--fs-base)] text-err bg-err/10 border border-err/30 rounded font-mono">{loadError}</div>
        )}
        {!searching && !hasSearchResult && searchError && (
          <div className="mx-3 px-3 py-2 text-[length:var(--fs-base)] text-err bg-err/10 border border-err/30 rounded font-mono">{searchError}</div>
        )}
        {effectivePage && !(searching || (!hasSearchResult && (loading || loadError))) && (
          <DataGrid
            columns={columns}
            rowCount={display.length}
            getCellContent={getCellContent}
            dataVersion={`${hasSearchResult ? "search" : "browse"}:${offset}:${Object.keys(edits).length}:${newRows.length}:${deleted.size}:${searchResult?.rows.length ?? 0}`}
            onCellEdited={editable || newRows.length > 0 ? onCellEdited : undefined}
            rowMarkers="both"
            rowSelectionMode="multi"
            gridSelection={selection}
            onGridSelectionChange={handleSelectionChange}
            onFitColumns={(fn) => {
              fitFnRef.current = fn;
            }}
            onCellActivated={handleCellActivated}
            onHeaderClicked={headerInteractive ? handleHeaderClicked : undefined}
            onHeaderMenuClick={headerInteractive ? handleHeaderMenuClick : undefined}
            onCellContextMenu={handleCellContextMenu}
            onHeaderContextMenu={headerInteractive ? handleHeaderMenuClick : undefined}
          />
        )}
      </div>
      {ctxMenu && <GridContextMenu x={ctxMenu.x} y={ctxMenu.y} actions={exportActions} onClose={() => setCtxMenu(null)} />}
      {importOpen && page && (
        <ImportCsvDialog
          schema={tab.schema}
          table={tab.table}
          columns={page.columns}
          onClose={() => setImportOpen(false)}
          onImported={() => void load(0)}
        />
      )}
      {headerMenu && effectivePage && (
        <GridColumnMenu
          columnName={effectivePage.columns[headerMenu.col]?.name ?? ""}
          x={headerMenu.x}
          y={headerMenu.y}
          sortDir={sort?.column === effectivePage.columns[headerMenu.col]?.name ? sort.dir : null}
          filter={filterExprs[effectivePage.columns[headerMenu.col]?.name ?? ""] ?? ""}
          onSort={(dir) => {
            const name = effectivePage.columns[headerMenu.col]?.name;
            if (!name) return;
            setSort(dir ? { column: name, dir } : null);
          }}
          onFilterChange={(expr) => {
            const name = effectivePage.columns[headerMenu.col]?.name;
            if (!name) return;
            setFilterExprs((prev) => ({ ...prev, [name]: expr }));
          }}
          onClose={() => setHeaderMenu(null)}
        />
      )}
    </div>
  );
}
