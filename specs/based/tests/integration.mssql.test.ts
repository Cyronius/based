// Traces: BASED-AUTH-AZCLI, BASED-CONN-TEST, BASED-MSSQL-OBJECTS, BASED-MSSQL-COLUMNS,
//         BASED-MULTI-RESULTSET, BASED-CANCEL, BASED-ERROR-TEXT, BASED-TABLE-BROWSE, BASED-TABLE-COMMIT,
//         BASED-VIEW-DEFINITION, BASED-ROUTINE-DETAILS, BASED-EXEC-PLAN, BASED-CLIENT-STATS
// Runs against the Phase 0 dev DB via AzureCliCredential. Read-only suites need only connect; the
// table-edit suite additionally needs CREATE/DROP TABLE and self-skips when that permission is absent.
import { describe, expect, test } from "bun:test";
import { buildEditCommands, testConnection } from "@based/core";
import { MssqlAdapter } from "@based/core/mssql";
import type { ConnectionConfig, ExecuteOptions, QueryChunk } from "@based/core";
import { DEV_DB_AVAILABLE, devConnection, warnDevDbSkip } from "./_devDb";

const cfg: ConnectionConfig = devConnection("spec-dev");
const noSecret = () => null;

const d = DEV_DB_AVAILABLE ? describe : describe.skip;
if (!DEV_DB_AVAILABLE) warnDevDbSkip("integration.mssql", "all suites");

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

  // A trivial constant SELECT (e.g. "SELECT 1 AS a") short-circuits below SQL Server's normal plan-
  // generation path and never emits a STATISTICS XML resultset — these tests need a real table access.
  test("BASED-EXEC-PLAN: capturePlan captures actual plan XML with no spurious resultset", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const { chunks, status } = await collect(adapter, "SELECT TOP 1 object_id FROM sys.objects", { capturePlan: true });
      expect(status).toBe("ok");
      const plans = chunks.filter((c) => c.type === "plan") as Array<{ type: "plan"; xml: string }>;
      expect(plans.length).toBe(1);
      expect(plans[0]!.xml).toMatch(/<ShowPlanXML/);
      const sets = resultSets(chunks);
      expect(sets.length).toBe(1);
      expect(sets[0]!.columns).toEqual(["object_id"]);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);

  test("BASED-EXEC-PLAN: multi-statement batch yields one plan chunk per statement", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    try {
      const { chunks, status } = await collect(
        adapter,
        "SELECT TOP 1 object_id FROM sys.objects; SELECT TOP 1 name FROM sys.schemas",
        { capturePlan: true, captureStats: true },
      );
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
      // trailing SET ... OFF (TRY/CATCH doesn't run on a TDS ATTENTION abort). The very next query's
      // defensive OFF prefix (see wrapBatch) does clear it, but — inherent SQL Server behavior, not a
      // bug — while STATISTICS TIME is still ON, every statement including the OFF statement itself
      // prints one trailing stats blurb, so this first post-cancel query may carry one echoed message.
      // The real invariant: no plan chunks ever leak, and a SECOND post-cancel query is fully clean —
      // proving the state was actually cleared rather than leaking indefinitely.
      const after = await collect(adapter, "SELECT 1 AS ok");
      expect(after.status).toBe("ok");
      expect(after.chunks.some((c) => c.type === "plan")).toBe(false);

      const after2 = await collect(adapter, "SELECT 1 AS ok");
      expect(after2.status).toBe("ok");
      expect(after2.chunks.some((c) => c.type === "plan")).toBe(false);
      const after2Messages = after2.chunks
        .filter((c) => c.type === "message")
        .map((c) => (c as { text: string }).text)
        .join("\n");
      expect(after2Messages).not.toMatch(/logical reads|CPU time/i);
    } finally {
      await adapter.disconnect();
    }
  }, 60_000);
});

