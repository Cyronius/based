// Traces: BASED-TAB-AUTONAME-DERIVE
// Pure derivation of a query-tab title ("verb object") from SQL text — the tokenizing
// alternative to an AST walk, since T-SQL parsers choke on APPLY/hints/temp tables.
import { describe, it, expect } from "bun:test";
import { deriveTabTitle } from "../../../ui/src/lib/deriveTabTitle";

describe("BASED-TAB-AUTONAME-DERIVE: deriveTabTitle", () => {
  it("names a SELECT from the first depth-0 FROM identifier, last dotted segment", () => {
    expect(deriveTabTitle("SELECT c.Name FROM dbo.Customers c JOIN Orders o ON o.CustomerId = c.Id")).toBe(
      "select Customers",
    );
  });

  it("skips a CTE list and names from the main statement", () => {
    expect(deriveTabTitle("WITH cte AS (SELECT Id FROM A) SELECT * FROM cte JOIN B ON B.Id = cte.Id")).toBe(
      "select cte",
    );
  });

  it("skips multiple CTEs preceding a DML statement", () => {
    expect(deriveTabTitle("WITH a AS (SELECT 1 AS x), b (y) AS (SELECT 2) INSERT INTO t SELECT * FROM a")).toBe(
      "insert t",
    );
  });

  it("names INSERT from the INTO target, stripping brackets", () => {
    expect(deriveTabTitle("INSERT INTO [dbo].[AuditLog] (Msg) VALUES ('hi')")).toBe("insert AuditLog");
  });

  it("names UPDATE past a TOP (n) clause", () => {
    expect(deriveTabTitle("UPDATE TOP (100) Users SET active = 0")).toBe("update Users");
  });

  it("names DELETE from the FROM target, keeping a temp-table # prefix", () => {
    expect(deriveTabTitle("DELETE FROM #tmp WHERE id < 10")).toBe("delete #tmp");
  });

  it("names EXEC from the procedure name", () => {
    expect(deriveTabTitle("EXEC dbo.usp_RebuildIndexes @db = 'x'")).toBe("exec usp_RebuildIndexes");
  });

  it("skips a return-value assignment on EXEC", () => {
    expect(deriveTabTitle("EXEC @rc = dbo.usp_Cleanup")).toBe("exec usp_Cleanup");
  });

  it("names DDL past object-type keywords", () => {
    expect(deriveTabTitle("CREATE TABLE dbo.OrdersArchive (Id int)")).toBe("create OrdersArchive");
    expect(deriveTabTitle("DROP TABLE IF EXISTS Foo")).toBe("drop Foo");
    expect(deriveTabTitle("TRUNCATE TABLE Foo")).toBe("truncate Foo");
    expect(deriveTabTitle("BACKUP DATABASE x TO DISK = 'x.bak'")).toBe("backup x");
  });

  it("falls back to the verb alone when no object is found", () => {
    expect(deriveTabTitle("SELECT 1")).toBe("select");
    expect(deriveTabTitle("SELECT GETDATE(), @@VERSION")).toBe("select");
  });

  it("returns null for empty or comment-only input", () => {
    expect(deriveTabTitle("")).toBeNull();
    expect(deriveTabTitle("   \n  ")).toBeNull();
    expect(deriveTabTitle("-- just a comment\n/* and another */")).toBeNull();
  });

  it("ignores keywords inside string literals and comments", () => {
    expect(deriveTabTitle("SELECT 'DROP TABLE x' FROM T")).toBe("select T");
    expect(deriveTabTitle("-- DELETE FROM Users\nSELECT * FROM Orders")).toBe("select Orders");
  });

  it("names a multi-statement batch from the first statement only", () => {
    expect(deriveTabTitle("SELECT 1;\nDELETE FROM x;")).toBe("select");
    expect(deriveTabTitle("UPDATE a SET x = 1;\nSELECT * FROM b")).toBe("update a");
  });

  it("is case-insensitive on keywords and preserves identifier case", () => {
    expect(deriveTabTitle("select * from users")).toBe("select users");
  });

  it("ignores a FROM inside a subquery in the select list", () => {
    expect(deriveTabTitle("SELECT (SELECT MAX(x) FROM Inner1) AS m FROM Outer1")).toBe("select Outer1");
  });
});
