// Traces: BASED-AGENT-EXPORT — the collect/write pipeline and filename sanitization, against a
// fake adapter (no DB, no dialogs). The end-to-end tool path is covered in integration.lancedb.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportData, sanitizeExportFileName, toCsv } from "@based/core";
import type { DatabaseAdapter, TablePage } from "@based/core";

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
