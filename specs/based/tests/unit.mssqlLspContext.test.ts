// Traces: BASED-LSP-MSSQL-NATIVE (pure context/alias helpers)
import { describe, expect, test } from "bun:test";
import { completionContext, resolveAliases } from "../../../core/src/lsp/mssqlLsp";

describe("BASED-LSP-MSSQL-NATIVE: completionContext", () => {
  test("after FROM / JOIN / APPLY / UPDATE / INTO / DELETE FROM → objects", () => {
    expect(completionContext("SELECT * FROM ")).toEqual({ kind: "object" });
    expect(completionContext("SELECT * FROM a JOIN ")).toEqual({ kind: "object" });
    expect(completionContext("SELECT * FROM a CROSS APPLY ")).toEqual({ kind: "object" });
    expect(completionContext("UPDATE ")).toEqual({ kind: "object" });
    expect(completionContext("INSERT INTO ")).toEqual({ kind: "object" });
    expect(completionContext("DELETE FROM ")).toEqual({ kind: "object" });
    expect(completionContext("select * from ")).toEqual({ kind: "object" }); // case-insensitive
  });

  test("after EXEC / EXECUTE → procedures", () => {
    expect(completionContext("EXEC ")).toEqual({ kind: "procedure" });
    expect(completionContext("execute ")).toEqual({ kind: "procedure" });
  });

  test("after owner. → member (schema objects or table columns)", () => {
    expect(completionContext("SELECT * FROM dbo.")).toEqual({ kind: "member", owner: "dbo" });
    expect(completionContext("SELECT t.")).toEqual({ kind: "member", owner: "t" });
    expect(completionContext("SELECT [order].")).toEqual({ kind: "member", owner: "order" });
  });

  test("mid-word keeps the context and reports the partial", () => {
    expect(completionContext("SELECT * FROM cust")).toEqual({ kind: "object", partial: "cust" });
    expect(completionContext("SELECT t.na")).toEqual({ kind: "member", owner: "t", partial: "na" });
  });

  test("anything else → general", () => {
    expect(completionContext("SELECT ")).toEqual({ kind: "general" });
    expect(completionContext("")).toEqual({ kind: "general" });
    expect(completionContext("SELECT a, b WHERE ")).toEqual({ kind: "general" });
  });
});

describe("BASED-LSP-MSSQL-NATIVE: resolveAliases", () => {
  test("AS and bare aliases across FROM and JOINs", () => {
    const doc = "SELECT * FROM dbo.customers AS c JOIN orders o ON o.customer_id = c.id";
    const aliases = resolveAliases(doc);
    expect(aliases.get("c")).toEqual({ schema: "dbo", name: "customers" });
    expect(aliases.get("o")).toEqual({ schema: null, name: "orders" });
  });

  test("bracketed identifiers", () => {
    const aliases = resolveAliases("SELECT * FROM [dbo].[order details] od");
    expect(aliases.get("od")).toEqual({ schema: "dbo", name: "order details" });
  });

  test("UPDATE and APPLY targets; keywords never become aliases", () => {
    const aliases = resolveAliases("SELECT * FROM a WHERE x = 1");
    expect(aliases.has("WHERE")).toBe(false);
    expect(aliases.has("where")).toBe(false);
    const up = resolveAliases("UPDATE t SET x = 1 FROM dbo.things t");
    expect(up.get("t")).toEqual({ schema: "dbo", name: "things" });
  });

  test("a bare table name maps to itself (table. completion without an alias)", () => {
    const aliases = resolveAliases("SELECT * FROM customers");
    expect(aliases.get("customers")).toEqual({ schema: null, name: "customers" });
  });
});
