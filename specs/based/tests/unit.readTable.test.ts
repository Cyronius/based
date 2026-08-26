// Traces: BASED-AGENT-READ-ROWS, BASED-LANCE-SCAN, BASED-AGENT-SURFACE-VARIANT
// read_table — the one "give me rows" tool. It absorbed the old sample_rows (an unordered peek is
// just a small page with no filter) and gained a `where` predicate on engines that support one,
// which is what makes a filtered scan possible on a connection with no SQL at all.
//
// Paging cap, hasMore heuristic, engine-appropriate namespace, and — the point of the variant work —
// the fact that a parameter the engine can't honour is ABSENT rather than accepted-then-refused.
// All against a fake adapter (no DB).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSurfaceFor, AuditStore, openDb } from "@based/core";
import type { DatabaseAdapter, EngineCapabilities, TablePage, ToolDeps } from "@based/core";

interface Call {
  schema: string;
  table: string;
  opts: { offset: number; limit: number; orderBy?: unknown; filters?: unknown; where?: string };
}

const MSSQL: EngineCapabilities = {
  sql: true,
  search: false,
  write: true,
  createTable: false,
  orderedBrowse: true,
  script: false,
  relations: false,
  engine: "mssql",
  variant: "mssql",
  containers: null,
  wherePredicate: false,
  structuredFilters: true,
  countRows: true,
  takeByKey: false,
  indexIntrospect: false,
};

const LANCE: EngineCapabilities = {
  ...MSSQL,
  write: false,
  search: true,
  orderedBrowse: false,
  engine: "lancedb",
  variant: "lancedb-local",
  wherePredicate: true,
  structuredFilters: false,
  takeByKey: true,
};

function fakeAdapter(
  rowCount: number,
  caps: EngineCapabilities,
): { adapter: DatabaseAdapter; calls: Call[]; countCalls: Array<{ where?: string }> } {
  const calls: Call[] = [];
  const countCalls: Array<{ where?: string }> = [];
  const adapter = {
    capabilities: caps,
    database: "d",
    async readTablePage(schema: string, table: string, pageOpts: Call["opts"]): Promise<TablePage> {
      calls.push({ schema, table, opts: pageOpts });
      const remaining = Math.max(0, rowCount - pageOpts.offset);
      const n = Math.min(remaining, pageOpts.limit);
      return {
        columns: [
          { name: "id", type: "int", maxLength: null, precision: null, scale: null, nullable: false, isPrimaryKey: true, isForeignKey: false, fkTarget: null },
        ],
        rows: Array.from({ length: n }, (_, i) => [pageOpts.offset + i]),
        orderBy: ["id"],
      };
    },
    async countRows(_schema: string, _table: string, countOpts?: { where?: string }) {
      countCalls.push({ where: countOpts?.where });
      return rowCount;
    },
  } as unknown as DatabaseAdapter;
  return { adapter, calls, countCalls };
}

function deps(adapter: DatabaseAdapter): ToolDeps {
  return {
    getAdapter: () => adapter,
    connectionId: () => "c",
    database: () => "d",
    audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-readtable-")), "app.db"))),
  };
}

type Tool = { execute: (args: unknown, x: unknown) => Promise<unknown>; inputSchema?: { shape?: Record<string, unknown> } };

function toolsFor(adapter: DatabaseAdapter, caps: EngineCapabilities) {
  return agentSurfaceFor(caps, deps(adapter)).tools as Record<string, Tool>;
}

describe("BASED-AGENT-READ-ROWS: read_table paging", () => {
  test("limit clamps to 200 and defaults to 100; offset forwards verbatim", async () => {
    const { adapter, calls } = fakeAdapter(1000, MSSQL);
    const tool = toolsFor(adapter, MSSQL).read_table!;
    await tool.execute({ table: "T", limit: 500, offset: 40 }, {} as never);
    expect(calls[0]!.opts.limit).toBe(200);
    expect(calls[0]!.opts.offset).toBe(40);
    await tool.execute({ table: "T" }, {} as never);
    expect(calls[1]!.opts.limit).toBe(100);
    expect(calls[1]!.opts.offset).toBe(0);
  });

  test("a full page reports hasMore: true; a short page reports hasMore: false", async () => {
    const { adapter } = fakeAdapter(150, MSSQL);
    const tool = toolsFor(adapter, MSSQL).read_table!;
    const full = (await tool.execute({ table: "T", limit: 100 }, {} as never)) as { hasMore: boolean; returned: number };
    expect(full.returned).toBe(100);
    expect(full.hasMore).toBe(true);
    const short = (await tool.execute({ table: "T", limit: 100, offset: 100 }, {} as never)) as {
      hasMore: boolean;
      returned: number;
      orderBy: string[];
    };
    expect(short.returned).toBe(50);
    expect(short.hasMore).toBe(false);
    expect(short.orderBy).toEqual(["id"]);
  });

  test("a small limit with no filter reproduces the old sample_rows peek", async () => {
    // sample_rows was removed, not lost: this is the same call, under the name the agent already
    // uses for every other read.
    const { adapter, calls } = fakeAdapter(500, LANCE);
    const rows = (await toolsFor(adapter, LANCE).read_table!.execute({ table: "T", limit: 20 }, {} as never)) as {
      returned: number;
    };
    expect(rows.returned).toBe(20);
    expect(calls[0]!.opts.where).toBeUndefined();
  });

  test("the namespace defaults to dbo on mssql and empty on lancedb", async () => {
    const mssql = fakeAdapter(1, MSSQL);
    await toolsFor(mssql.adapter, MSSQL).read_table!.execute({ table: "T" }, {} as never);
    expect(mssql.calls[0]!.schema).toBe("dbo");
    const lance = fakeAdapter(1, LANCE);
    await toolsFor(lance.adapter, LANCE).read_table!.execute({ table: "T" }, {} as never);
    expect(lance.calls[0]!.schema).toBe("");
  });

  test("each call writes an audit row (kind read)", async () => {
    const { adapter } = fakeAdapter(5, MSSQL);
    const d = deps(adapter);
    const tools = agentSurfaceFor(MSSQL, d).tools as Record<string, Tool>;
    await tools.read_table!.execute({ table: "T" }, {} as never);
    const entries = d.audit.list("c");
    expect(entries.length).toBe(1);
    expect(entries[0]!.kind).toBe("read");
    expect(entries[0]!.sql).toContain("read_table(dbo.T");
  });
});

