import { useEffect, useRef, useState } from "react";
import type { QueryTabState } from "../store";
import { useStore } from "../store";
import { ResultGrid } from "./ResultGrid";
import { ResultText } from "./ResultText";
import { PlanView } from "./PlanView";
import { GridToolbarActions } from "./GridToolbarActions";

type View = "grid" | "text" | "plan";

export function ResultsPane({ tab }: { tab: QueryTabState }) {
  const setActiveResult = useStore((s) => s.setActiveResult);
  const [view, setView] = useState<View>("grid");
  const selectionDataRef = useRef<() => string>(() => "");
  const fitColumnsRef = useRef<() => void>(() => {});

  const rs = tab.resultSets[Math.min(tab.activeResult, tab.resultSets.length - 1)] ?? null;
  const hasPlan = !!tab.plan?.length;

  // If a rerun without the Execution Plan toggle clears tab.plan, fall back off the Plan view.
  useEffect(() => {
    if (view === "plan" && !hasPlan) setView("grid");
  }, [view, hasPlan]);

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
        {rs && (
          <>
            <span className="text-[length:var(--fs-sm)] text-muted font-mono mr-1">
              {rs.complete ? `${rs.rowCount.toLocaleString()} rows` : `${rs.rows.length.toLocaleString()}…`}
              {tab.stats ? ` · ${tab.stats.durationMs.toLocaleString()} ms` : ""}
            </span>
            <GridToolbarActions
              columns={rs.columns}
              rows={rs.rows}
              getSelectionText={() => selectionDataRef.current()}
              onFitColumns={() => fitColumnsRef.current()}
            />
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
              onFitColumns={(fn) => {
                fitColumnsRef.current = fn;
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
