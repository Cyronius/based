// Traces: BASED-SCRIPT-TSQL, BASED-SCRIPT-MODULE-ALTER
// Pure T-SQL scripter: TableDetails → CREATE/DROP/SELECT/INSERT DDL, module CREATE→ALTER rewrite,
// dispatcher + GO joining. No DB access — fixtures only.
import { describe, expect, test } from "bun:test";
import {
  formatTypeTsql,
  joinScripts,
  rewriteCreateToAlter,
  scriptCreateTable,
  scriptDropModule,
  scriptDropTable,
  scriptInsertTemplate,
  scriptObject,
  scriptSelectTemplate,
} from "../../../core/src/db/scripter";
import type { ScriptTableColumn, TableDetails } from "@based/core";

function col(partial: Partial<ScriptTableColumn> & { name: string; type: string }): ScriptTableColumn {
  return {
    maxLength: null,
    precision: null,
    scale: null,
    nullable: false,
    isPrimaryKey: false,
    isForeignKey: false,
    fkTarget: null,
    collation: null,
    isIdentity: false,
    identitySeed: null,
    identityIncrement: null,
    computedDefinition: null,
    computedPersisted: false,
    ...partial,
  };
}

/** A fixture exercising identity, computed, composite PK, desc keys, filtered/INCLUDE index,
 *  defaults, checks, and FK actions in one table. */
const FIXTURE: TableDetails = {
  schema: "dbo",
  name: "orders",
  columns: [
    col({ name: "id", type: "int", isPrimaryKey: true, isIdentity: true, identitySeed: 1, identityIncrement: 1 }),
    col({ name: "region", type: "nvarchar", maxLength: 50, isPrimaryKey: true }),
    col({ name: "customer_id", type: "int", isForeignKey: true, fkTarget: "dbo.customers(id)" }),
    col({ name: "qty", type: "int", nullable: true }),
    col({ name: "price", type: "decimal", precision: 10, scale: 2 }),
    col({ name: "total", type: "decimal", precision: 10, scale: 2, computedDefinition: "([qty]*[price])", computedPersisted: true }),
    col({ name: "note", type: "nvarchar", maxLength: -1, nullable: true }),
    col({ name: "created", type: "datetime2", scale: 3 }),
  ],
  indexes: [
    {
      name: "PK_orders",
      typeDesc: "CLUSTERED",
      isUnique: true,
      isPrimaryKey: true,
      isUniqueConstraint: false,
      filterDefinition: null,
      keyColumns: [
        { name: "id", descending: false },
        { name: "region", descending: true },
      ],
      includedColumns: [],
    },
    {
      name: "UQ_orders_note",
      typeDesc: "NONCLUSTERED",
      isUnique: true,
      isPrimaryKey: false,
      isUniqueConstraint: true,
      filterDefinition: null,
      keyColumns: [{ name: "note", descending: false }],
      includedColumns: [],
    },
    {
      name: "IX_orders_qty",
      typeDesc: "NONCLUSTERED",
      isUnique: false,
      isPrimaryKey: false,
      isUniqueConstraint: false,
      filterDefinition: "([qty]>(0))",
      keyColumns: [{ name: "qty", descending: false }],
      includedColumns: ["price", "total"],
    },
  ],
  foreignKeys: [
    {
      name: "FK_orders_customers",
      columns: ["customer_id"],
      refSchema: "dbo",
      refTable: "customers",
      refColumns: ["id"],
      onDelete: "CASCADE",
      onUpdate: "NO_ACTION",
      isDisabled: false,
    },
  ],
  checkConstraints: [{ name: "CK_orders_qty", definition: "([qty]>=(0))", column: "qty", isDisabled: false }],
  defaultConstraints: [{ name: "DF_orders_created", column: "created", definition: "(sysutcdatetime())" }],
  triggers: [],
};

describe("BASED-SCRIPT-TSQL: formatTypeTsql", () => {
  test("length, max, precision/scale, datetime2 scale, plain", () => {
    expect(formatTypeTsql(col({ name: "a", type: "nvarchar", maxLength: 50 }))).toBe("nvarchar(50)");
    expect(formatTypeTsql(col({ name: "a", type: "nvarchar", maxLength: -1 }))).toBe("nvarchar(max)");
    expect(formatTypeTsql(col({ name: "a", type: "decimal", precision: 10, scale: 2 }))).toBe("decimal(10,2)");
    expect(formatTypeTsql(col({ name: "a", type: "datetime2", scale: 3 }))).toBe("datetime2(3)");
    expect(formatTypeTsql(col({ name: "a", type: "int" }))).toBe("int");
    expect(formatTypeTsql(col({ name: "a", type: "varbinary", maxLength: -1 }))).toBe("varbinary(max)");
  });
});

