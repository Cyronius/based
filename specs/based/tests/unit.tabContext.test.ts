// Traces: BASED-AGENT-TAB-CONTEXT — the server-side renderer for the client's workspace snapshot.
// (The UI-side builders are covered in unit.uiTabContext.test.ts.)
import { describe, expect, test } from "bun:test";
import { renderTabContext, buildAgent, GENERIC_CORE, agentInstructions, MSSQL_PERSONA, createAgentMemory } from "@based/core";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDeps } from "@based/core";

describe("BASED-AGENT-TAB-CONTEXT: renderTabContext", () => {
  test("absent or garbage input renders nothing", () => {
    expect(renderTabContext(null)).toBeNull();
    expect(renderTabContext(undefined)).toBeNull();
    expect(renderTabContext("nope")).toBeNull();
    expect(renderTabContext(42)).toBeNull();
    expect(renderTabContext({})).toBeNull();
    expect(renderTabContext({ activeTab: null, openTabs: [] })).toBeNull();
  });

  test("a valid snapshot renders the active tab, its SQL, result summaries, and the open-tab list", () => {
    const out = renderTabContext({
      activeTab: {
        id: "t1",
        kind: "query",
        title: "Query 1",
        sql: "SELECT * FROM dbo.Customers",
        lastRun: { status: "ok", durationMs: 42 },
        resultSummaries: [{ columns: ["id", "name"], rowCount: 500, truncated: true }],
      },
      openTabs: [
        { id: "t1", kind: "query", title: "Query 1" },
        { id: "table:dbo.Orders", kind: "table", title: "Orders" },
      ],
    })!;
    expect(out).toStartWith("<workspace_context>");
    expect(out).toEndWith("</workspace_context>");
    expect(out).toContain('Active tab: "Query 1" (query, id t1)');
    expect(out).toContain("SELECT * FROM dbo.Customers");
    expect(out).toContain("Last run: ok in 42 ms");
    expect(out).toContain("500 rows (truncated) [id, name]");
    expect(out).toContain('[table:dbo.Orders] table "Orders"');
  });

  test("oversized SQL truncates; >30 tabs truncate with a +N more marker; total is capped", () => {
    const bigSql = "SELECT " + "x".repeat(10_000);
    const tabs = Array.from({ length: 40 }, (_, i) => ({ id: `t${i}`, kind: "query", title: `Q${i}` }));
    const out = renderTabContext({ activeTab: { id: "t0", kind: "query", title: "Q0", sql: bigSql }, openTabs: tabs })!;
    expect(out).toContain("…truncated…");
    expect(out).toContain("(+10 more)");
    expect(out.length).toBeLessThanOrEqual(8_200); // 8,000 body cap + wrapper/marker slack
    expect(out).not.toContain("t35"); // beyond the 30-tab cap
  });
});

describe("BASED-AGENT-TAB-CONTEXT: buildAgent contextNote", () => {
  const deps: ToolDeps = {
    getAdapter: () => {
      throw new Error("no adapter in this test");
    },
    connectionId: () => "c",
    database: () => "d",
    audit: { add() {} } as never,
  };
  const memory = createAgentMemory(join(mkdtempSync(join(tmpdir(), "based-ctx-")), "agent.db"));
  const model = { modelId: "test", provider: "test" } as never;

  test("contextNote is appended to the instructions; omitting it reproduces the prior text exactly", async () => {
    const note = "<workspace_context>\nActive tab: none\n</workspace_context>";
    const withNote = buildAgent({ model, memory, engine: "mssql", toolDeps: deps, contextNote: note });
    const without = buildAgent({ model, memory, engine: "mssql", toolDeps: deps });
    expect(await withNote.getInstructions()).toBe(`${agentInstructions(GENERIC_CORE, MSSQL_PERSONA)}\n\n${note}`);
    expect(await without.getInstructions()).toBe(agentInstructions(GENERIC_CORE, MSSQL_PERSONA));
  });
});
