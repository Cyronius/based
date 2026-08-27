import { useEffect, useRef, useState } from "react";
import type { QueryTabState } from "../store";
import { useStore } from "../store";
import { computeSelectionSlice, type SelectionSlice } from "../gridSelectionText";
import { ResultGrid } from "./ResultGrid";
import { ResultText } from "./ResultText";
import { PlanView } from "./PlanView";
import { GridContextMenu } from "./GridContextMenu";
import { GridToolbarActions, useGridExportActions } from "./GridToolbarActions";
import { IconButton } from "./IconButton";
import { ChevronDownIcon } from "./icons";

type View = "grid" | "text" | "plan";

export function ResultsPane({
  tab,
  onCellTextChange,
  onCellActivate,
  onMinimize,
}: {
  tab: QueryTabState;
  onCellTextChange?: (text: string | null) => void;
  onCellActivate?: (text: string) => void;
  onMinimize?: () => void;
}) {
  const setActiveResult = useStore((s) => s.setActiveResult);
  const [view, setView] = useState<View>("grid");
  const selectionSliceRef = useRef<(() => SelectionSlice) | null>(null);
  const fitColumnsRef = useRef<() => void>(() => {});
  // Sorted/filtered view rows from the grid, so export/copy are WYSIWYG (BASED-GRID-SORT).
  const viewRowsRef = useRef<(() => QueryTabState["resultSets"][number]["rows"]) | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null);

  const rs = tab.resultSets[Math.min(tab.activeResult, tab.resultSets.length - 1)] ?? null;
  const hasPlan = !!tab.plan?.length;

  // One shared action set feeds both the toolbar buttons and the right-click context menu.
  const exportActions = useGridExportActions({
    columns: rs?.columns ?? [],
    getRows: () => viewRowsRef.current?.() ?? rs?.rows ?? [],
    getSlice: () => selectionSliceRef.current?.() ?? computeSelectionSlice(undefined, rs?.columns.length ?? 0),
  });

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
            <GridToolbarActions actions={exportActions} onFitColumns={() => fitColumnsRef.current()} />
          </>
        )}
        {onMinimize && (
          <IconButton size="sm" className="text-faint hover:text-paper" title="Minimize results" aria-label="Minimize results" onClick={onMinimize}>
            <ChevronDownIcon />
          </IconButton>
        )}
      </div>

      {rs?.truncated && (
        <div className="px-3 py-1 text-[length:var(--fs-sm)] bg-brass/10 text-brass border-b border-brass-soft/30 shrink-0">
          Result truncated for display: showing the first {rs.rows.length.toLocaleString()} of {rs.rowCount.toLocaleString()} rows.
          Sort and filters apply to the fetched rows only.
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
              onSelectionSlice={(fn) => {
                selectionSliceRef.current = fn;
              }}
              onViewRows={(fn) => {
                viewRowsRef.current = fn;
              }}
              onFitColumns={(fn) => {
                fitColumnsRef.current = fn;
              }}
              onCellTextChange={onCellTextChange}
              onCellActivate={onCellActivate}
              onCellContextMenu={setCtxMenu}
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
      {ctxMenu && <GridContextMenu x={ctxMenu.x} y={ctxMenu.y} actions={exportActions} onClose={() => setCtxMenu(null)} />}
    </div>
  );
}