describe("BASED-SCRIPT-TSQL: scriptCreateTable", () => {
  const ddl = scriptCreateTable(FIXTURE);

  test("emits CREATE TABLE with identity, computed, nullability", () => {
    expect(ddl).toContain("CREATE TABLE [dbo].[orders]");
    expect(ddl).toContain("[id] int IDENTITY(1,1) NOT NULL");
    expect(ddl).toContain("[total] AS ([qty]*[price]) PERSISTED");
    expect(ddl).toContain("[qty] int NULL");
    expect(ddl).toContain("[note] nvarchar(max) NULL");
  });

  test("inline composite PK with DESC key and inline UNIQUE constraint", () => {
    expect(ddl).toContain("CONSTRAINT [PK_orders] PRIMARY KEY CLUSTERED ([id] ASC, [region] DESC)");
    expect(ddl).toContain("CONSTRAINT [UQ_orders_note] UNIQUE NONCLUSTERED ([note] ASC)");
  });

  test("defaults, checks, FKs as ALTER TABLE ADD with actions", () => {
    expect(ddl).toContain("ALTER TABLE [dbo].[orders] ADD CONSTRAINT [DF_orders_created] DEFAULT (sysutcdatetime()) FOR [created]");
    expect(ddl).toContain("WITH CHECK ADD CONSTRAINT [CK_orders_qty] CHECK (([qty]>=(0)))");
    expect(ddl).toContain(
      "CONSTRAINT [FK_orders_customers] FOREIGN KEY ([customer_id]) REFERENCES [dbo].[customers] ([id]) ON DELETE CASCADE",
    );
    expect(ddl).not.toContain("ON UPDATE NO ACTION"); // NO_ACTION is the default — not emitted
  });

  test("non-constraint index with INCLUDE and filter", () => {
    expect(ddl).toContain("CREATE NONCLUSTERED INDEX [IX_orders_qty] ON [dbo].[orders] ([qty] ASC)");
    expect(ddl).toContain("INCLUDE ([price], [total])");
    expect(ddl).toContain("WHERE ([qty]>(0))");
  });
});

describe("BASED-SCRIPT-TSQL: identifier escaping + drops + templates", () => {
  test("] in identifiers doubles", () => {
    const weird: TableDetails = { ...FIXTURE, name: "we]ird", indexes: [], foreignKeys: [], checkConstraints: [], defaultConstraints: [] };
    expect(scriptCreateTable(weird)).toContain("CREATE TABLE [dbo].[we]]ird]");
  });

  test("drop table / drop module use IF EXISTS", () => {
    expect(scriptDropTable({ schema: "dbo", name: "orders" })).toBe("DROP TABLE IF EXISTS [dbo].[orders];");
    expect(scriptDropModule("view", { schema: "dbo", name: "v1" })).toBe("DROP VIEW IF EXISTS [dbo].[v1];");
    expect(scriptDropModule("procedure", { schema: "dbo", name: "p1" })).toBe("DROP PROCEDURE IF EXISTS [dbo].[p1];");
  });

  test("SELECT template lists all columns; INSERT omits identity + computed", () => {
    const sel = scriptSelectTemplate(FIXTURE);
    expect(sel).toContain("SELECT TOP (1000)");
    expect(sel).toContain("[total]");
    const ins = scriptInsertTemplate(FIXTURE);
    expect(ins).toContain("INSERT INTO [dbo].[orders]");
    expect(ins).not.toContain("[id]");
    expect(ins).not.toContain("[total]");
    expect(ins).toContain("[region]");
  });
});

describe("BASED-SCRIPT-MODULE-ALTER: rewriteCreateToAlter", () => {
  test("plain CREATE VIEW rewrites", () => {
    expect(rewriteCreateToAlter("CREATE VIEW dbo.v AS SELECT 1 AS x")).toBe("ALTER VIEW dbo.v AS SELECT 1 AS x");
  });

  test("leading comments containing the word CREATE are not rewritten", () => {
    const def = "/* CREATE VIEW note */\n-- CREATE more\nCREATE VIEW dbo.v AS SELECT 1 AS x";
    const out = rewriteCreateToAlter(def);
    expect(out).toContain("/* CREATE VIEW note */");
    expect(out).toContain("-- CREATE more");
    expect(out).toContain("ALTER VIEW dbo.v");
    expect(out.match(/ALTER/g)?.length).toBe(1);
  });

  test("CREATE OR ALTER collapses; lowercase preserved", () => {
    expect(rewriteCreateToAlter("create or alter procedure dbo.p as select 1")).toBe("ALTER procedure dbo.p as select 1");
    expect(rewriteCreateToAlter("create function dbo.f() returns int as begin return 1 end")).toContain("ALTER function dbo.f()");
  });

  test("no match returns original with a warning comment", () => {
    const out = rewriteCreateToAlter("SELECT 1");
    expect(out).toContain("SELECT 1");
    expect(out).toMatch(/^--.*could not rewrite/im);
  });
});

describe("BASED-SCRIPT-TSQL: dispatcher + joinScripts", () => {
  test("alter on a table throws", () => {
    expect(() => scriptObject({ kind: "table", details: FIXTURE }, "alter")).toThrow(/alter/i);
  });

  test("drop-create = DROP + GO + CREATE in order", () => {
    const s = scriptObject({ kind: "table", details: FIXTURE }, "drop-create");
    const dropIdx = s.indexOf("DROP TABLE IF EXISTS");
    const createIdx = s.indexOf("CREATE TABLE");
    const goIdx = s.indexOf("\nGO");
    expect(dropIdx).toBeGreaterThanOrEqual(0);
    expect(goIdx).toBeGreaterThan(dropIdx);
    expect(createIdx).toBeGreaterThan(goIdx);
  });

  test("module create/alter/drop route through the definition", () => {
    const input = { kind: "module" as const, type: "view" as const, schema: "dbo", name: "v1", definition: "CREATE VIEW dbo.v1 AS SELECT 1 AS x" };
    expect(scriptObject(input, "create")).toContain("CREATE VIEW dbo.v1");
    expect(scriptObject(input, "alter")).toContain("ALTER VIEW dbo.v1");
    expect(scriptObject(input, "drop")).toContain("DROP VIEW IF EXISTS [dbo].[v1]");
  });

  test("joinScripts joins with GO separators", () => {
    expect(joinScripts(["SELECT 1", "SELECT 2"])).toBe("SELECT 1\nGO\n\nSELECT 2");
    expect(joinScripts(["only"])).toBe("only");
  });
});
