// Traces: BASED-AGENT-EXPORT — the collect/write pipeline and filename sanitization, against a
// fake adapter (no DB, no dialogs). The end-to-end tool path is covered in integration.lancedb.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSurfaceFor, AuditStore, exportData, openDb, sanitizeExportFileName, toCsv } from "@based/core";
import type { DatabaseAdapter, EngineCapabilities, TablePage, ToolDeps } from "@based/core";

function fakeTableAdapter(rowCount: number): { adapter: DatabaseAdapter; pageCalls: number[] } {
  const pageCalls: number[] = [];
  const adapter = {
    capabilities: { sql: false, search: false, write: false, orderedBrowse: false, script: false, relations: false },
    database: "d",
    async readTablePage(_s: string, _t: string, opts: { offset: number; limit: number }): Promise<TablePage> {
      pageCalls.push(opts.offset);
      const remaining = Math.max(0, rowCount - opts.offset);
      const n = Math.min(remaining, opts.limit);
      return {
        columns: [
          { name: "a", type: "int", maxLength: null, precision: null, scale: null, nullable: false, isPrimaryKey: false, isForeignKey: false, fkTarget: null },
          { name: "b", type: "nvarchar", maxLength: 10, precision: null, scale: null, nullable: true, isPrimaryKey: false, isForeignKey: false, fkTarget: null },
        ],
        rows: Array.from({ length: n }, (_, i) => [opts.offset + i, `row ${opts.offset + i}`]),
        orderBy: [],
      };
    },
  } as unknown as DatabaseAdapter;
  return { adapter, pageCalls };
}

const dir = mkdtempSync(join(tmpdir(), "based-exportdata-"));

describe("BASED-AGENT-EXPORT: sanitizeExportFileName", () => {
  test("rejects directories and traversal", () => {
    expect(() => sanitizeExportFileName("a/b.csv", "csv")).toThrow();
    expect(() => sanitizeExportFileName("a\\b.csv", "csv")).toThrow();
    expect(() => sanitizeExportFileName("..secret", "csv")).toThrow();
    expect(() => sanitizeExportFileName("   ", "csv")).toThrow();
  });

  test("appends the format extension when missing and keeps it when present", () => {
    expect(sanitizeExportFileName("out", "csv")).toBe("out.csv");
    expect(sanitizeExportFileName("out.CSV", "csv")).toBe("out.CSV");
    expect(sanitizeExportFileName("report", "xlsx")).toBe("report.xlsx");
  });
});

describe("BASED-AGENT-EXPORT: exportData table source", () => {
  test("pages until a short page and writes CSV matching toCsv", async () => {
    const { adapter, pageCalls } = fakeTableAdapter(25);
    const target = join(dir, "small.csv");
    const result = await exportData(adapter, { kind: "table", schema: "", table: "T" }, "csv", target, { pageSize: 10 });
    expect(result.rowCount).toBe(25);
    expect(result.truncated).toBe(false);
    expect(pageCalls).toEqual([0, 10, 20]); // stops on the short (5-row) page
    const written = readFileSync(target, "utf8");
    expect(written.startsWith("a,b\r\n0,row 0\r\n")).toBe(true);
    // Exact writer parity with the UI export path.
    const { adapter: again } = fakeTableAdapter(25);
    const page = await again.readTablePage("", "T", { offset: 0, limit: 1000 });
    expect(written).toBe(toCsv(page.columns.map((c) => ({ name: c.name, type: c.type })), page.rows));
  });

  test("caps rows at rowCap and flags truncated", async () => {
    const { adapter } = fakeTableAdapter(50);
    const target = join(dir, "capped.csv");
    const result = await exportData(adapter, { kind: "table", schema: "", table: "T" }, "csv", target, { rowCap: 30, pageSize: 10 });
    expect(result.rowCount).toBe(30);
    expect(result.truncated).toBe(true);
  });

  test("sql source without capabilities.sql throws (nothing written)", async () => {
    const { adapter } = fakeTableAdapter(5);
    await expect(exportData(adapter, { kind: "sql", sql: "SELECT 1" }, "csv", join(dir, "no.csv"))).rejects.toThrow(/does not support SQL/);
  });
});

// The tool's own dispatch, one layer above the pipeline: which of sql/table the agent actually
// named. A model fills an optional string with "" as readily as it omits it — the tool schema
// reaches it as `anyOf: [string, null]` — so blank has to mean absent here, or naming exactly one
// source still trips the "provide exactly one" guard.
describe("BASED-AGENT-EXPORT: sql/table source selection", () => {
  const CAPS: EngineCapabilities = {
    sql: true,
    search: false,
    write: false,
    orderedBrowse: false,
    script: false,
    relations: false,
    engine: "lancedb",
    variant: "lancedb-local",
    containers: null,
    wherePredicate: true,
    structuredFilters: false,
    countRows: true,
    takeByKey: true,
    indexIntrospect: false,
  };

  function exportTool(adapter: DatabaseAdapter) {
    const deps: ToolDeps = {
      getAdapter: () => adapter,
      connectionId: () => "c",
      database: () => "d",
      audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-exporttool-")), "app.db"))),
      exportDir: () => dir,
    };
    return (agentSurfaceFor(CAPS, deps).tools as Record<string, { execute: (a: unknown, x: unknown) => Promise<unknown> }>)
      .export_data!;
  }

  test("a blank `sql` alongside a real `table` exports the table", async () => {
    const { adapter } = fakeTableAdapter(3);
    const result = (await exportTool(adapter).execute(
      { format: "csv", sql: "", table: "T", fileName: "blank-sql" },
      {} as never,
    )) as { error?: string; refused?: boolean; rowCount?: number };
    expect(result.error).toBeUndefined();
    expect(result.refused).toBeUndefined();
    expect(result.rowCount).toBe(3);
  });

  test("blank on both sides is still 'provide exactly one', not a downstream failure", async () => {
    const { adapter } = fakeTableAdapter(3);
    const result = (await exportTool(adapter).execute({ format: "csv", sql: "", table: "" }, {} as never)) as {
      error?: string;
    };
    expect(result.error).toContain("exactly one");
  });

  test("a real `sql` alongside a blank `table` exports the query", async () => {
    const { adapter } = fakeTableAdapter(3);
    // capabilities.sql is false on the fake adapter, so the pipeline refuses — but reaching that
    // refusal is the proof the sql branch was chosen rather than the XOR guard firing first.
    const result = (await exportTool(adapter).execute(
      { format: "csv", sql: "SELECT 1", table: "", fileName: "blank-table" },
      {} as never,
    )) as { error?: string };
    expect(result.error).toMatch(/does not support SQL/);
  });
});
