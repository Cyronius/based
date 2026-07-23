import { useEffect, useRef, useState } from "react";
import type { QueryTabState } from "../store";
import { useStore } from "../store";
import { api } from "../api/client";
import { ResultGrid } from "./ResultGrid";
import { ResultText } from "./ResultText";
import { PlanView } from "./PlanView";

type View = "grid" | "text" | "plan";

export function ResultsPane({ tab }: { tab: QueryTabState }) {
  const setActiveResult = useStore((s) => s.setActiveResult);
  const [view, setView] = useState<View>("grid");
  const [notice, setNotice] = useState<string | null>(null);
  const selectionDataRef = useRef<() => string>(() => "");

  const rs = tab.resultSets[Math.min(tab.activeResult, tab.resultSets.length - 1)] ?? null;
  const hasPlan = !!tab.plan?.length;

  // If a rerun without the Execution Plan toggle clears tab.plan, fall back off the Plan view.
  useEffect(() => {
    if (view === "plan" && !hasPlan) setView("grid");
  }, [view, hasPlan]);

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
    "px-2 py-0.5 text-[length:var(--fs-sm)] rounded border border-line text-muted hover:text-paper hover:border-brass-soft/60 disabled:opacity-35";
  const iconBtn =
    "grid place-items-center h-[22px] w-[26px] rounded border border-line text-muted hover:text-brass hover:border-brass-soft/60 disabled:opacity-35";

  const views: View[] = hasPlan ? ["grid", "text", "plan"] : ["grid", "text"];

  return (
    <div className="h-full flex flex-col bg-ink-900">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-line-soft shrink-0 overflow-x-auto">
        <div className="flex items-stretch h-6 border-r border-line-soft mr-2 shrink-0">
          {views.map((v) => (
            <button
              key={v}
              className={`px-2.5 border-r border-line-soft text-[length:var(--fs-sm)] capitalize ${
                view === v
                  ? "bg-ink-800 text-brass shadow-[inset_0_2px_0_var(--color-brass)]"
                  : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
              }`}
              onClick={() => setView(v)}
            >
              {v}
            </button>
          ))}
        </div>

        {tab.resultSets.map((s, i) => (
          <button
            key={i}
            className={`px-2 py-0.5 text-[length:var(--fs-sm)] rounded ${
              i === tab.activeResult ? "bg-ink-800 text-brass border border-brass-soft/50" : "text-muted hover:text-paper border border-transparent"
            }`}
            onClick={() => setActiveResult(tab.id, i)}
          >
            Results {i + 1}
            <span className="text-faint ml-1 font-mono">{s.rowCount}</span>
          </button>
        ))}
        <div className="flex-1" />
        {notice && <span className="text-[length:var(--fs-sm)] text-brass mr-1">{notice}</span>}
        {rs && (
          <>
            <span className="text-[length:var(--fs-sm)] text-muted font-mono mr-1">
              {rs.complete ? `${rs.rowCount.toLocaleString()} rows` : `${rs.rows.length.toLocaleString()}…`}
              {tab.stats ? ` · ${tab.stats.durationMs.toLocaleString()} ms` : ""}
            </span>
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
            <button
              className={iconBtn}
              title="Open in Excel"
              aria-label="Open in Excel"
              onClick={() => void doExport("xlsx", true)}
            >
              <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
                <rect x="2.5" y="2.5" width="11" height="11" rx="1" />
                <line x1="2.5" y1="6.25" x2="13.5" y2="6.25" />
                <line x1="2.5" y1="10" x2="13.5" y2="10" />
                <line x1="8" y1="2.5" x2="8" y2="13.5" />
              </svg>
            </button>
          </>
        )}
      </div>

      {rs?.truncated && (
        <div className="px-3 py-1 text-[length:var(--fs-sm)] bg-brass/10 text-brass border-b border-brass-soft/30 shrink-0">
          Result truncated for display: showing the first {rs.rows.length.toLocaleString()} of {rs.rowCount.toLocaleString()} rows.
        </div>
      )}

      <div className="flex-1 min-h-0">
        {view === "plan" && hasPlan ? (
          <PlanView plans={tab.plan!} />
        ) : rs ? (
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
          <div className="h-full grid place-items-center text-faint text-[length:var(--fs-base)] italic">
            {tab.running ? "Running…" : "No results — run a query (F5)."}
          </div>
        )}
      </div>
    </div>
  );
}
