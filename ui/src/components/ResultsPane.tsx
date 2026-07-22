import { useRef, useState } from "react";
import type { QueryTabState } from "../store";
import { useStore } from "../store";
import { api } from "../api/client";
import { ResultGrid } from "./ResultGrid";
import { ResultText } from "./ResultText";

export function ResultsPane({ tab }: { tab: QueryTabState }) {
  const setActiveResult = useStore((s) => s.setActiveResult);
  const [view, setView] = useState<"grid" | "text">("grid");
  const [notice, setNotice] = useState<string | null>(null);
  const selectionDataRef = useRef<() => string>(() => "");

  const rs = tab.resultSets[Math.min(tab.activeResult, tab.resultSets.length - 1)] ?? null;

  async function doExport(format: "csv" | "xlsx", openAfter = false) {
    if (!rs) return;
    setNotice(openAfter ? "Opening…" : "Exporting…");
    try {
      const res = await api<{ path: string | null }>("/api/export", {
        method: "POST",
        body: JSON.stringify({ format, columns: rs.columns, rows: rs.rows, openAfter }),
      });
      setNotice(res.path ? (openAfter ? "Opened in Excel" : `Saved ${res.path.split(/[\\/]/).pop()}`) : null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
    setTimeout(() => setNotice(null), 4000);
  }

  async function doCopy() {
    if (!rs) return;
    await navigator.clipboard.writeText(selectionDataRef.current());
    setNotice("Copied");
    setTimeout(() => setNotice(null), 1500);
  }

  const btn =
    "px-2 py-0.5 text-[11px] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60 disabled:opacity-35";

  return (
    <div className="h-full flex flex-col bg-ink-900">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-line-soft shrink-0 overflow-x-auto">
        {tab.resultSets.map((s, i) => (
          <button
            key={i}
            className={`px-2 py-0.5 text-[11px] rounded ${
              i === tab.activeResult ? "bg-ink-800 text-brass border border-brass-soft/50" : "text-muted hover:text-paper border border-transparent"
            }`}
            onClick={() => setActiveResult(tab.id, i)}
          >
            Results {i + 1}
            <span className="text-faint ml-1 font-mono">{s.rowCount}</span>
          </button>
        ))}
        <div className="flex-1" />
        {notice && <span className="text-[11px] text-brass mr-1">{notice}</span>}
        {rs && (
          <>
            <span className="text-[11px] text-muted font-mono mr-1">
              {rs.complete ? `${rs.rowCount.toLocaleString()} rows` : `${rs.rows.length.toLocaleString()}…`}
              {tab.stats ? ` · ${tab.stats.durationMs.toLocaleString()} ms` : ""}
            </span>
            <div className="flex rounded border border-line overflow-hidden mr-1">
              <button
                className={`px-2 py-0.5 text-[11px] ${view === "grid" ? "bg-ink-800 text-brass" : "text-muted hover:text-paper"}`}
                onClick={() => setView("grid")}
              >
                Grid
              </button>
              <button
                className={`px-2 py-0.5 text-[11px] ${view === "text" ? "bg-ink-800 text-brass" : "text-muted hover:text-paper"}`}
                onClick={() => setView("text")}
              >
                Text
              </button>
            </div>
            <button className={btn} title="Copy selection (or all) to clipboard" onClick={() => void doCopy()}>
              Copy
            </button>
            <button className={btn} onClick={() => void doExport("csv")}>
              CSV
            </button>
            <button className={btn} onClick={() => void doExport("xlsx")}>
              XLSX
            </button>
            <button className={btn} title="Export to a temp .xlsx and open it" onClick={() => void doExport("xlsx", true)}>
              Open in Excel
            </button>
          </>
        )}
      </div>

      {rs?.truncated && (
        <div className="px-3 py-1 text-[11px] bg-brass/10 text-brass border-b border-brass-soft/30 shrink-0">
          Result truncated for display: showing the first {rs.rows.length.toLocaleString()} of {rs.rowCount.toLocaleString()} rows.
        </div>
      )}

      <div className="flex-1 min-h-0">
        {rs ? (
          view === "grid" ? (
            <ResultGrid
              rs={rs}
              version={tab.version}
              onSelectionData={(fn) => {
                selectionDataRef.current = fn;
              }}
            />
          ) : (
            <ResultText rs={rs} version={tab.version} />
          )
        ) : (
          <div className="h-full grid place-items-center text-faint text-[12px] italic">
            {tab.running ? "Running…" : "No results — run a query (F5)."}
          </div>
        )}
      </div>
    </div>
  );
}
