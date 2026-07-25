// Traces: BASED-AGENT-TAB-CONTEXT (client half), BASED-AGENT-TAB-TOOLS
// Pure builders for the workspace snapshot that rides every agent send as
// forwardedProps.tabContext (rendered server-side into the instructions), and the row serializer
// the get_tab / open_query_tab frontend tools use. Runtime-import-free of the store (type-only
// imports are erased) so specs can unit-test these without a DOM.
import type { AppState, ResultSetData, TabState } from "../store";
import { cellText } from "../api/types";

/** Same visibility rule as the store's visibleTabs selector (hidden SQL-view tabs excluded) —
 *  duplicated here rather than imported so this module stays loadable without the store's
 *  window-bound dependency graph. */
function openTabList(tabs: TabState[]): TabState[] {
  return tabs.filter((t) => !(t.kind === "query" && t.parentTabId));
}

const CELL_CAP = 300;

export interface ResultSummary {
  columns: string[];
  rowCount: number;
  truncated: boolean;
}

export interface TabContextSnapshot {
  activeTab: Record<string, unknown> | null;
  openTabs: Array<{ id: string; kind: string; title: string }>;
}

function resultSummary(rs: ResultSetData): ResultSummary {
  return { columns: rs.columns.map((c) => c.name), rowCount: rs.rowCount, truncated: rs.truncated };
}

function activeTabSnapshot(tab: TabState): Record<string, unknown> {
  const base = { id: tab.id, kind: tab.kind, title: tab.title };
  if (tab.kind === "query") {
    return {
      ...base,
      sql: tab.content,
      lastRun: tab.stats ? { status: tab.stats.status, durationMs: tab.stats.durationMs } : null,
      resultSummaries: tab.resultSets.map(resultSummary),
    };
  }
  if (tab.kind === "table") return { ...base, schema: tab.schema, table: tab.table, view: tab.view };
  if (tab.kind === "routine") return { ...base, schema: tab.schema, name: tab.name };
  return base;
}

/** The per-send workspace snapshot (BASED-AGENT-TAB-CONTEXT's wire shape). */
export function buildTabContext(state: AppState): TabContextSnapshot {
  const open = openTabList(state.tabs);
  const active = state.tabs.find((t) => t.id === state.activeTabId) ?? null;
  return {
    activeTab: active ? activeTabSnapshot(active) : null,
    openTabs: open.map((t) => ({ id: t.id, kind: t.kind, title: t.title })),
  };
}

/** Serialize one result set for a tool response: bounded rows, stringified + capped cells. */
export function serializeResultRows(
  rs: ResultSetData,
  maxRows: number,
): { columns: string[]; rows: string[][]; rowCount: number; truncated: boolean } {
  const rows = rs.rows.slice(0, maxRows).map((row) =>
    row.map((v) => {
      const text = cellText(v);
      return text.length > CELL_CAP ? `${text.slice(0, CELL_CAP)}…` : text;
    }),
  );
  return {
    columns: rs.columns.map((c) => c.name),
    rows,
    rowCount: rs.rowCount,
    truncated: rs.truncated || rs.rows.length > maxRows,
  };
}
