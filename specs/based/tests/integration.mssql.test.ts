// Traces: BASED-AUTH-AZCLI, BASED-CONN-TEST, BASED-MSSQL-OBJECTS, BASED-MSSQL-COLUMNS,
//         BASED-MULTI-RESULTSET, BASED-CANCEL, BASED-ERROR-TEXT, BASED-TABLE-BROWSE, BASED-TABLE-COMMIT,
//         BASED-VIEW-DEFINITION, BASED-ROUTINE-DETAILS
// Runs against the Phase 0 dev DB via AzureCliCredential. Read-only suites need only connect; the
// table-edit suite additionally needs CREATE/DROP TABLE and self-skips when that permission is absent.
import { describe, expect, test } from "bun:test";
import { buildEditCommands, MssqlAdapter, testConnection } from "@based/core";
import type { ConnectionConfig, ExecuteOptions, QueryChunk } from "@based/core";

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

function collect(
  adapter: MssqlAdapter,
  sql: string,
  opts?: ExecuteOptions,
): Promise<{ chunks: QueryChunk[]; status: string }> {
  const chunks: QueryChunk[] = [];
  const exec = adapter.execute(sql, (c) => chunks.push(c), opts);
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

  test("BASED-VIEW-DEFINITION: an existing view's CREATE VIEW body is returned", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const view = (await adapter.listObjects()).find((o) => o.type === "view");
      expect(view).toBeDefined();
      const definition = await adapter.getObjectDefinition!(view!.schema, view!.name);
      expect(definition).not.toBeNull();
      expect(definition).toMatch(/create\s+view/i);
      expect(definition!.toLowerCase()).toContain(view!.name.toLowerCase());

      const missing = await adapter.getObjectDefinition!("dbo", `based_spec_no_such_object_${Date.now()}`);
      expect(missing).toBeNull();
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-ROUTINE-DETAILS: procedure definition + declaration-ordered parameter list", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const objects = await adapter.listObjects();
      const proc = objects.find((o) => o.type === "procedure");
      expect(proc).toBeDefined();
      const definition = await adapter.getObjectDefinition!(proc!.schema, proc!.name);
      expect(definition).not.toBeNull();
      expect(definition).toMatch(/create\s+proc(edure)?/i);

      // find a procedure with at least one parameter to assert shape meaningfully
      let params: Awaited<ReturnType<MssqlAdapter["getRoutineParameters"]>> = [];
      for (const p of objects.filter((o) => o.type === "procedure")) {
        params = await adapter.getRoutineParameters!(p.schema, p.name);
        if (params.length > 0) break;
      }
      expect(params.length).toBeGreaterThan(0);
      for (const p of params) {
        expect(p.name.length).toBeGreaterThan(0);
        expect(p.type.length).toBeGreaterThan(0);
        expect(["in", "out", "inout"]).toContain(p.mode);
      }
      const ordinals = params.map((p) => p.ordinal);
      expect(ordinals).toEqual([...ordinals].sort((a, b) => a - b));

      const fn = objects.find((o) => o.type === "function");
      if (fn) {
        const fnDef = await adapter.getObjectDefinition!(fn.schema, fn.name);
        expect(fnDef).toMatch(/create\s+function/i);
      }
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-EXEC-PLAN: capturePlan captures actual plan XML with no spurious resultset", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const { chunks, status } = await collect(adapter, "SELECT 1 AS a", { capturePlan: true });
      expect(status).toBe("ok");
      const plans = chunks.filter((c) => c.type === "plan") as Array<{ type: "plan"; xml: string }>;
      expect(plans.length).toBe(1);
      expect(plans[0]!.xml).toMatch(/<ShowPlanXML/);
      const sets = resultSets(chunks);
      expect(sets.length).toBe(1);
      expect(sets[0]!.columns).toEqual(["a"]);
      expect(sets[0]!.rows[0]).toEqual([1]);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-EXEC-PLAN: multi-statement batch yields one plan chunk per statement", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const { chunks, status } = await collect(adapter, "SELECT 1 AS a; SELECT 2 AS b", {
        capturePlan: true,
        captureStats: true,
      });
      expect(status).toBe("ok");
      expect(chunks.filter((c) => c.type === "plan").length).toBe(2);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-CLIENT-STATS: captureStats surfaces STATISTICS IO/TIME text as messages", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const { chunks, status } = await collect(adapter, "SELECT TOP 1 * FROM sys.objects", { captureStats: true });
      expect(status).toBe("ok");
      const messages = chunks
        .filter((c) => c.type === "message")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      expect(messages).toMatch(/logical reads|CPU time/i);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-EXEC-PLAN: cancelling a capture-enabled run doesn't leak SET state to the next query", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      await adapter.connect();
      const chunks: QueryChunk[] = [];
      const exec = adapter.execute("WAITFOR DELAY '00:00:30'", (c) => chunks.push(c), {
        capturePlan: true,
        captureStats: true,
      });
      setTimeout(() => exec.cancel(), 500);
      const { status } = await exec.completion;
      expect(status).toBe("cancelled");

      // Regression test for the pooled-connection leak: a cancelled capture-enabled batch skips its
      // trailing SET ... OFF (TRY/CATCH doesn't run on a TDS ATTENTION abort) — the next unrelated
      // query on this same adapter must still come back clean.
      const after = await collect(adapter, "SELECT 1 AS ok");
      expect(after.status).toBe("ok");
      expect(after.chunks.some((c) => c.type === "plan")).toBe(false);
      const afterMessages = after.chunks
        .filter((c) => c.type === "message")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      expect(afterMessages).not.toMatch(/logical reads|CPU time/i);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);
});

