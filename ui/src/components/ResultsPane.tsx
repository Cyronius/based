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
import { Tabs } from "./Tabs";
import { ChevronDownIcon } from "./icons";
import { ErrorDetail } from "./ErrorDetail";
import { revealLine } from "../editorModels";

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
      <div className="@container border-b border-line-soft shrink-0">
      <div className="flex flex-wrap items-center gap-1 px-2 py-1 min-w-0">
        <Tabs
          label="Results view"
          className="mr-2 shrink-0"
          tabs={views.map((v) => ({ id: v, label: v === "grid" ? "Grid" : v === "text" ? "Text" : "Plan" }))}
          value={view}
          onChange={setView}
        />

        {/* Traces: BASED-UI-RESULTS — set buttons only for a batch; only they scroll, the rest stays put. */}
        {tab.resultSets.length > 1 && (
        <div className="flex items-center gap-1 min-w-0 overflow-x-auto">
        {tab.resultSets.map((s, i) => (
          <button
            key={i}
            className={`shrink-0 whitespace-nowrap px-2 py-0.5 text-[length:var(--fs-sm)] rounded ${
              i === tab.activeResult ? "bg-ink-800 text-brass border border-brass-soft/50" : "text-muted hover:text-paper border border-transparent"
            }`}
            onClick={() => setActiveResult(tab.id, i)}
          >
            Results {i + 1}
            <span className="text-muted ml-1 font-mono">{s.rowCount}</span>
          </button>
        ))}
        </div>
        )}
        <div className="flex-1" />
        {rs && (
          <>
            <span className="shrink-0 whitespace-nowrap text-[length:var(--fs-sm)] text-muted font-mono mr-1">
              {rs.complete ? `${rs.rowCount.toLocaleString()} rows` : `${rs.rows.length.toLocaleString()}…`}
              {tab.stats && <span className="@max-md:hidden"> · {tab.stats.durationMs.toLocaleString()} ms</span>}
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
        ) : !tab.running && tab.queryErrors && tab.queryErrors.length > 0 ? (
          // Traces: BASED-UI-QUERY-ERROR — a failed run shows why here, not the "run a query" prompt.
          <div role="alert" className="h-full overflow-auto px-4 py-3 space-y-3 text-[length:var(--fs-base)]">
            {tab.queryErrors.map((e, i) => (
              <div key={i}>
                {e.line != null && (
                  <button className="mb-1 text-[length:var(--fs-sm)] text-muted hover:text-brass" title="Put the cursor on this line" onClick={() => revealLine(tab.id, e.line!)}>
                    Line {e.line} · go to line
                  </button>
                )}
                <ErrorDetail message={e.message} />
              </div>
            ))}
          </div>
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
