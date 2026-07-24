// Copy / Fit-columns / CSV / Excel actions shared by the SQL results toolbar (ResultsPane) and the
// Data tab toolbar (TableDataGrid) — extracted so both grids get export/copy for free.
import { useState } from "react";
import { api } from "../api/client";
import type { WireValue } from "../api/types";

const btn =
  "px-2 py-0.5 text-[length:var(--fs-sm)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60 disabled:opacity-35";
const iconBtn =
  "grid place-items-center h-[22px] w-[26px] rounded border border-line text-muted hover:text-brass hover:border-brass-soft/60 disabled:opacity-35";

export function GridToolbarActions({
  columns,
  rows,
  getSelectionText,
  onFitColumns,
}: {
  columns: { name: string }[];
  rows: WireValue[][];
  getSelectionText: () => string;
  onFitColumns: () => void;
}) {
  const [notice, setNotice] = useState<string | null>(null);

  async function doExport(format: "csv" | "xlsx", openAfter = false) {
    setNotice(openAfter ? "Opening…" : "Exporting…");
    try {
      const res = await api<{ path: string | null }>("/api/export", {
        method: "POST",
        body: JSON.stringify({ format, columns, rows, openAfter }),
      });
      setNotice(res.path ? (openAfter ? "Opened in Excel" : `Saved ${res.path.split(/[\\/]/).pop()}`) : null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
    setTimeout(() => setNotice(null), 4000);
  }

  async function doCopy() {
    await navigator.clipboard.writeText(getSelectionText());
    setNotice("Copied");
    setTimeout(() => setNotice(null), 1500);
  }

  return (
    <>
      {notice && <span className="text-[length:var(--fs-sm)] text-brass mr-1">{notice}</span>}
      <button className={btn} title="Reset column widths to fit their content" onClick={onFitColumns}>
        Fit columns
      </button>
      <button className={btn} title="Copy selection (or all) to clipboard" onClick={() => void doCopy()}>
        Copy
      </button>
      <button className={iconBtn} title="Save as CSV" aria-label="Save as CSV" onClick={() => void doExport("csv")}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
          <path d="M4 2.5h5l3 3v8H4z" strokeLinejoin="round" />
          <path d="M9 2.5v3h3" strokeLinejoin="round" />
          <line x1="6" y1="8.5" x2="10" y2="8.5" />
          <line x1="6" y1="10.75" x2="10" y2="10.75" />
        </svg>
      </button>
      <button className={iconBtn} title="Open in Excel" aria-label="Open in Excel" onClick={() => void doExport("xlsx", true)}>
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
          <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
          <line x1="2.5" y1="6.25" x2="13.5" y2="6.25" />
          <line x1="2.5" y1="10" x2="13.5" y2="10" />
          <line x1="8" y1="2.5" x2="8" y2="13.5" />
        </svg>
      </button>
    </>
  );
}
