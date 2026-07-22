// Traces: BASED-EXPORT-CSV, BASED-EXPORT-XLSX
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ExcelJS from "exceljs";
import { toCsv, writeXlsx } from "@based/core";
import type { ColumnInfo, WireValue } from "@based/core";

describe("BASED-EXPORT-CSV: CSV export", () => {
  const cols: ColumnInfo[] = [
    { name: "a", type: "varchar" },
    { name: "b", type: "int" },
  ];

  test("quotes fields with commas, NULL as empty field", () => {
    expect(toCsv(cols, [[`x,y`, null]])).toBe(`a,b\r\n"x,y",\r\n`);
  });

  test("embedded quotes double", () => {
    expect(toCsv(cols, [[`he said "hi"`, 1]])).toBe(`a,b\r\n"he said ""hi""",1\r\n`);
  });

  test("newlines quoted, binary as summary", () => {
    const bin: WireValue = { $: "bin", len: 8, preview: "0x00" };
    expect(toCsv(cols, [["line1\nline2", bin]])).toBe(`a,b\r\n"line1\nline2",<binary 8 bytes>\r\n`);
  });
});

describe("BASED-EXPORT-XLSX: XLSX export", () => {
  test("round-trips header and cell values; NULL empty; numbers numeric", async () => {
    const path = join(tmpdir(), `based-spec-xlsx-${process.pid}-${Math.random().toString(36).slice(2)}.xlsx`);
    const cols: ColumnInfo[] = [
      { name: "name", type: "varchar" },
      { name: "n", type: "int" },
    ];
    await writeXlsx(path, cols, [
      ["alpha", 42],
      [null, 3.5],
    ]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path);
    const ws = wb.getWorksheet("Results")!;
    expect(ws.getCell("A1").value).toBe("name");
    expect(ws.getCell("B1").value).toBe("n");
    expect(ws.getCell("A2").value).toBe("alpha");
    expect(ws.getCell("B2").value).toBe(42);
    expect(ws.getCell("A3").value).toBeNull();
    expect(ws.getCell("B3").value).toBe(3.5);
  });

  test("strips XML-illegal chars so the file reads back without repair", async () => {
    const path = join(tmpdir(), `based-spec-xlsx-ctrl-${process.pid}-${Math.random().toString(36).slice(2)}.xlsx`);
    const cols: ColumnInfo[] = [{ name: "s", type: "varchar" }];
    // Between "a" and "b": NUL, a lone high surrogate, and U+FFFF — all XML-1.0-illegal.
    // Without sanitization ExcelJS writes these raw and even its own reader throws on the file.
    await writeXlsx(path, cols, [["a\x00\uD83D￿b"], ["ok 😀 emoji"]]);

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(path); // must not throw
    const ws = wb.getWorksheet("Results")!;
    expect(ws.getCell("A2").value).toBe("ab");
    expect(ws.getCell("A3").value).toBe("ok 😀 emoji"); // valid surrogate pairs survive
  });
});
