// Traces: BASED-QUERY-BATCH-FAILURE
import { describe, expect, test } from "bun:test";
import { batchNote, resultSlots } from "../../../ui/src/lib/resultSlots";

const set = (rowCount: number, complete = true) => ({ rowCount, rows: new Array(complete ? 0 : rowCount), complete });

describe("BASED-QUERY-BATCH-FAILURE resultSlots", () => {
  test("a clean batch is one grid slot per result set", () => {
    const slots = resultSlots([set(40), set(1)], []);
    expect(slots.map((s) => s.label)).toEqual(["1 · 40 rows", "2 · 1 row"]);
  });

  test("a script that stops at statement 2 of 3 shows the grid, the failure, then the skipped rest", () => {
    const slots = resultSlots([set(1)], [{ afterResult: 1, statement: 2, statementCount: 3 }]);
    expect(slots.map((s) => [s.kind, s.label])).toEqual([
      ["grid", "1 · 1 row"],
      ["error", "Statement 2 failed"],
      ["skipped", "1 skipped"],
    ]);
  });

  test("a failure before any result set comes first", () => {
    const slots = resultSlots([], [{ afterResult: 0, statement: 1, statementCount: 4 }]);
    expect(slots.map((s) => s.label)).toEqual(["Statement 1 failed", "3 skipped"]);
  });

  test("a SQL Server batch error sits between the grids and skips nothing", () => {
    const slots = resultSlots([set(2), set(5)], [{ afterResult: 1, batch: 2 }]);
    expect(slots.map((s) => s.label)).toEqual(["1 · 2 rows", "Batch 2 failed", "2 · 5 rows"]);
  });

  test("two messages for one failure share one slot", () => {
    const slots = resultSlots([], [{ afterResult: 0, batch: 1 }, { afterResult: 0, batch: 1 }]);
    expect(slots).toEqual([{ kind: "error", errors: [0, 1], label: "Batch 1 failed" }]);
  });

  test("an error with no position is labelled Error", () => {
    expect(resultSlots([set(3)], [{ afterResult: 1 }]).map((s) => s.label)).toEqual(["1 · 3 rows", "Error"]);
  });
});

describe("BASED-QUERY-BATCH-FAILURE batchNote", () => {
  test("a stopped script names where it stopped", () => {
    expect(batchNote([{ afterResult: 1, statement: 2, statementCount: 3 }])).toBe("Stopped at statement 2 of 3");
  });

  test("errors with no statement position are counted", () => {
    expect(batchNote([{ afterResult: 0, batch: 1 }])).toBe("Finished with an error");
    expect(batchNote([{ afterResult: 0, batch: 1 }, { afterResult: 2, batch: 3 }])).toBe("Finished with 2 errors");
  });

  test("no errors, no note", () => {
    expect(batchNote([])).toBeNull();
  });
});
