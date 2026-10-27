// Traces: BASED-BATCH-GO
import { describe, expect, test } from "bun:test";
import { splitBatches, splitBatchesWithLines } from "@based/core";

describe("BASED-BATCH-GO: GO batch splitting", () => {
  test("splits on GO lines", () => {
    expect(splitBatches("SELECT 1\nGO\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("case-insensitive, whitespace and trailing line comment allowed", () => {
    expect(splitBatches("SELECT 1\n  go  -- comment\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
    expect(splitBatches("SELECT 1\r\nGo\r\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  test("GO not alone on a line is not a separator", () => {
    expect(splitBatches("SELECT 'GO'")).toEqual(["SELECT 'GO'"]);
    expect(splitBatches("SELECT 1 GO")).toEqual(["SELECT 1 GO"]);
  });

  test("empty batches dropped", () => {
    expect(splitBatches("SELECT 1\nGO\n\nGO")).toEqual(["SELECT 1"]);
    expect(splitBatches("")).toEqual([]);
  });
});

// Traces: BASED-UI-QUERY-ERROR — batch start lines map SQL Server's batch-relative error lines back
// onto the editor.
describe("splitBatchesWithLines", () => {
  test("each batch carries the submitted-text line of its first non-blank line", () => {
    const sql = ["", "SELECT 1", "GO", "", "", "SELECT 2", "SELECT 3", "go -- end", "SELECT 4"].join("\n");
    expect(splitBatchesWithLines(sql)).toEqual([
      { text: "SELECT 1", startLine: 2 },
      { text: "SELECT 2\nSELECT 3", startLine: 6 },
      { text: "SELECT 4", startLine: 9 },
    ]);
  });
});
