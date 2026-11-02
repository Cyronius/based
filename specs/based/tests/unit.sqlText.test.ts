// Traces: BASED-UI-READONLY-MIRROR, BASED-RUN-SCOPE
// The webview's isReadOnly decides whether chat SQL gets Run or Open; it must agree with core's
// classifier, which gates the agent's run_query. statementAt picks what Ctrl+Enter runs.
import { describe, expect, test } from "bun:test";
import { isReadOnly as uiIsReadOnly, statementAt } from "../../../ui/src/lib/sqlText";
import { isReadOnly as coreIsReadOnly } from "../../../core/src/db/classify";

const CASES: Array<[string, boolean]> = [
  ["SELECT * FROM dbo.Orders", true],
  ["  (SELECT 1)", true],
  ["WITH c AS (SELECT 1 AS x) SELECT x FROM c", true],
  ["WITH c AS (SELECT 1 AS x) DELETE FROM t WHERE id IN (SELECT x FROM c)", false],
  ["SELECT * INTO dbo.Copy FROM dbo.Orders", false],
  ["EXEC dbo.DoThing", false],
  ["UPDATE t SET a = 1", false],
  ["SELECT 'DROP TABLE x' AS s", true],
  ["SELECT 1 -- then DELETE everything", true],
  ["/* UPDATE */ SELECT 1", true],
  ["SELECT 1; DROP TABLE t", false],
  ["", false],
  ["-- only a comment", false],
];

describe("BASED-UI-READONLY-MIRROR: ui isReadOnly mirrors core classify", () => {
  for (const [sql, expected] of CASES) {
    test(JSON.stringify(sql), () => {
      expect(uiIsReadOnly(sql)).toBe(expected);
      expect(coreIsReadOnly(sql)).toBe(expected);
    });
  }
});

/** The statement text Ctrl+Enter would run with the cursor at the `|` marker. */
function runAt(marked: string): string | null {
  const offset = marked.indexOf("|");
  const sql = marked.slice(0, offset) + marked.slice(offset + 1);
  const span = statementAt(sql, offset);
  return span ? sql.slice(span.start, span.end) : null;
}

describe("BASED-RUN-SCOPE: statementAt", () => {
  test("picks the statement under the cursor among `;`-separated ones", () => {
    expect(runAt("SELECT 1;\nSELECT |2;\nSELECT 3;")).toBe("SELECT 2;");
    expect(runAt("SELECT |1; SELECT 2;")).toBe("SELECT 1;");
  });

  test("a cursor just past `;` or in trailing spaces stays on that statement", () => {
    expect(runAt("SELECT 1;|\nSELECT 2;")).toBe("SELECT 1;");
    expect(runAt("SELECT 1;   |\nSELECT 2;")).toBe("SELECT 1;");
  });

  test("GO lines separate batches", () => {
    expect(runAt("SELECT 1\nGO\nSELECT |2\ngo -- end\nSELECT 3")).toBe("SELECT 2");
    expect(runAt("SELECT |1\r\nGO\r\nSELECT 2")).toBe("SELECT 1");
  });

  test("`;` inside strings, comments, brackets, and parens does not split", () => {
    expect(runAt("SELECT 'a;b' AS [x;y] -- c;d\n/* e;f */ FROM t|;\nSELECT 2;")).toBe(
      "SELECT 'a;b' AS [x;y] -- c;d\n/* e;f */ FROM t;",
    );
    expect(runAt("SELECT (SELECT 1; |) AS v;")).toBe("SELECT (SELECT 1; ) AS v;");
  });

  test("a procedure body with BEGIN…END stays whole; BEGIN TRAN does not open a block", () => {
    const proc = "CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\n  SELECT |CASE WHEN 1=1 THEN 2 END;\nEND;";
    expect(runAt(proc)).toBe(proc.replace("|", ""));
    expect(runAt("BEGIN TRAN;\nUPDATE t SET a = |1;\nCOMMIT;")).toBe("UPDATE t SET a = 1;");
  });

  test("a blank line between statements belongs to the next one; at the end, to the previous", () => {
    expect(runAt("SELECT 1;\n|\nSELECT 2;")).toBe("SELECT 2;");
    expect(runAt("SELECT 1;\n\n|")).toBe("SELECT 1;");
  });

  test("a single statement without `;` is the whole text; empty text has none", () => {
    expect(runAt("  SELECT *\n  FROM t|  ")).toBe("SELECT *\n  FROM t");
    expect(runAt("  | -- just a comment")).toBeNull();
  });
});
