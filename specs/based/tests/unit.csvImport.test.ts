// Traces: BASED-IMPORT-CSV-PARSE, BASED-IMPORT-CSV-COERCE, BASED-IMPORT-CSV-RUN (pure batch builder)
import { describe, expect, test } from "bun:test";
import { CsvParser, parseCsv } from "../../../core/src/import/csvParse";
import { coerceCsv } from "../../../core/src/import/coerce";
import { buildInsertBatches } from "../../../core/src/import/csvImport";
import type { TableColumn } from "@based/core";

function col(partial: Partial<TableColumn> & { name: string; type: string }): TableColumn {
  return {
    maxLength: null,
    precision: null,
    scale: null,
    nullable: false,
    isPrimaryKey: false,
    isForeignKey: false,
    fkTarget: null,
    ...partial,
  };
}

describe("BASED-IMPORT-CSV-PARSE: streaming RFC-4180", () => {
  test("quoted commas, escaped quotes, empty fields", () => {
    const rows = parseCsv('a,"b,1","he said ""hi"""\r\nc,,d');
    expect(rows).toEqual([
      ["a", "b,1", 'he said "hi"'],
      ["c", "", "d"],
    ]);
  });

  test("quoted field containing CRLF stays one field", () => {
    const rows = parseCsv('a,"line1\r\nline2",b\nnext,x,y');
    expect(rows.length).toBe(2);
    expect(rows[0]![1]).toBe("line1\r\nline2");
  });

  test("LF-only line endings", () => {
    expect(parseCsv("a,b\nc,d\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
  });

  test("chunk boundaries — even mid-quote — parse identically to one chunk", () => {
    const text = 'a,"b,1",c\r\n"d""e",f,g\r\n';
    const whole = parseCsv(text);
    for (let split = 1; split < text.length - 1; split++) {
      const p = new CsvParser();
      const rows = [...p.push(text.slice(0, split)), ...p.push(text.slice(split)), ...p.finish()];
      expect(rows).toEqual(whole);
    }
  });

  test("finish flushes an unterminated final row; empty input yields none", () => {
    const p = new CsvParser();
    expect(p.push("a,b")).toEqual([]);
    expect(p.finish()).toEqual([["a", "b"]]);
    const empty = new CsvParser();
    expect(empty.push("")).toEqual([]);
    expect(empty.finish()).toEqual([]);
  });
});

describe("BASED-IMPORT-CSV-COERCE", () => {
  test("numeric types parse with validation", () => {
    expect(coerceCsv(col({ name: "n", type: "int" }), "42", { nullEmpty: true })).toEqual({ value: 42 });
    expect(coerceCsv(col({ name: "n", type: "decimal" }), "1.5", { nullEmpty: true })).toEqual({ value: 1.5 });
    const bad = coerceCsv(col({ name: "n", type: "int" }), "x", { nullEmpty: true });
    expect("error" in bad && bad.error).toMatch(/n/);
  });

  test("bit accepts 0/1/true/false case-insensitively", () => {
    expect(coerceCsv(col({ name: "b", type: "bit" }), "true", { nullEmpty: true })).toEqual({ value: 1 });
    expect(coerceCsv(col({ name: "b", type: "bit" }), "0", { nullEmpty: true })).toEqual({ value: 0 });
    expect(coerceCsv(col({ name: "b", type: "bit" }), "FALSE", { nullEmpty: true })).toEqual({ value: 0 });
    const bad = coerceCsv(col({ name: "b", type: "bit" }), "no", { nullEmpty: true });
    expect("error" in bad).toBe(true);
  });

  test("empty-string handling", () => {
    expect(coerceCsv(col({ name: "s", type: "nvarchar", nullable: true }), "", { nullEmpty: true })).toEqual({ value: null });
    expect(coerceCsv(col({ name: "s", type: "nvarchar", nullable: true }), "", { nullEmpty: false })).toEqual({ value: "" });
    const bad = coerceCsv(col({ name: "n", type: "int", nullable: false }), "", { nullEmpty: true });
    expect("error" in bad).toBe(true);
  });

  test("other types pass through as strings", () => {
    expect(coerceCsv(col({ name: "d", type: "datetime2", nullable: true }), "2026-01-01", { nullEmpty: true })).toEqual({
      value: "2026-01-01",
    });
  });
});

describe("BASED-IMPORT-CSV-RUN: pure insert-batch builder", () => {
  test("packs rows per statement under the 2000-param budget", () => {
    const cols = ["a", "b", "c"]; // 3 params per row → 666 rows per statement
    const rows = Array.from({ length: 1500 }, (_, i) => [i, `n${i}`, null]);
    const batches = buildInsertBatches("dbo", "t", cols, rows);
    expect(batches.length).toBe(3); // 666 + 666 + 168
    for (const cmd of batches) {
      expect((cmd.params ?? []).length).toBeLessThanOrEqual(2000);
      expect(cmd.sql).toContain("INSERT INTO [dbo].[t] ([a], [b], [c]) VALUES");
    }
    // total params = rows × cols
    const total = batches.reduce((n, c) => n + (c.params ?? []).length, 0);
    expect(total).toBe(1500 * 3);
  });

  test("param placeholders line up with values (NULLs included)", () => {
    const batches = buildInsertBatches("dbo", "t", ["a", "b"], [[1, null]]);
    expect(batches.length).toBe(1);
    expect(batches[0]!.sql).toBe("INSERT INTO [dbo].[t] ([a], [b]) VALUES (@p0, @p1)");
    expect(batches[0]!.params).toEqual([
      { name: "p0", value: 1 },
      { name: "p1", value: null },
    ]);
  });

  test("wide tables still fit: 500 columns → 4 rows per statement", () => {
    const cols = Array.from({ length: 500 }, (_, i) => `c${i}`);
    const rows = Array.from({ length: 10 }, () => cols.map(() => "x"));
    const batches = buildInsertBatches("dbo", "t", cols, rows);
    expect(batches.length).toBe(3); // 4 + 4 + 2
    expect((batches[0]!.params ?? []).length).toBe(2000);
  });
});
