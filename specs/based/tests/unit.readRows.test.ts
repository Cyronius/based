// Traces: BASED-AGENT-READ-ROWS — paged reads with a per-call cap, hasMore heuristic, and
// engine-appropriate default schema, all against a fake adapter (no DB).
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSurfaceFor, AuditStore, openDb } from "@based/core";
import type { DatabaseAdapter, TablePage, ToolDeps } from "@based/core";

interface Call {
  schema: string;
  table: string;
  opts: { offset: number; limit: number; orderBy?: unknown; filters?: unknown };
}

function fakeAdapter(rowCount: number, opts?: { orderedBrowse?: boolean }): { adapter: DatabaseAdapter; calls: Call[] } {
  const calls: Call[] = [];
  const adapter = {
    capabilities: { sql: true, search: false, write: true, orderedBrowse: opts?.orderedBrowse ?? true, script: false, relations: false },
    database: "d",
    async readTablePage(schema: string, table: string, pageOpts: { offset: number; limit: number }): Promise<TablePage> {
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
  } as unknown as DatabaseAdapter;
  return { adapter, calls };
}

function deps(adapter: DatabaseAdapter): ToolDeps {
  return {
    getAdapter: () => adapter,
    connectionId: () => "c",
    database: () => "d",
    audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-readrows-")), "app.db"))),
  };
}

function readRowsTool(adapter: DatabaseAdapter, engine: "mssql" | "lancedb" = "mssql") {
  const tools = agentSurfaceFor(engine, deps(adapter)).tools as Record<string, { execute: (args: unknown, x: unknown) => Promise<unknown> }>;
  return tools.read_rows!;
}

describe("BASED-AGENT-READ-ROWS: read_rows paging tool", () => {
  test("limit clamps to 200 and defaults to 100; offset forwards verbatim", async () => {
    const { adapter, calls } = fakeAdapter(1000);
    const tool = readRowsTool(adapter);
    await tool.execute({ table: "T", limit: 500, offset: 40 }, {} as never);
    expect(calls[0]!.opts.limit).toBe(200);
    expect(calls[0]!.opts.offset).toBe(40);
    await tool.execute({ table: "T" }, {} as never);
    expect(calls[1]!.opts.limit).toBe(100);
    expect(calls[1]!.opts.offset).toBe(0);
  });

  test("a full page reports hasMore: true; a short page reports hasMore: false", async () => {
    const { adapter } = fakeAdapter(150);
    const tool = readRowsTool(adapter);
    const full = (await tool.execute({ table: "T", limit: 100 }, {} as never)) as { hasMore: boolean; returned: number };
    expect(full.returned).toBe(100);
    expect(full.hasMore).toBe(true);
    const short = (await tool.execute({ table: "T", limit: 100, offset: 100 }, {} as never)) as { hasMore: boolean; returned: number; orderBy: string[] };
    expect(short.returned).toBe(50);
    expect(short.hasMore).toBe(false);
    expect(short.orderBy).toEqual(["id"]);
  });

  test("default schema is dbo on mssql and empty on lancedb", async () => {
    const mssql = fakeAdapter(1);
    await readRowsTool(mssql.adapter, "mssql").execute({ table: "T" }, {} as never);
    expect(mssql.calls[0]!.schema).toBe("dbo");
    const lance = fakeAdapter(1);
    await readRowsTool(lance.adapter, "lancedb").execute({ table: "T" }, {} as never);
    expect(lance.calls[0]!.schema).toBe("");
  });

  test("orderBy/filters forward on an orderedBrowse engine and error without one (no adapter call)", async () => {
    const ordered = fakeAdapter(10, { orderedBrowse: true });
    const ok = (await readRowsTool(ordered.adapter).execute(
      { table: "T", orderBy: [{ column: "id", dir: "desc" }], filters: [{ column: "id", op: "gt", value: 3 }] },
      {} as never,
    )) as { error?: string };
    expect(ok.error).toBeUndefined();
    expect(ordered.calls[0]!.opts.orderBy).toEqual([{ column: "id", dir: "desc" }]);
    expect(ordered.calls[0]!.opts.filters).toEqual([{ column: "id", op: "gt", value: 3 }]);

    const unordered = fakeAdapter(10, { orderedBrowse: false });
    const err = (await readRowsTool(unordered.adapter).execute(
      { table: "T", orderBy: [{ column: "id", dir: "desc" }] },
      {} as never,
    )) as { error?: string };
    expect(err.error).toBeTruthy();
    expect(unordered.calls.length).toBe(0);
  });

  test("each call writes an audit row (kind read)", async () => {
    const { adapter } = fakeAdapter(5);
    const d = deps(adapter);
    const tools = agentSurfaceFor("mssql", d).tools as Record<string, { execute: (args: unknown, x: unknown) => Promise<unknown> }>;
    await tools.read_rows!.execute({ table: "T" }, {} as never);
    const entries = d.audit.list("c");
    expect(entries.length).toBe(1);
    expect(entries[0]!.kind).toBe("read");
    expect(entries[0]!.sql).toContain("read_rows(dbo.T");
  });
});
