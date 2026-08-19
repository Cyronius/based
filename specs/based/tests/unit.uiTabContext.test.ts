// Traces: BASED-AGENT-TAB-CONTEXT (client half), BASED-AGENT-THREADS, BASED-AGENT-TAB-TOOLS
// Pure UI-side pieces: the workspace snapshot builder + row serializer (tabContext) and the
// per-window thread-id derivation (threadIds). Imported by relative path like unit.sqlBlocks —
// both modules are deliberately free of window-bound runtime imports.
import { describe, expect, test } from "bun:test";
import { buildTabContext, serializeResultRows } from "../../../ui/src/agent/tabContext";
import { newChatThreadId } from "../../../ui/src/agent/threadIds";
import type { AppState, QueryTabState, ResultSetData, TabState } from "../../../ui/src/store";

function queryTab(over: Partial<QueryTabState> & { id: string }): QueryTabState {
  return {
    kind: "query",
    title: over.id,
    content: "",
    filePath: null,
    dirty: false,
    running: false,
    queryId: null,
    resultSets: [],
    activeResult: 0,
    output: [],
    stats: null,
    plan: null,
    version: 0,
    ...over,
  };
}

function rs(rows: unknown[][], over?: Partial<ResultSetData>): ResultSetData {
  return {
    columns: [
      { name: "id", type: "int" },
      { name: "name", type: "nvarchar" },
    ],
    rows: rows as never,
    rowCount: rows.length,
    truncated: false,
    complete: true,
    ...over,
  };
}

function stateWith(tabs: TabState[], activeTabId: string | null): AppState {
  return { tabs, activeTabId } as AppState;
}

describe("BASED-AGENT-TAB-CONTEXT: buildTabContext", () => {
  test("captures the active query tab's sql, stats, and result summaries plus the open-tab list", () => {
    const tab = queryTab({
      id: "q1",
      title: "Query 1",
      content: "SELECT 1",
      stats: { durationMs: 12, status: "ok" },
      resultSets: [rs([[1, "a"]], { rowCount: 500, truncated: true })],
    });
    const ctx = buildTabContext(stateWith([tab], "q1"));
    expect(ctx.activeTab).toMatchObject({ id: "q1", kind: "query", sql: "SELECT 1", lastRun: { status: "ok", durationMs: 12 } });
    expect((ctx.activeTab as { resultSummaries: unknown[] }).resultSummaries).toEqual([
      { columns: ["id", "name"], rowCount: 500, truncated: true },
    ]);
    expect(ctx.openTabs).toEqual([{ id: "q1", kind: "query", title: "Query 1" }]);
  });

  test("hidden SQL-view tabs (parentTabId) are excluded from openTabs; no active tab → null", () => {
    const hidden = queryTab({ id: "sql:table:dbo.T", parentTabId: "table:dbo.T" });
    const ctx = buildTabContext(stateWith([hidden], null));
    expect(ctx.activeTab).toBeNull();
    expect(ctx.openTabs).toEqual([]);
  });
});

describe("BASED-AGENT-TAB-TOOLS: serializeResultRows", () => {
  test("bounds rows, stringifies cells, and caps cell length at 300 chars", () => {
    const big = "x".repeat(400);
    const data = rs([
      [1, big],
      [2, "b"],
      [3, "c"],
    ]);
    const out = serializeResultRows(data, 2);
    expect(out.rows.length).toBe(2);
    expect(out.truncated).toBe(true); // 3 rows > maxRows 2
    expect(out.rows[0]![1]!.length).toBe(301); // 300 + ellipsis
    expect(out.rows[0]![0]).toBe("1"); // stringified
    expect(out.columns).toEqual(["id", "name"]);
  });

  test("summarizes vector cells instead of dumping them", () => {
    const data = rs([[1, { $: "vec", dim: 384, preview: [0.1, 0.2] }]]);
    const out = serializeResultRows(data, 10);
    // The UI's cellText grid summary form — never the raw embedding.
    expect(out.rows[0]![1]).toStartWith("vec[384]");
  });
});

describe("BASED-AGENT-THREADS: conversation thread ids", () => {
  test("mints unique per-conversation chat:{uuid} ids — no window or tab identity in the id", () => {
    const a = newChatThreadId();
    const b = newChatThreadId();
    expect(a).toMatch(/^chat:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).not.toBe(b);
  });
});
