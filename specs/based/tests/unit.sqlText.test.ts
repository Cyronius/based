// Traces: BASED-UI-READONLY-MIRROR
// The webview's isReadOnly decides whether chat SQL gets Run or Open; it must agree with core's
// classifier, which gates the agent's run_query.
import { describe, expect, test } from "bun:test";
import { isReadOnly as uiIsReadOnly } from "../../../ui/src/lib/sqlText";
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