describe("BASED-AGENT-SURFACE-VARIANT: unsupported filtering is absent, not refused", () => {
  test("orderBy/filters forward on a structured-filter engine", async () => {
    const ordered = fakeAdapter(10, MSSQL);
    const ok = (await toolsFor(ordered.adapter, MSSQL).read_table!.execute(
      { table: "T", orderBy: [{ column: "id", dir: "desc" }], filters: [{ column: "id", op: "gt", value: 3 }] },
      {} as never,
    )) as { error?: string };
    expect(ok.error).toBeUndefined();
    expect(ordered.calls[0]!.opts.orderBy).toEqual([{ column: "id", dir: "desc" }]);
    expect(ordered.calls[0]!.opts.filters).toEqual([{ column: "id", op: "gt", value: 3 }]);
  });

  test("an engine without structured filters never advertises orderBy/filters", async () => {
    // The old behaviour accepted them and returned an error string. That taught the agent the
    // parameters exist and cost it a turn to find out otherwise; now they simply aren't there.
    const { adapter } = fakeAdapter(10, LANCE);
    const params = Object.keys(toolsFor(adapter, LANCE).read_table!.inputSchema?.shape ?? {});
    expect(params).not.toContain("orderBy");
    expect(params).not.toContain("filters");
  });
});

describe("BASED-LANCE-SCAN: filtered scan on an engine with no SQL", () => {
  test("`where` reaches the adapter, so filtering never needs a throwaway search", async () => {
    const { adapter, calls } = fakeAdapter(10, LANCE);
    await toolsFor(adapter, LANCE).read_table!.execute({ table: "T", where: "source = 'discord'" }, {} as never);
    expect(calls[0]!.opts.where).toBe("source = 'discord'");
  });

  test("`where` is audited, so a filtered read is reconstructable from the log", async () => {
    const { adapter } = fakeAdapter(10, LANCE);
    const d = deps(adapter);
    const tools = agentSurfaceFor(LANCE, d).tools as Record<string, Tool>;
    await tools.read_table!.execute({ table: "T", where: "year > 2020" }, {} as never);
    expect(d.audit.list("c")[0]!.sql).toContain("where=year > 2020");
  });

  test("count_rows forwards the same predicate", async () => {
    const { adapter, countCalls } = fakeAdapter(42, LANCE);
    const result = (await toolsFor(adapter, LANCE).count_rows!.execute({ table: "T", where: "x > 1" }, {} as never)) as {
      count: number;
    };
    expect(result.count).toBe(42);
    expect(countCalls[0]!.where).toBe("x > 1");
  });

  // A model that means "no filter" fills the optional `where` with "" as readily as it omits it —
  // the tool schema reaches it as `anyOf: [string, null]`. An empty predicate is not a filter, and
  // forwarding one reaches the Lance parser as a bare WHERE ("Expected: an expression, found: EOF").
  test("a blank `where` counts the whole table instead of erroring", async () => {
    const { adapter, countCalls } = fakeAdapter(42, LANCE);
    const result = (await toolsFor(adapter, LANCE).count_rows!.execute({ table: "T", where: "" }, {} as never)) as {
      count: number;
      error?: string;
    };
    expect(result.error).toBeUndefined();
    expect(result.count).toBe(42);
    expect(countCalls[0]!.where).toBeUndefined();
  });

  test("a whitespace-only `where` is dropped by read_table too, and left out of the audit line", async () => {
    const { adapter, calls } = fakeAdapter(10, LANCE);
    const d = deps(adapter);
    const tools = agentSurfaceFor(LANCE, d).tools as Record<string, Tool>;
    await tools.read_table!.execute({ table: "T", where: "   " }, {} as never);
    expect(calls[0]!.opts.where).toBeUndefined();
    expect(d.audit.list("c")[0]!.sql).not.toContain("where=");
  });

  test("`columns` projects the returned page", async () => {
    const { adapter } = fakeAdapter(3, LANCE);
    const page = (await toolsFor(adapter, LANCE).read_table!.execute({ table: "T", columns: ["id"] }, {} as never)) as {
      columns: string[];
    };
    expect(page.columns).toEqual(["id"]);
  });
});
