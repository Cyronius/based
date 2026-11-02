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
import { ChevronDownIcon, ErrorIcon } from "./icons";
import { ErrorDetail } from "./ErrorDetail";
import { revealLine } from "../editorModels";
import { batchNote, resultSlots } from "../lib/resultSlots";
import { plural } from "../lib/plural";

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

  const errors = tab.queryErrors ?? [];
  const slots = resultSlots(tab.resultSets, errors);
  const slotIndex = Math.min(tab.activeResult, slots.length - 1);
  const slot = slots[slotIndex] ?? null;
  const rs = slot?.kind === "grid" ? (tab.resultSets[slot.result] ?? null) : null;
  const note = !tab.running && slots.some((sl) => sl.kind === "grid") ? batchNote(errors) : null;
  const stopped = errors.find((e) => e.statement != null);
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

        {/* Traces: BASED-UI-RESULTS, BASED-QUERY-BATCH-FAILURE — slots only for a batch; only they scroll. */}
        {slots.length > 1 && (
          <div className="min-w-0 overflow-x-auto tab-scroll">
            <Tabs
              label="Result sets"
              tabs={slots.map((sl, i) => ({
                id: String(i),
                label:
                  sl.kind === "error" ? (
                    <span className="inline-flex items-center gap-1 text-err">
                      <ErrorIcon />
                      {sl.label}
                    </span>
                  ) : sl.kind === "skipped" ? (
                    <span className="text-faint italic">{sl.label}</span>
                  ) : (
                    <span className="font-mono">{sl.label}</span>
                  ),
              }))}
              value={String(slotIndex)}
              onChange={(v) => setActiveResult(tab.id, Number(v))}
            />
          </div>
        )}
        <div className="flex-1" />
        {note && (
          <span role="status" className="shrink-0 whitespace-nowrap text-[length:var(--fs-sm)] text-err font-bold mr-1">
            {note}
          </span>
        )}
        {rs && (
          <>
            <span className="shrink-0 whitespace-nowrap text-[length:var(--fs-sm)] text-muted font-mono mr-1">
              {rs.complete ? plural(rs.rowCount, "row") : `${rs.rows.length.toLocaleString()}…`}
              {tab.stats && <span className="@max-md:hidden"> · {tab.stats.durationMs.toLocaleString()} ms</span>}
            </span>
            <GridToolbarActions actions={exportActions} onFitColumns={() => fitColumnsRef.current()} />
          </>
        )}
        {onMinimize && (
          <IconButton className="text-faint hover:text-paper" title="Minimize results" aria-label="Minimize results" onClick={onMinimize}>
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
        ) : slot?.kind === "error" ? (
          // Traces: BASED-UI-QUERY-ERROR — a failed run shows why here, not the "run a query" prompt.
          <div role="alert" className="h-full overflow-auto px-4 py-3 space-y-3 text-[length:var(--fs-base)]">
            {slot.errors.map((i) => {
              const e = errors[i]!;
              return (
                <div key={i}>
                  {e.line != null && (
                    <button className="mb-1 text-[length:var(--fs-sm)] text-muted hover:text-brass" title="Put the cursor on this line" onClick={() => revealLine(tab.id, e.line!)}>
                      Line {e.line} · go to line
                    </button>
                  )}
                  <ErrorDetail message={e.message} />
                </div>
              );
            })}
          </div>
        ) : slot?.kind === "skipped" ? (
          <div className="h-full grid place-items-center text-muted text-[length:var(--fs-base)] px-4 text-center">
            {slot.count === 1 ? "1 statement did not run" : `${slot.count} statements did not run`} because statement {stopped?.statement} failed.
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
