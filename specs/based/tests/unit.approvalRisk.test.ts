// Traces: BASED-APPROVAL-RISK
// The approval card flags statements that change every row or remove data. A miss here is silent:
// the card looks routine and the user approves a whole-table write.
import { describe, expect, test } from "bun:test";
import { describeStatements, isDestructive } from "../../../ui/src/lib/sqlText";

describe("BASED-APPROVAL-RISK describeStatements", () => {
  test("UPDATE with and without WHERE", () => {
    expect(describeStatements("UPDATE dbo.Orders SET status = 'x' WHERE id = 1")).toEqual([{ kind: "UPDATE", table: "dbo.Orders", noWhere: false }]);
    expect(describeStatements("UPDATE [dbo].[Orders] SET status = 'x'")).toEqual([{ kind: "UPDATE", table: "dbo.Orders", noWhere: true }]);
  });

  test("DELETE with optional FROM", () => {
    expect(describeStatements("DELETE FROM t")).toEqual([{ kind: "DELETE", table: "t", noWhere: true }]);
    expect(describeStatements("delete t where id = 2")).toEqual([{ kind: "DELETE", table: "t", noWhere: false }]);
  });

  test("WHERE inside a string, comment, or subquery does not count", () => {
    expect(describeStatements("UPDATE t SET note = 'WHERE id = 1' -- WHERE x\n")[0]!.noWhere).toBe(true);
    expect(describeStatements("UPDATE t SET a = (SELECT b FROM u WHERE u.id = t.id)")[0]!.noWhere).toBe(true);
    expect(describeStatements("DELETE FROM t /* WHERE */")[0]!.noWhere).toBe(true);
  });

  test("a CTE-led DELETE takes the verb after the CTE list", () => {
    expect(describeStatements("WITH c AS (SELECT id FROM u WHERE x = 1) DELETE FROM t WHERE id IN (SELECT id FROM c)")).toEqual([
      { kind: "DELETE", table: "t", noWhere: false },
    ]);
  });

  test("batches split at ;, GO, and at a new verb with no separator", () => {
    const kinds = describeStatements("INSERT INTO a VALUES (1);\nGO\nUPDATE b SET x = 1 WHERE y = 2 DELETE FROM c").map((s) => [s.kind, s.noWhere]);
    expect(kinds).toEqual([
      ["INSERT", false],
      ["UPDATE", false],
      ["DELETE", true],
    ]);
  });

  test("INSERT … SELECT, MERGE, and ALTER … DROP stay one statement", () => {
    expect(describeStatements("INSERT INTO a SELECT * FROM b").map((s) => s.kind)).toEqual(["INSERT"]);
    expect(describeStatements("MERGE t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET x = s.x WHEN NOT MATCHED BY SOURCE THEN DELETE;").map((s) => s.kind)).toEqual(["MERGE"]);
    expect(describeStatements("ALTER TABLE t DROP COLUMN c").map((s) => s.kind)).toEqual(["ALTER"]);
  });

  test("TRUNCATE, DROP, TOP, and UPDATE STATISTICS", () => {
    expect(describeStatements("TRUNCATE TABLE dbo.Log")).toEqual([{ kind: "TRUNCATE", table: "dbo.Log", noWhere: false }]);
    expect(describeStatements("DROP TABLE IF EXISTS dbo.Tmp")).toEqual([{ kind: "DROP", table: "dbo.Tmp", noWhere: false }]);
    expect(describeStatements("DELETE TOP (10) FROM q")).toEqual([{ kind: "DELETE", table: "q", noWhere: false }]);
    expect(describeStatements("UPDATE STATISTICS dbo.Orders")[0]!.kind).toBe("OTHER");
  });

  test("isDestructive", () => {
    const d = (sql: string) => describeStatements(sql).some(isDestructive);
    expect(d("DROP VIEW v")).toBe(true);
    expect(d("TRUNCATE TABLE t")).toBe(true);
    expect(d("DELETE FROM t WHERE id = 1")).toBe(true);
    expect(d("UPDATE t SET a = 1")).toBe(true);
    expect(d("UPDATE t SET a = 1 WHERE id = 1")).toBe(false);
    expect(d("INSERT INTO t VALUES (1)")).toBe(false);
  });
});