// --- table browse + edit: needs CREATE/DROP TABLE; probes once and self-skips otherwise ---
let canWrite = false;
if (DEV_DB_AVAILABLE) {
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

  test("BASED-TABLE-DETAILS: full introspection — identity, computed, FK actions, filtered/INCLUDE index, default, check", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    const parent = `based_spec_det_p_${Date.now()}`;
    const tbl = `based_spec_det_${Date.now()}`;
    try {
      await collect(adapter, `CREATE TABLE dbo.[${parent}] (id int PRIMARY KEY)`);
      const create = await collect(
        adapter,
        `CREATE TABLE dbo.[${tbl}] (
           id int IDENTITY(5,2) NOT NULL,
           region nvarchar(50) NOT NULL,
           parent_id int NULL CONSTRAINT [FK_${tbl}] FOREIGN KEY REFERENCES dbo.[${parent}](id) ON DELETE CASCADE,
           qty int NULL CONSTRAINT [CK_${tbl}] CHECK (qty >= 0),
           created datetime2(3) NOT NULL CONSTRAINT [DF_${tbl}] DEFAULT (sysutcdatetime()),
           total AS (qty * 2) PERSISTED,
           CONSTRAINT [PK_${tbl}] PRIMARY KEY (id, region)
         )`,
      );
      expect(create.status).toBe("ok");
      await collect(adapter, `CREATE NONCLUSTERED INDEX [IX_${tbl}] ON dbo.[${tbl}] (qty) INCLUDE (created) WHERE qty > 0`);

      const det = await adapter.getTableDetails("dbo", tbl);

      const id = det.columns.find((c) => c.name === "id")!;
      expect(id.isIdentity).toBe(true);
      expect(id.identitySeed).toBe(5);
      expect(id.identityIncrement).toBe(2);

      const total = det.columns.find((c) => c.name === "total")!;
      expect(total.computedDefinition).toContain("[qty]");
      expect(total.computedPersisted).toBe(true);

      const pk = det.indexes.find((i) => i.isPrimaryKey)!;
      expect(pk.keyColumns.map((k) => k.name)).toEqual(["id", "region"]);

      const ix = det.indexes.find((i) => i.name === `IX_${tbl}`)!;
      expect(ix.keyColumns.map((k) => k.name)).toEqual(["qty"]);
      expect(ix.includedColumns).toEqual(["created"]);
      expect(ix.filterDefinition).toContain("[qty]");

      const fk = det.foreignKeys.find((f) => f.name === `FK_${tbl}`)!;
      expect(fk.columns).toEqual(["parent_id"]);
      expect(fk.refTable).toBe(parent);
      expect(fk.refColumns).toEqual(["id"]);
      expect(fk.onDelete).toBe("CASCADE");

      expect(det.checkConstraints.find((c) => c.name === `CK_${tbl}`)?.definition).toContain("[qty]");
      const df = det.defaultConstraints.find((c) => c.name === `DF_${tbl}`)!;
      expect(df.column).toBe("created");
      expect(df.definition.toLowerCase()).toContain("sysutcdatetime");

      // A plain table reports empty arrays, not errors
      const plainDet = await adapter.getTableDetails("dbo", parent);
      expect(plainDet.foreignKeys).toEqual([]);
      expect(plainDet.checkConstraints).toEqual([]);
      expect(plainDet.defaultConstraints).toEqual([]);
      expect(plainDet.triggers).toEqual([]);

      // The scripted CREATE from these details is runnable against the same DB (round-trip)
      const { scriptCreateTable } = await import("@based/core");
      const ddl = scriptCreateTable({ ...det, name: `${tbl}_rt` }).replaceAll(`[${tbl}]`, `[${tbl}_rt]`).replaceAll(`FK_${tbl}]`, `FK_${tbl}_rt]`).replaceAll(`CK_${tbl}]`, `CK_${tbl}_rt]`).replaceAll(`DF_${tbl}]`, `DF_${tbl}_rt]`).replaceAll(`PK_${tbl}]`, `PK_${tbl}_rt]`).replaceAll(`IX_${tbl}]`, `IX_${tbl}_rt]`);
      const rt = await collect(adapter, ddl);
      expect(rt.status).toBe("ok");
      await collect(adapter, `DROP TABLE dbo.[${tbl}_rt]`).catch(() => {});
    } finally {
      await collect(adapter, `DROP TABLE dbo.[${tbl}]`).catch(() => {});
      await collect(adapter, `DROP TABLE dbo.[${parent}]`).catch(() => {});
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-RELATIONS: bulk tables + FK edges in one call; schema scope keeps touching edges", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    const parent = `based_spec_rel_p_${Date.now()}`;
    const child = `based_spec_rel_c_${Date.now()}`;
    try {
      await collect(adapter, `CREATE TABLE dbo.[${parent}] (id int PRIMARY KEY, label nvarchar(20))`);
      await collect(
        adapter,
        `CREATE TABLE dbo.[${child}] (id int PRIMARY KEY, parent_id int CONSTRAINT [FK_${child}] FOREIGN KEY REFERENCES dbo.[${parent}](id))`,
      );

      const graph = await adapter.getRelations("dbo");
      const p = graph.tables.find((t) => t.name === parent)!;
      const c = graph.tables.find((t) => t.name === child)!;
      expect(p.columns.map((x) => x.name)).toEqual(["id", "label"]);
      expect(p.columns[0]!.isPrimaryKey).toBe(true);
      expect(c.columns.find((x) => x.name === "parent_id")?.isForeignKey).toBe(true);

      const edge = graph.foreignKeys.find((f) => f.name === `FK_${child}`)!;
      expect(edge.table).toBe(child);
      expect(edge.columns).toEqual(["parent_id"]);
      expect(edge.refTable).toBe(parent);
      expect(edge.refColumns).toEqual(["id"]);

      // unscoped call also contains both
      const all = await adapter.getRelations();
      expect(all.tables.some((t) => t.name === parent)).toBe(true);

      // a scope that matches nothing returns empty tables but never throws
      const none = await adapter.getRelations("based_spec_no_such_schema");
      expect(none.tables).toEqual([]);
    } finally {
      await collect(adapter, `DROP TABLE dbo.[${child}]`).catch(() => {});
      await collect(adapter, `DROP TABLE dbo.[${parent}]`).catch(() => {});
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-TABLE-ORDERBY: server-side sort + filters, validated columns, deterministic paging", async () => {
    const adapter = new MssqlAdapter(cfg, noSecret);
    const tbl = `based_spec_order_${Date.now()}`;
    try {
      await collect(adapter, `CREATE TABLE dbo.[${tbl}] (id int PRIMARY KEY, name nvarchar(50), qty int NULL)`);
      await collect(
        adapter,
        `INSERT INTO dbo.[${tbl}] (id,name,qty) VALUES (1,'apple',10),(2,'banana',20),(3,'apricot',NULL),(4,'cherry',40),(5,'avocado',5)`,
      );

      // desc sort changes the first row vs the ascending default
      const asc = await adapter.readTablePage("dbo", tbl, { offset: 0, limit: 5 });
      const desc = await adapter.readTablePage("dbo", tbl, {
        offset: 0,
        limit: 5,
        orderBy: [{ column: "qty", dir: "desc" }],
      });
      expect(desc.rows[0]![0]).not.toEqual(asc.rows[0]![0]);
      expect(desc.rows[0]![2]).toBe(40);

      // deterministic paging under a user sort: page 2 shares no ids with page 1
      const s1 = await adapter.readTablePage("dbo", tbl, { offset: 0, limit: 2, orderBy: [{ column: "name", dir: "asc" }] });
      const s2 = await adapter.readTablePage("dbo", tbl, { offset: 2, limit: 2, orderBy: [{ column: "name", dir: "asc" }] });
      const ids1 = new Set(s1.rows.map((r) => r[0]));
      expect(s2.rows.every((r) => !ids1.has(r[0]))).toBe(true);

      // eq / like / is-null filters
      const eq = await adapter.readTablePage("dbo", tbl, {
        offset: 0,
        limit: 10,
        filters: [{ column: "qty", op: "eq", value: 20 }],
      });
      expect(eq.rows.length).toBe(1);
      expect(eq.rows[0]![1]).toBe("banana");

      const like = await adapter.readTablePage("dbo", tbl, {
        offset: 0,
        limit: 10,
        filters: [{ column: "name", op: "like", value: "%ap%" }],
      });
      expect(like.rows.map((r) => r[1]).sort()).toEqual(["apple", "apricot"]);

      const isNull = await adapter.readTablePage("dbo", tbl, {
        offset: 0,
        limit: 10,
        filters: [{ column: "qty", op: "is-null" }],
      });
      expect(isNull.rows.length).toBe(1);
      expect(isNull.rows[0]![1]).toBe("apricot");

      const notNull = await adapter.readTablePage("dbo", tbl, {
        offset: 0,
        limit: 10,
        filters: [{ column: "qty", op: "not-null" }],
      });
      expect(notNull.rows.length).toBe(4);

      // gt with combined sort
      const gt = await adapter.readTablePage("dbo", tbl, {
        offset: 0,
        limit: 10,
        orderBy: [{ column: "qty", dir: "asc" }],
        filters: [{ column: "qty", op: "gt", value: 5 }],
      });
      expect(gt.rows.map((r) => r[2])).toEqual([10, 20, 40]);

      // unknown columns throw before SQL runs (try/catch style — bun:test's rejects.toThrow
      // matcher misreports this adapter rejection as its own internal timeout)
      const badOrder = await adapter
        .readTablePage("dbo", tbl, { offset: 0, limit: 5, orderBy: [{ column: "nope", dir: "asc" }] })
        .then(() => null, (e: Error) => e);
      expect(badOrder?.message ?? "").toMatch(/nope/);
      const badFilter = await adapter
        .readTablePage("dbo", tbl, { offset: 0, limit: 5, filters: [{ column: "nope; DROP", op: "eq", value: 1 }] })
        .then(() => null, (e: Error) => e);
      expect(badFilter).not.toBeNull();

      // filter values are parameterized — hostile value narrows safely, no error
      const hostile = await adapter.readTablePage("dbo", tbl, {
        offset: 0,
        limit: 10,
        filters: [{ column: "name", op: "eq", value: "x' OR 1=1 --" }],
      });
      expect(hostile.rows.length).toBe(0);
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