// --- table browse + edit: needs CREATE/DROP TABLE; probes once and self-skips otherwise ---
let canWrite = false;
if (available) {
  const probe = new MssqlAdapter(cfg, noSecret);
  const name = `based_spec_probe_${Date.now()}`;
  try {
    const c = await collect(probe, `CREATE TABLE dbo.[${name}] (id int PRIMARY KEY); DROP TABLE dbo.[${name}]`);
    canWrite = c.status === "ok";
  } catch {
    canWrite = false;
  } finally {
    await probe.disconnect().catch(() => {});
  }
  if (!canWrite) console.warn("[integration.mssql] no CREATE TABLE permission on dev DB, skipping table-edit suite");
}
const dw = canWrite ? describe : describe.skip;

dw("table browse + transactional edit against a scratch table", () => {
  const editCols = [
    { name: "id", isPrimaryKey: true },
    { name: "name", isPrimaryKey: false },
    { name: "qty", isPrimaryKey: false },
  ];

  test("BASED-TABLE-BROWSE: paginated read ordered by PK, PK-flagged columns", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    const tbl = `based_spec_browse_${Date.now()}`;
    try {
      const create = await collect(adapter, `CREATE TABLE dbo.[${tbl}] (id int PRIMARY KEY, name nvarchar(50))`);
      expect(create.status).toBe("ok");
      await collect(adapter, `INSERT INTO dbo.[${tbl}] (id,name) VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e')`);

      const p1 = await adapter.readTablePage("dbo", tbl, { offset: 0, limit: 2 });
      expect(p1.rows.length).toBe(2);
      expect(p1.orderBy).toEqual(["id"]);
      expect(p1.columns.find((c) => c.name === "id")?.isPrimaryKey).toBe(true);

      const p2 = await adapter.readTablePage("dbo", tbl, { offset: 2, limit: 2 });
      expect(p2.rows.map((r) => r[0])).not.toEqual(p1.rows.map((r) => r[0]));

      // deterministic across repeated page reads
      const p1again = await adapter.readTablePage("dbo", tbl, { offset: 0, limit: 2 });
      expect(p1again.rows).toEqual(p1.rows);
    } finally {
      await collect(adapter, `DROP TABLE dbo.[${tbl}]`).catch(() => {});
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-TABLE-COMMIT: insert+update+delete apply together; a failing batch rolls back", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    const tbl = `based_spec_edit_${Date.now()}`;
    try {
      await collect(adapter, `CREATE TABLE dbo.[${tbl}] (id int PRIMARY KEY, name nvarchar(50), qty int)`);
      await collect(adapter, `INSERT INTO dbo.[${tbl}] (id,name,qty) VALUES (1,'a',10),(2,'b',20),(3,'c',30)`);

      // all-or-nothing commit: insert 4, update 1, delete 2
      const cmds = buildEditCommands({
        schema: "dbo",
        table: tbl,
        columns: editCols,
        inserts: [{ id: 4, name: "d", qty: 40 }],
        updates: [{ key: { id: 1 }, set: { name: "A" } }],
        deletes: [{ id: 2 }],
      });
      const ok = await adapter.runCommands(cmds);
      expect(ok.error).toBeNull();

      const page = await adapter.readTablePage("dbo", tbl, { offset: 0, limit: 100 });
      const byId = new Map(page.rows.map((r) => [r[0], r]));
      expect(byId.has(2)).toBe(false); // deleted
      expect(byId.get(1)?.[1]).toBe("A"); // updated
      expect(byId.get(4)?.[1]).toBe("d"); // inserted

      // failing batch: insert 5 (valid) then insert 3 (duplicate PK) → whole batch rolls back
      const bad = buildEditCommands({
        schema: "dbo",
        table: tbl,
        columns: editCols,
        inserts: [
          { id: 5, name: "e", qty: 50 },
          { id: 3, name: "dup", qty: 0 },
        ],
      });
      const rolled = await adapter.runCommands(bad);
      expect(rolled.error).toBeTruthy();
      const after = await adapter.readTablePage("dbo", tbl, { offset: 0, limit: 100 });
      expect(after.rows.some((r) => r[0] === 5)).toBe(false); // rolled back — no partial write
    } finally {
      await collect(adapter, `DROP TABLE dbo.[${tbl}]`).catch(() => {});
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-EXEC-PLAN: capture is skipped (not broken) for a CREATE-first batch", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    const proc = `based_spec_proc_${Date.now()}`;
    try {
      const { chunks, status } = await collect(
        adapter,
        `CREATE PROCEDURE dbo.[${proc}] AS BEGIN SELECT 1 AS ok END`,
        { capturePlan: true, captureStats: true },
      );
      expect(status).toBe("ok");
      expect(chunks.filter((c) => c.type === "plan").length).toBe(0);
      const messages = chunks
        .filter((c) => c.type === "message")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      expect(messages).toMatch(/capture skipped/i);
    } finally {
      await collect(adapter, `DROP PROCEDURE dbo.[${proc}]`).catch(() => {});
      await adapter.disconnect();
    }
  }, 60_000);
});
