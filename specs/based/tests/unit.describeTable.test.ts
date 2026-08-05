// Traces: BASED-AGENT-SCHEMA-CTX, BASED-SCRIPT-OBJECT
// describe_table with format "columns" on a name/namespace that doesn't resolve. SQL adapters
// answer a wrong schema with an empty recordset, not an error — so without an existence check the
// tool reported `columns: []` as if it were a real answer, and the agent had nothing to self-correct
// from. The DDL formats already resolved the object via listObjects() and returned
// { error, validNames }; the columns format must fail the same way.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSurfaceFor, AuditStore, openDb } from "@based/core";
import type { DatabaseAdapter, EngineCapabilities, TableColumn, ToolDeps } from "@based/core";

const MSSQL: EngineCapabilities = {
  sql: true,
  search: false,
  write: true,
  orderedBrowse: true,
  script: true,
  relations: true,
  engine: "mssql",
  variant: "mssql",
  containers: null,
  wherePredicate: false,
  structuredFilters: true,
  countRows: true,
  takeByKey: false,
  indexIntrospect: true,
};

const COLS: TableColumn[] = [
  { name: "session_id", type: "nvarchar", maxLength: 64, precision: null, scale: null, nullable: false, isPrimaryKey: true, isForeignKey: false, fkTarget: null },
];

/** One table, ai.AgnoSessions. A lookup under any other schema returns [] the way a SQL catalog
 *  query does — no rows matched, no error raised. */
function fakeAdapter(): DatabaseAdapter {
  return {
    capabilities: MSSQL,
    database: "d",
    async getTableColumns(schema: string, table: string): Promise<TableColumn[]> {
      return schema === "ai" && table === "AgnoSessions" ? COLS : [];
    },
    async listObjects() {
      return [{ schema: "ai", name: "AgnoSessions", type: "table" as const }];
    },
  } as unknown as DatabaseAdapter;
}

function deps(adapter: DatabaseAdapter): ToolDeps {
  return {
    getAdapter: () => adapter,
    connectionId: () => "c",
    database: () => "d",
    audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-desc-")), "app.db"))),
  };
}

type Tool = { execute: (args: unknown, x: unknown) => Promise<unknown> };

function describeTool(): Tool {
  const adapter = fakeAdapter();
  return (agentSurfaceFor(MSSQL, deps(adapter)).tools as Record<string, Tool>).describe_table!;
}

describe("BASED-AGENT-SCHEMA-CTX: describe_table on a name that doesn't resolve", () => {
  test("a wrong namespace is an error with valid names, not an empty column list", async () => {
    const out = (await describeTool().execute({ table: "AgnoSessions", schema: "dbo" }, {} as never)) as {
      columns?: unknown[];
      error?: string;
      validNames?: string[];
    };
    expect(out.columns).toBeUndefined();
    expect(out.error).toMatch(/Unknown object dbo\.AgnoSessions/);
    expect(out.validNames).toEqual(["ai.AgnoSessions"]);
  });

  test("a wrong table name is the same error", async () => {
    const out = (await describeTool().execute({ table: "AgnoSession", schema: "ai" }, {} as never)) as {
      error?: string;
      validNames?: string[];
    };
    expect(out.error).toMatch(/Unknown object ai\.AgnoSession/);
    expect(out.validNames).toEqual(["ai.AgnoSessions"]);
  });

  test("the right namespace still returns columns", async () => {
    const out = (await describeTool().execute({ table: "AgnoSessions", schema: "ai" }, {} as never)) as {
      columns?: TableColumn[];
      error?: string;
    };
    expect(out.error).toBeUndefined();
    expect(out.columns).toEqual(COLS);
  });
});
