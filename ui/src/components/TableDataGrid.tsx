// Traces: BASED-UI-TABLE-EDIT (manual)
// SSMS-style editable data grid for a table tab's Data view. Browses rows page-by-page and, when the
// table has a primary key, edits cells / inserts / deletes rows into a pending change set, previews the
// generated parameterized SQL (Review SQL), and commits it in one transaction. Pending edits, new rows,
// and deletions live in local state; nothing touches the DB until Commit.
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DataEditor,
  GridCellKind,
  type EditableGridCell,
  type GridCell,
  type GridColumn,
  type GridSelection,
  type Item,
} from "@glideapps/glide-data-grid";
import type { TableTabState } from "../store";
import { useStore } from "../store";
import { commitTableEdit, fetchTablePage, previewTableEdit } from "../api/client";
import { cellText, type DbCommandPreview, type TableChangeSet, type TablePage, type WireValue } from "../api/types";
import { gridThemeFromCss, gridCellOverrides } from "../theme";

const NUMERIC_TYPES = /^(int|bigint|smallint|tinyint|decimal|numeric|float|real|money|smallmoney)$/;

type DisplayRef = { kind: "existing"; orig: number } | { kind: "new"; idx: number };

/** Coerce an overlay-edited string to the wire value: numbers for numeric columns, string otherwise. */
function coerceCell(colType: string, raw: string): WireValue {
  if (NUMERIC_TYPES.test(colType) && raw.trim() !== "" && Number.isFinite(Number(raw))) return Number(raw);
  return raw;
}

export function TableDataGrid({ tab }: { tab: TableTabState }) {
  const [page, setPage] = useState<TablePage | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

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
  const gridTheme = useMemo(() => gridThemeFromCss(), [themeId]);
  const overrides = useMemo(() => gridCellOverrides(), [themeId]);

  const hasPk = !!page?.columns.some((c) => c.isPrimaryKey);
  const editable = tab.objectType === "table" && hasPk;

  const clearPending = useCallback(() => {
    setEdits({});
    setNewRows([]);
    setDeleted(new Set());
    setSelection(undefined);
    setReview(null);
    setCommitError(null);
  }, []);

  const load = useCallback(
    async (off: number) => {
      setLoading(true);
      setLoadError(null);
      try {
        const p = await fetchTablePage(tab.schema, tab.table, off, pageSize);
        setPage(p);
        setOffset(off);
        clearPending();
      } catch (err) {
        setLoadError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [tab.schema, tab.table, pageSize, clearPending],
  );

  useEffect(() => {
    void load(0);
    // Reload when the target table changes, or the page size changes (start over at page 1).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.schema, tab.table, pageSize]);

  const display = useMemo<DisplayRef[]>(() => {
    if (!page) return [];
    const existing: DisplayRef[] = page.rows.map((_, i) => i).filter((i) => !deleted.has(i)).map((orig) => ({ kind: "existing", orig }));
    const created: DisplayRef[] = newRows.map((_, idx) => ({ kind: "new", idx }));
    return [...existing, ...created];
  }, [page, newRows, deleted]);

  const columns = useMemo<GridColumn[]>(
    () =>
      (page?.columns ?? []).map((c) => ({
        title: c.isPrimaryKey ? `⚿ ${c.name}` : c.name,
        id: c.name,
        width: Math.min(320, Math.max(80, c.name.length * 9 + 48)),
      })),
    [page?.columns],
  );

  const getCellContent = useCallback(
    ([col, row]: Item): GridCell => {
      const ref = display[row];
      const meta = page?.columns[col];
      if (!ref || !meta) return { kind: GridCellKind.Text, data: "", displayData: "", allowOverlay: false };
      let value: WireValue;
      let dirty = false;
      if (ref.kind === "existing") {
        const edit = edits[ref.orig]?.[meta.name];
        dirty = edit !== undefined;
        value = dirty ? edit! : (page!.rows[ref.orig]?.[col] ?? null);
      } else {
        value = newRows[ref.idx]?.[meta.name] ?? null;
      }
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
    [display, page, edits, newRows, editable, overrides],
  );

  const onCellEdited = useCallback(
    ([col, row]: Item, newValue: EditableGridCell) => {
      const ref = display[row];
      const meta = page?.columns[col];
      if (!ref || !meta) return;
      if (newValue.kind !== GridCellKind.Text) return;
      const wire = coerceCell(meta.type, newValue.data);
      if (ref.kind === "existing") {
        setEdits((prev) => ({ ...prev, [ref.orig]: { ...prev[ref.orig], [meta.name]: wire } }));
      } else {
        setNewRows((prev) => prev.map((r, i) => (i === ref.idx ? { ...r, [meta.name]: wire } : r)));
      }
    },
    [display, page],
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

  const pendingCount = useMemo(() => {
    const dirtyUpdates = Object.entries(edits).filter(
      ([i, changed]) => !deleted.has(Number(i)) && Object.keys(changed).length > 0,
    ).length;
    const inserts = newRows.filter((r) => Object.keys(r).length > 0).length;
    return dirtyUpdates + inserts + deleted.size;
  }, [edits, newRows, deleted]);

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

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-ink-900">
      <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-line-soft shrink-0 text-[12px]">
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

        <div className="w-px h-4 bg-line mx-1" />

        {editable ? (
          <>
            <button className="px-2 py-1 rounded border border-line text-muted hover:text-paper" onClick={addRow}>
              + Add row
            </button>
            <button
              className="px-2 py-1 rounded border border-line text-muted hover:text-paper disabled:opacity-35"
              disabled={(selection?.rows?.length ?? 0) === 0}
              onClick={deleteSelected}
            >
              Delete row
            </button>
          </>
        ) : (
          <span className="text-[11px] text-faint italic">
            {tab.objectType === "view" ? "Views are read-only." : "No primary key — read-only. Add a PK to edit."}
          </span>
        )}

        <div className="flex-1" />

        {pendingCount > 0 && <span className="text-brass font-mono text-[11px]">{pendingCount} pending</span>}
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

      {commitError && (
        <div className="mx-3 mt-2 px-3 py-2 text-[12px] text-err bg-err/10 border border-err/30 rounded font-mono whitespace-pre-wrap">
          {commitError}
        </div>
      )}

      {review && (
        <div className="mx-3 mt-2 border border-line rounded bg-ink-950 text-[11px] font-mono max-h-48 overflow-auto">
          <div className="flex items-center justify-between px-3 py-1.5 border-b border-line-soft sticky top-0 bg-ink-950">
            <span className="ledger-label">Review SQL — {review.length} command(s), parameterized</span>
            <button className="text-muted hover:text-paper" onClick={() => setReview(null)}>
              ✕
            </button>
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
        {loading && <div className="px-5 py-3 text-muted pulse-soft text-[12px]">Loading rows…</div>}
        {loadError && (
          <div className="mx-3 px-3 py-2 text-[12px] text-err bg-err/10 border border-err/30 rounded font-mono">{loadError}</div>
        )}
        {!loading && !loadError && page && (
          <DataEditor
            columns={columns}
            rows={display.length}
            getCellContent={getCellContent}
            onCellEdited={editable || newRows.length > 0 ? onCellEdited : undefined}
            getCellsForSelection={true}
            rowMarkers="both"
            rowSelectionMode="multi"
            smoothScrollX
            smoothScrollY
            width="100%"
            height="100%"
            theme={gridTheme}
            gridSelection={selection}
            key={themeId}
            onGridSelectionChange={setSelection}
          />
        )}
      </div>
    </div>
  );
}
