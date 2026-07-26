// Traces: BASED-GRID-EXPORT-STANDARD
// The standard grid export/copy action set — Copy / Copy as Markdown / Save as CSV / Open in
// Excel — shared by the SQL results toolbar (ResultsPane), the Data tab toolbar (TableDataGrid),
// and the embeddings Selection grid. useGridExportActions holds the behavior; GridToolbarActions
// renders the toolbar buttons and GridContextMenu renders the same actions on right-click, both
// from the SAME hook instance so notices surface in one place.
import { useState } from "react";
import { api } from "../api/client";
import type { WireValue } from "../api/types";
import { selectionMarkdown, selectionTsv, sliceRows, type SelectionSlice } from "../gridSelectionText";

export interface GridExportActions {
  notice: string | null;
  /** Selection (or whole view) as tab-separated text — Excel-pasteable. */
  copy: () => Promise<void>;
  /** Selection (or whole view) as a markdown table (BASED-GRID-COPY-MD). */
  copyMarkdown: () => Promise<void>;
  /** File export via /api/export. scope "view" = the whole current view (toolbar behavior);
   *  "selection" = the current selection, falling back to the whole view (context menu). */
  exportFile: (format: "csv" | "xlsx", opts?: { openAfter?: boolean; scope?: "view" | "selection" }) => Promise<void>;
}

export function useGridExportActions({
  columns,
  getRows,
  getSlice,
}: {
  columns: { name: string }[];
  /** Getter (not a snapshot) so export always reads the CURRENT view — sorted/filtered results,
   *  pending-edit overlays — WYSIWYG (BASED-GRID-SORT). */
  getRows: () => WireValue[][];
  /** Getter for the current selection slice (whole-view slice when nothing is selected). */
  getSlice: () => SelectionSlice;
}): GridExportActions {
  const [notice, setNotice] = useState<string | null>(null);

  const flash = (text: string, ms = 1500) => {
    setNotice(text);
    setTimeout(() => setNotice(null), ms);
  };

  return {
    notice,
    copy: async () => {
      await navigator.clipboard.writeText(selectionTsv(getSlice(), columns, getRows()));
      flash("Copied");
    },
    copyMarkdown: async () => {
      await navigator.clipboard.writeText(selectionMarkdown(getSlice(), columns, getRows()));
      flash("Copied markdown");
    },
    exportFile: async (format, opts) => {
      setNotice(opts?.openAfter ? "Opening…" : "Exporting…");
      try {
        const data =
          opts?.scope === "selection" ? sliceRows(getSlice(), columns, getRows()) : { columns, rows: getRows() };
        const res = await api<{ path: string | null }>("/api/export", {
          method: "POST",
          body: JSON.stringify({ format, ...data, openAfter: opts?.openAfter ?? false }),
        });
        setNotice(res.path ? (opts?.openAfter ? "Opened in Excel" : `Saved ${res.path.split(/[\\/]/).pop()}`) : null);
      } catch (err) {
        setNotice(err instanceof Error ? err.message : String(err));
      }
      setTimeout(() => setNotice(null), 4000);
    },
  };
}

/** One height for every toolbar control, equal to the natural height of the `py-1` fs-md text
 *  buttons that share these toolbars (Review SQL / Commit / Discard): 1.5 line-height × fs-md
 *  content + 8px padding + 2px border. Keeps all controls flush at any --font-scale. */
const controlH = "h-[calc(var(--fs-md)*1.5_+_10px)]";
const btn = `inline-flex items-center ${controlH} px-2 text-[length:var(--fs-sm)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60 disabled:opacity-35`;
const iconBtn = `grid place-items-center ${controlH} w-[26px] rounded border border-line text-muted hover:text-brass hover:border-brass-soft/60 disabled:opacity-35`;

export function MarkdownIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="1.5" y="3.5" width="13" height="9" rx="1.5" />
      <path d="M3.5 10.5V5.5l2 2.5 2-2.5v5" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M11.25 5.5v4.5M9.5 8.5l1.75 2 1.75-2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CsvIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M4 2.5h5l3 3v8H4z" strokeLinejoin="round" />
      <path d="M9 2.5v3h3" strokeLinejoin="round" />
      <line x1="6" y1="8.5" x2="10" y2="8.5" />
      <line x1="6" y1="10.75" x2="10" y2="10.75" />
    </svg>
  );
}

export function ExcelIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
      <line x1="2.5" y1="6.25" x2="13.5" y2="6.25" />
      <line x1="2.5" y1="10" x2="13.5" y2="10" />
      <line x1="8" y1="2.5" x2="8" y2="13.5" />
    </svg>
  );
}

export function GridToolbarActions({ actions, onFitColumns }: { actions: GridExportActions; onFitColumns: () => void }) {
  return (
    <>
      {actions.notice && <span className="text-[length:var(--fs-sm)] text-brass mr-1">{actions.notice}</span>}
      <button className={btn} title="Reset column widths to fit their content" onClick={onFitColumns}>
        Fit columns
      </button>
      <button className={btn} title="Copy selection (or all) to clipboard" onClick={() => void actions.copy()}>
        Copy
      </button>
      <button
        className={iconBtn}
        title="Copy selection (or all) as a markdown table"
        aria-label="Copy as markdown table"
        onClick={() => void actions.copyMarkdown()}
      >
        <MarkdownIcon />
      </button>
      <button className={iconBtn} title="Save as CSV" aria-label="Save as CSV" onClick={() => void actions.exportFile("csv")}>
        <CsvIcon />
      </button>
      <button
        className={iconBtn}
        title="Open in Excel"
        aria-label="Open in Excel"
        onClick={() => void actions.exportFile("xlsx", { openAfter: true })}
      >
        <ExcelIcon />
      </button>
    </>
  );
}
