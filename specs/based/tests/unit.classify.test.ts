// Traces: BASED-AGENT-RUNQUERY (read-only classifier)
import { describe, expect, test } from "bun:test";
import { isReadOnly, firstKeyword } from "@based/core";

describe("BASED-AGENT-RUNQUERY: isReadOnly classifier", () => {
  test("plain SELECT and leading CTE are read-only", () => {
    expect(isReadOnly("SELECT * FROM t")).toBe(true);
    expect(isReadOnly("  select top 10 * from dbo.Customers")).toBe(true);
    expect(isReadOnly("WITH x AS (SELECT 1 AS a) SELECT * FROM x")).toBe(true);
  });

  test("mutating statements are not read-only", () => {
    for (const sql of [
      "INSERT INTO t (a) VALUES (1)",
      "UPDATE t SET a = 1",
      "DELETE FROM t",
      "DROP TABLE t",
      "TRUNCATE TABLE t",
      "MERGE INTO t USING s ON t.id = s.id WHEN MATCHED THEN UPDATE SET a = 1",
      "EXEC sp_who",
      "CREATE TABLE t (a int)",
      "ALTER TABLE t ADD b int",
      "SELECT * INTO backup FROM t", // SELECT ... INTO creates a table
    ]) {
      expect(isReadOnly(sql)).toBe(false);
    }
  });

  test("a CTE that leads into a mutation is not read-only", () => {
    expect(isReadOnly("WITH x AS (SELECT id FROM t) DELETE FROM t WHERE id IN (SELECT id FROM x)")).toBe(false);
  });

  test("insensitive to case, whitespace, and comments", () => {
    expect(isReadOnly("-- pull the rows\nSELECT 1")).toBe(true);
    expect(isReadOnly("/* header */ update t set a=1")).toBe(false);
    expect(isReadOnly("\n\t select 1")).toBe(true);
  });

  test("keywords inside string literals do not trigger a false positive or negative", () => {
    expect(isReadOnly("SELECT 'DROP TABLE t' AS note")).toBe(true);
    expect(isReadOnly("SELECT * FROM Orders WHERE status = 'UPDATE'")).toBe(true);
  });

  test("empty / non-statement is not read-only", () => {
    expect(isReadOnly("")).toBe(false);
    expect(isReadOnly("   ")).toBe(false);
  });

  test("firstKeyword extracts the leading token", () => {
    expect(firstKeyword("  (SELECT 1)")).toBe("SELECT");
    expect(firstKeyword("-- x\nWITH a AS (SELECT 1) SELECT * FROM a")).toBe("WITH");
    expect(firstKeyword("update t set a=1")).toBe("UPDATE");
  });
});
