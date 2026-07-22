// Traces: BASED-AUTH-AZCLI, BASED-CONN-TEST, BASED-MSSQL-OBJECTS, BASED-MSSQL-COLUMNS,
//         BASED-MULTI-RESULTSET, BASED-CANCEL, BASED-ERROR-TEXT
// Runs against the Phase 0 dev DB (read-only queries only) via AzureCliCredential.
// Self-skips when no az login / network is available.
import { describe, expect, test } from "bun:test";
import { MssqlAdapter, testConnection } from "@based/core";
import type { ConnectionConfig, QueryChunk } from "@based/core";

const cfg: ConnectionConfig = {
  id: "spec-dev",
  name: "spec-dev",
  server: process.env.BASED_TEST_SERVER ?? "zl5qolt7t8.database.windows.net",
  database: process.env.BASED_TEST_DB ?? "learnermobile_db_ci",
  authType: "azure-cli",
  encrypt: true,
  trustServerCertificate: false,
  createdAt: "",
  updatedAt: "",
};
const noSecret = () => null;

let available = false;
let availError = "";
{
  const probe = await testConnection(cfg, noSecret);
  available = probe.ok;
  availError = probe.error ?? "";
}
const d = available ? describe : describe.skip;
if (!available) console.warn(`[integration.mssql] dev DB unavailable, skipping: ${availError}`);

function collect(adapter: MssqlAdapter, sql: string): Promise<{ chunks: QueryChunk[]; status: string }> {
  const chunks: QueryChunk[] = [];
  const exec = adapter.execute(sql, (c) => chunks.push(c));
  return exec.completion.then(({ status }) => ({ chunks, status }));
}

function resultSets(chunks: QueryChunk[]) {
  const sets: { columns: string[]; rows: unknown[][] }[] = [];
  for (const c of chunks) {
    if (c.type === "resultset") sets.push({ columns: c.columns.map((x) => x.name), rows: [] });
    if (c.type === "rows") sets[sets.length - 1]!.rows.push(...c.rows);
  }
  return sets;
}

d("mssql adapter against dev DB", () => {
  test("BASED-CONN-TEST: valid config → ok with server version; unreachable server → error text", async () => {
    const good = await testConnection(cfg, noSecret);
    expect(good.ok).toBe(true);
    expect(good.serverVersion).toMatch(/SQL/i);

    const bad = await testConnection(
      { ...cfg, server: "based-spec-unreachable.invalid", database: "x" },
      noSecret,
    );
    expect(bad.ok).toBe(false);
    expect(bad.error!.length).toBeGreaterThan(0);
  }, 60_000);

  test("BASED-AUTH-AZCLI: SUSER_SNAME() returns the az identity", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const { chunks, status } = await collect(adapter, "SELECT SUSER_SNAME() AS who");
      expect(status).toBe("ok");
      const sets = resultSets(chunks);
      expect(String(sets[0]!.rows[0]![0])).toContain("@");
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-MSSQL-OBJECTS: databases, schemas, objects", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const databases = await adapter.listDatabases();
      expect(databases).toContain(cfg.database);
      const schemas = await adapter.listSchemas();
      expect(schemas).toContain("dbo");
      const objects = await adapter.listObjects();
      expect(objects.length).toBeGreaterThan(0);
      for (const o of objects) {
        expect(o.schema.length).toBeGreaterThan(0);
        expect(o.name.length).toBeGreaterThan(0);
        expect(["table", "view", "procedure", "function"]).toContain(o.type);
      }
      expect(objects.some((o) => o.type === "table")).toBe(true);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-MSSQL-COLUMNS: column introspection with PK and nullability", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const objects = await adapter.listObjects();
      const table = objects.find((o) => o.type === "table")!;
      const cols = await adapter.getTableColumns(table.schema, table.name);
      expect(cols.length).toBeGreaterThan(0);
      for (const c of cols) {
        expect(c.name.length).toBeGreaterThan(0);
        expect(c.type.length).toBeGreaterThan(0);
        expect(typeof c.nullable).toBe("boolean");
      }
      // At least one table in a real schema has a PK — search a few
      let foundPk = false;
      for (const t of objects.filter((o) => o.type === "table").slice(0, 10)) {
        const tc = await adapter.getTableColumns(t.schema, t.name);
        if (tc.some((c) => c.isPrimaryKey)) {
          foundPk = true;
          break;
        }
      }
      expect(foundPk).toBe(true);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-MULTI-RESULTSET: 3 selects across ; and GO → 3 result sets in order", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const { chunks, status } = await collect(adapter, "SELECT 1 AS a; SELECT 2 AS b, 3 AS c\nGO\nSELECT 4 AS d");
      expect(status).toBe("ok");
      const sets = resultSets(chunks);
      expect(sets.map((s) => s.columns)).toEqual([["a"], ["b", "c"], ["d"]]);
      expect(sets.map((s) => s.rows.length)).toEqual([1, 1, 1]);
      expect(sets[1]!.rows[0]).toEqual([2, 3]);
      const ends = chunks.filter((c) => c.type === "resultsetEnd");
      expect(ends.length).toBe(3);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-CANCEL: cancel a WAITFOR promptly; adapter still usable", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      await adapter.connect();
      const chunks: QueryChunk[] = [];
      const exec = adapter.execute("WAITFOR DELAY '00:00:30'", (c) => chunks.push(c));
      setTimeout(() => exec.cancel(), 500);
      const t0 = performance.now();
      const { status } = await exec.completion;
      expect(performance.now() - t0).toBeLessThan(5000);
      expect(status).toBe("cancelled");
      expect(chunks.some((c) => c.type === "cancelled")).toBe(true);

      const after = await collect(adapter, "SELECT 1 AS ok");
      expect(after.status).toBe("ok");
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-ERROR-TEXT: syntax and runtime errors carry server text; later GO batches still run", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const syntax = await collect(adapter, "SELECT FROM");
      expect(syntax.status).toBe("error");
      const synErr = syntax.chunks.find((c) => c.type === "error") as { message: string };
      expect(synErr.message).toMatch(/syntax/i);

      const divide = await collect(adapter, "SELECT 1/0");
      const divErr = divide.chunks.find((c) => c.type === "error") as { message: string };
      expect(divErr.message).toMatch(/divide by zero/i);

      const mixed = await collect(adapter, "SELECT FROM\nGO\nSELECT 42 AS x");
      expect(mixed.status).toBe("error");
      const sets = resultSets(mixed.chunks);
      expect(sets.length).toBe(1);
      expect(sets[0]!.rows[0]).toEqual([42]);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);
});
