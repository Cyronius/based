// Traces: BASED-API-AUTH, BASED-HISTORY, BASED-CONN-TEST (endpoint), BASED-SECRET-STORE (delete via API),
//         BASED-TABLE-COMMIT (endpoint + history row), BASED-UI-SESSION-RESUME (session-lost signal)
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startServer, getSecret, testConnection } from "@based/core";
import { MssqlAdapter } from "@based/core/mssql";
import type { ConnectionInput, ConnectionConfig } from "@based/core";

const TOKEN = "spec-token";
const server = startServer({ token: TOKEN, dbPath: join(mkdtempSync(join(tmpdir(), "based-spec-srv-")), "app.db") });
const base = server.url;

afterAll(async () => {
  await server.stop();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("BASED-API-AUTH: per-launch token", () => {
  test("401 without token, 200 with; SSE requires token too", async () => {
    expect((await fetch(`${base}/api/connections`)).status).toBe(401);
    expect((await fetch(`${base}/api/events`)).status).toBe(401);
    expect((await api("/api/connections")).status).toBe(200);
    const sse = await fetch(`${base}/api/events?token=${TOKEN}`);
    expect(sse.status).toBe(200);
    expect(sse.headers.get("content-type")).toContain("text/event-stream");
    await sse.body?.cancel();
  });

  test("wrong token is 401 and does no work", async () => {
    const r = await fetch(`${base}/api/connections`, {
      method: "POST",
      headers: { authorization: "Bearer wrong", "content-type": "application/json" },
      body: JSON.stringify({ name: "evil" }),
    });
    expect(r.status).toBe(401);
    const list = (await (await api("/api/connections")).json()) as unknown[];
    expect(list.length).toBe(0);
  });
});

describe("connections API (BASED-CONN-STORE + BASED-SECRET-STORE via API)", () => {
  test("create with secret → secret in credential manager, not in metadata; delete removes both", async () => {
    const input: ConnectionInput = {
      name: "api-test",
      server: "example.database.windows.net",
      database: "db",
      authType: "sql-login",
      username: "sa",
      encrypt: true,
      trustServerCertificate: false,
      secret: "api-test-secret",
    };
    const created = (await (await api("/api/connections", { method: "POST", body: JSON.stringify(input) })).json()) as ConnectionConfig;
    expect(created.id).toBeTruthy();
    expect((created as Record<string, unknown>).secret).toBeUndefined();
    expect(getSecret(created.id)).toBe("api-test-secret");

    const del = await api(`/api/connections/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect(getSecret(created.id)).toBeNull();
    const list = (await (await api("/api/connections")).json()) as unknown[];
    expect(list.length).toBe(0);
  });
});

describe("tabs API (BASED-TABSTORE via API)", () => {
  test("bulk upsert + list + delete", async () => {
    const tabs = [
      { id: "st1", connectionId: "conn-a", title: "Q1", content: "SELECT 1", filePath: null, position: 0, kind: "query", meta: null },
      { id: "st2", connectionId: "conn-a", title: "Q2", content: "SELECT 2", filePath: null, position: 1, kind: "query", meta: null },
    ];
    await api("/api/tabs", { method: "POST", body: JSON.stringify({ connectionId: "conn-a", tabs }) });
    const listed = (await (await api("/api/tabs?connectionId=conn-a")).json()) as Array<{ id: string }>;
    expect(listed.map((t) => t.id)).toEqual(["st1", "st2"]);

    // Re-POST a subset: the persisted set mirrors the open set, so the dropped tab is pruned
    // even without an explicit DELETE (the fix for accumulating table tabs on restore).
    await api("/api/tabs", { method: "POST", body: JSON.stringify({ connectionId: "conn-a", tabs: [tabs[1]] }) });
    const replaced = (await (await api("/api/tabs?connectionId=conn-a")).json()) as Array<{ id: string }>;
    expect(replaced.map((t) => t.id)).toEqual(["st2"]);

    await api("/api/tabs/st2", { method: "DELETE" });
    const after = (await (await api("/api/tabs?connectionId=conn-a")).json()) as Array<{ id: string }>;
    expect(after.map((t) => t.id)).toEqual([]);
  });
});

// Traces: BASED-FILE-OPEN-SQL — explicit-path mode (the dialog path is manual)
describe("BASED-FILE-OPEN-SQL: open .sql file content", () => {
  test("save-sql then open-sql round-trips content", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "based-spec-sql-")), "roundtrip.sql");
    const content = "SELECT 1 AS a;\n-- comment\nSELECT 2;\n";
    const saved = (await (await api("/api/file/save-sql", { method: "POST", body: JSON.stringify({ content, path }) })).json()) as { path: string | null };
    expect(saved.path).toBe(path);
    const res = await api("/api/file/open-sql", { method: "POST", body: JSON.stringify({ path }) });
    expect(res.status).toBe(200);
    const opened = (await res.json()) as { path: string | null; content: string };
    expect(opened.path).toBe(path);
    expect(opened.content).toBe(content);
  });

  test("nonexistent path is a 400 with an error message", async () => {
    const res = await api("/api/file/open-sql", {
      method: "POST",
      body: JSON.stringify({ path: join(tmpdir(), "based-spec-sql-missing", "nope.sql") }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("nope.sql");
  });

  test("UTF-8 BOM is stripped", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "based-spec-sql-")), "bom.sql");
    await Bun.write(path, "\uFEFFSELECT 1;");
    const opened = (await (await api("/api/file/open-sql", { method: "POST", body: JSON.stringify({ path }) })).json()) as { content: string };
    expect(opened.content).toBe("SELECT 1;");
  });

  test("oversized file is a 400, no content", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "based-spec-sql-")), "big.sql");
    await Bun.write(path, "-- x\n".repeat((2 * 1024 * 1024) / 5 + 1));
    const res = await api("/api/file/open-sql", { method: "POST", body: JSON.stringify({ path }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; content?: string };
    expect(body.error).toContain("too large");
    expect(body.content).toBeUndefined();
  });
});

// --- history requires a live DB session; self-skips like integration.mssql ---
const devCfg: ConnectionConfig = {
  id: "spec-srv-dev",
  name: "spec-srv-dev",
  server: process.env.BASED_TEST_SERVER ?? "zl5qolt7t8.database.windows.net",
  database: process.env.BASED_TEST_DB ?? "learnermobile_db_ci",
  authType: "azure-cli",
  encrypt: true,
  trustServerCertificate: false,
  createdAt: "",
  updatedAt: "",
};
const probe = await testConnection(devCfg, () => null);
const d = probe.ok ? describe : describe.skip;
if (!probe.ok) console.warn(`[integration.server] dev DB unavailable, skipping history-over-API: ${probe.error}`);

d("BASED-HISTORY: query history via API", () => {
  test("ok and error executions are recorded most-recent-first", async () => {
    const { id: _omit, createdAt: _c, updatedAt: _u, ...input } = devCfg;
    const created = (await (
      await api("/api/connections", { method: "POST", body: JSON.stringify(input) })
    ).json()) as ConnectionConfig;

    const conn = await api("/api/session/connect", {
      method: "POST",
      body: JSON.stringify({ connectionId: created.id }),
    });
    expect(conn.status).toBe(200);

    const q1 = await api("/api/session/query", { method: "POST", body: JSON.stringify({ sql: "SELECT 1 AS a" }) });
    expect(q1.status).toBe(200);
    await q1.text(); // drain the NDJSON stream to completion

    const q2 = await api("/api/session/query", { method: "POST", body: JSON.stringify({ sql: "SELECT FROM" }) });
    await q2.text();

    const hist = (await (await api(`/api/history?connectionId=${created.id}`)).json()) as Array<{
      sql: string;
      status: string;
      durationMs: number;
      error: string | null;
    }>;
    expect(hist.length).toBe(2);
    expect(hist[0]!.sql).toBe("SELECT FROM");
    expect(hist[0]!.status).toBe("error");
    expect(hist[0]!.error).toMatch(/syntax/i);
    expect(hist[1]!.status).toBe("ok");
    expect(hist[1]!.durationMs).toBeGreaterThanOrEqual(0);

    await api("/api/session/disconnect", { method: "POST" });
  }, 120_000);
});

// --- table-edit endpoint: needs CREATE/DROP TABLE; probes once and self-skips otherwise ---
let canWrite = false;
if (probe.ok) {
  const a = new MssqlAdapter(devCfg, () => null);
  const name = `based_spec_srv_probe_${Date.now()}`;
  try {
    const r = await a.runCommands([{ sql: `CREATE TABLE dbo.[${name}] (id int PRIMARY KEY)` }]);
    canWrite = r.error === null;
    await a.runCommands([{ sql: `DROP TABLE dbo.[${name}]` }]);
  } catch {
    canWrite = false;
  } finally {
    await a.disconnect().catch(() => {});
  }
  if (!canWrite) console.warn("[integration.server] no CREATE TABLE permission, skipping table-edit endpoint test");
}
const dw = canWrite ? describe : describe.skip;

dw("BASED-TABLE-COMMIT: table-edit endpoint applies changes and records history", () => {
  test("commit an insert+update+delete via the endpoint; a history row is recorded", async () => {
    const { id: _i, createdAt: _c, updatedAt: _u, ...input } = devCfg;
    const created = (await (await api("/api/connections", { method: "POST", body: JSON.stringify(input) })).json()) as ConnectionConfig;
    await api("/api/session/connect", { method: "POST", body: JSON.stringify({ connectionId: created.id }) });

    const tbl = `based_spec_srv_edit_${Date.now()}`;
    const create = await api("/api/session/query", {
      method: "POST",
      body: JSON.stringify({ sql: `CREATE TABLE dbo.[${tbl}] (id int PRIMARY KEY, name nvarchar(50))` }),
    });
    await create.text();
    const seed = await api("/api/session/query", {
      method: "POST",
      body: JSON.stringify({ sql: `INSERT INTO dbo.[${tbl}] (id,name) VALUES (1,'a'),(2,'b')` }),
    });
    await seed.text();

    const columns = [
      { name: "id", isPrimaryKey: true },
      { name: "name", isPrimaryKey: false },
    ];
    const change = {
      schema: "dbo",
      table: tbl,
      columns,
      inserts: [{ id: 3, name: "c" }],
      updates: [{ key: { id: 1 }, set: { name: "A" } }],
      deletes: [{ id: 2 }],
    };

    const res = await api("/api/session/table-edit", { method: "POST", body: JSON.stringify(change) });
    expect(res.status).toBe(200);
    const out = (await res.json()) as { status: string; error: string | null };
    expect(out.status).toBe("ok");
    expect(out.error).toBeNull();

    // A subsequent read reflects all three changes.
    const dataRes = await api(`/api/session/table-data?schema=dbo&table=${tbl}&offset=0&limit=100`);
    const page = (await dataRes.json()) as { rows: unknown[][] };
    const ids = page.rows.map((r) => r[0]);
    expect(ids).toContain(3);
    expect(ids).not.toContain(2);
    const row1 = page.rows.find((r) => r[0] === 1);
    expect(row1?.[1]).toBe("A");

    // BASED-TABLE-COMMIT: a history row is recorded for the commit.
    const hist = (await (await api(`/api/history?connectionId=${created.id}`)).json()) as Array<{ sql: string }>;
    expect(hist.some((h) => /UPDATE|INSERT|DELETE/.test(h.sql))).toBe(true);

    // preview does not execute
    const preview = await api("/api/session/table-edit", {
      method: "POST",
      body: JSON.stringify({ ...change, deletes: [], inserts: [{ id: 9, name: "z" }], updates: [], preview: true }),
    });
    const previewOut = (await preview.json()) as { commands: Array<{ sql: string }> };
    expect(previewOut.commands[0]!.sql).toContain("INSERT INTO [dbo]");
    const afterPreview = await api(`/api/session/table-data?schema=dbo&table=${tbl}&offset=0&limit=100`);
    const afterRows = (await afterPreview.json()) as { rows: unknown[][] };
    expect(afterRows.rows.some((r) => r[0] === 9)).toBe(false); // preview didn't insert

    // no-PK edit is rejected as a 400 (build failure), not a 500
    const noPk = await api("/api/session/table-edit", {
      method: "POST",
      body: JSON.stringify({ schema: "dbo", table: tbl, columns: [{ name: "name", isPrimaryKey: false }], deletes: [{ name: "a" }] }),
    });
    expect(noPk.status).toBe(400);

    await api("/api/session/query", { method: "POST", body: JSON.stringify({ sql: `DROP TABLE dbo.[${tbl}]` }) }).then((r) => r.text());
    await api("/api/session/disconnect", { method: "POST" });
  }, 120_000);
});

dw("BASED-SCRIPT-API + BASED-TABLE-DETAILS: scripting endpoints", () => {
  test("multi-object script joins with GO in order; per-object failures collect; table-details returns createScript", async () => {
    const { id: _i, createdAt: _c, updatedAt: _u, ...input } = devCfg;
    const created = (await (await api("/api/connections", { method: "POST", body: JSON.stringify(input) })).json()) as ConnectionConfig;
    await api("/api/session/connect", { method: "POST", body: JSON.stringify({ connectionId: created.id }) });

    const t1 = `based_spec_scr_a_${Date.now()}`;
    const t2 = `based_spec_scr_b_${Date.now()}`;
    const vw = `based_spec_scr_v_${Date.now()}`;
    const run = (sql: string) => api("/api/session/query", { method: "POST", body: JSON.stringify({ sql }) }).then((r) => r.text());
    await run(`CREATE TABLE dbo.[${t1}] (id int PRIMARY KEY, name nvarchar(20))`);
    await run(`CREATE TABLE dbo.[${t2}] (id int PRIMARY KEY)`);
    await run(`CREATE VIEW dbo.[${vw}] AS SELECT id FROM dbo.[${t1}]`);

    try {
      // multi-object create: GO-joined, request order
      const res = await api("/api/session/script", {
        method: "POST",
        body: JSON.stringify({
          objects: [
            { schema: "dbo", name: t1, type: "table" },
            { schema: "dbo", name: t2, type: "table" },
          ],
          action: "create",
        }),
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as { sql: string; errors: unknown[] };
      expect(out.errors).toEqual([]);
      const i1 = out.sql.indexOf(`CREATE TABLE [dbo].[${t1}]`);
      const i2 = out.sql.indexOf(`CREATE TABLE [dbo].[${t2}]`);
      expect(i1).toBeGreaterThanOrEqual(0);
      expect(i2).toBeGreaterThan(i1);
      expect(out.sql.slice(i1, i2)).toContain("\nGO\n");

      // view alter: CREATE→ALTER rewrite via sql_modules
      const alterRes = await api("/api/session/script", {
        method: "POST",
        body: JSON.stringify({ objects: [{ schema: "dbo", name: vw, type: "view" }], action: "alter" }),
      });
      const alterOut = (await alterRes.json()) as { sql: string; errors: unknown[] };
      expect(alterOut.errors).toEqual([]);
      expect(alterOut.sql).toMatch(/ALTER\s+VIEW/i);

      // one good + one unknown → good scripts, bad collects
      const mixed = await api("/api/session/script", {
        method: "POST",
        body: JSON.stringify({
          objects: [
            { schema: "dbo", name: t1, type: "table" },
            { schema: "dbo", name: "based_spec_missing_xyz", type: "table" },
          ],
          action: "create",
        }),
      });
      const mixedOut = (await mixed.json()) as { sql: string; errors: Array<{ name: string }> };
      expect(mixedOut.sql).toContain(`CREATE TABLE [dbo].[${t1}]`);
      expect(mixedOut.errors.length).toBe(1);
      expect(mixedOut.errors[0]!.name).toBe("based_spec_missing_xyz");

      // table-details endpoint: details + server-computed createScript (null for a view)
      const det = await api(`/api/session/table-details?schema=dbo&table=${t1}`);
      expect(det.status).toBe(200);
      const detOut = (await det.json()) as { details: { columns: unknown[] }; createScript: string | null };
      expect(detOut.details.columns.length).toBe(2);
      expect(detOut.createScript).toContain(`CREATE TABLE [dbo].[${t1}]`);
      const detView = (await (await api(`/api/session/table-details?schema=dbo&table=${vw}`)).json()) as {
        createScript: string | null;
      };
      expect(detView.createScript).toBeNull();
    } finally {
      await run(`DROP VIEW dbo.[${vw}]`);
      await run(`DROP TABLE dbo.[${t1}]`);
      await run(`DROP TABLE dbo.[${t2}]`);
      await api("/api/session/disconnect", { method: "POST" });
    }
  }, 120_000);
});

dw("BASED-IMPORT-CSV-RUN: inspect + batched transactional import", () => {
  test("atomic import, rollback on bad value, skip-bad-rows accounting", async () => {
    const { id: _i, createdAt: _c, updatedAt: _u, ...input } = devCfg;
    const created = (await (await api("/api/connections", { method: "POST", body: JSON.stringify(input) })).json()) as ConnectionConfig;
    await api("/api/session/connect", { method: "POST", body: JSON.stringify({ connectionId: created.id }) });

    const tbl = `based_spec_imp_${Date.now()}`;
    const run = (sql: string) => api("/api/session/query", { method: "POST", body: JSON.stringify({ sql }) }).then((r) => r.text());
    await run(`CREATE TABLE dbo.[${tbl}] (id int PRIMARY KEY, name nvarchar(50) NULL, qty int NULL)`);

    const dir = mkdtempSync(join(tmpdir(), "based-spec-csv-"));
    const goodCsv = join(dir, "good.csv");
    await Bun.write(goodCsv, 'id,name,qty\r\n1,"a,b",10\r\n2,,\r\n3,"he said ""hi""",30\r\n');

    const mapping = [
      { csvIndex: 0, column: "id" },
      { csvIndex: 1, column: "name" },
      { csvIndex: 2, column: "qty" },
    ];

    try {
      // inspect returns header + sample
      const inspect = (await (
        await api("/api/import/csv/inspect", { method: "POST", body: JSON.stringify({ path: goodCsv }) })
      ).json()) as { header: string[]; rows: string[][] };
      expect(inspect.header).toEqual(["id", "name", "qty"]);
      expect(inspect.rows.length).toBe(3);

      // atomic import
      const res = await api("/api/import/csv/run", {
        method: "POST",
        body: JSON.stringify({ path: goodCsv, schema: "dbo", table: tbl, hasHeader: true, mapping, nullEmpty: true, skipBadRows: false }),
      });
      expect(res.status).toBe(200);
      const chunks = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as { type: string; status?: string; inserted?: number });
      const done = chunks.find((c) => c.type === "done")!;
      expect(done.status).toBe("ok");
      expect(done.inserted).toBe(3);

      const page = (await (await api(`/api/session/table-data?schema=dbo&table=${tbl}&offset=0&limit=100`)).json()) as {
        rows: unknown[][];
      };
      expect(page.rows.length).toBe(3);
      expect(page.rows.find((r) => r[0] === 1)?.[1]).toBe("a,b");
      expect(page.rows.find((r) => r[0] === 2)?.[1]).toBeNull(); // empty + nullEmpty → NULL
      expect(page.rows.find((r) => r[0] === 3)?.[1]).toBe('he said "hi"');

      // bad numeric value, atomic mode → nothing committed, error names the CSV row
      const badCsv = join(dir, "bad.csv");
      await Bun.write(badCsv, "id,name,qty\r\n10,x,1\r\n11,y,notanumber\r\n12,z,3\r\n");
      const bad = await api("/api/import/csv/run", {
        method: "POST",
        body: JSON.stringify({ path: badCsv, schema: "dbo", table: tbl, hasHeader: true, mapping, nullEmpty: true, skipBadRows: false }),
      });
      const badChunks = (await bad.text()).trim().split("\n").map((l) => JSON.parse(l) as { type: string; status?: string; error?: string; row?: number });
      const badDone = badChunks.find((c) => c.type === "done")!;
      expect(badDone.status).toBe("error");
      expect(badDone.error).toContain("Row 3");
      expect(badChunks.find((c) => c.type === "rowError")?.row).toBe(3);
      const after = (await (await api(`/api/session/table-data?schema=dbo&table=${tbl}&offset=0&limit=100`)).json()) as {
        rows: unknown[][];
      };
      expect(after.rows.some((r) => r[0] === 10)).toBe(false); // nothing committed

      // skipBadRows imports the good rows and reports the bad
      const skip = await api("/api/import/csv/run", {
        method: "POST",
        body: JSON.stringify({ path: badCsv, schema: "dbo", table: tbl, hasHeader: true, mapping, nullEmpty: true, skipBadRows: true }),
      });
      const skipChunks = (await skip.text()).trim().split("\n").map((l) => JSON.parse(l) as { type: string; status?: string; inserted?: number; failed?: number });
      const skipDone = skipChunks.find((c) => c.type === "done")!;
      expect(skipDone.status).toBe("ok");
      expect(skipDone.inserted).toBe(2);
      expect(skipDone.failed).toBe(1);

      // a history summary row was recorded
      const hist = (await (await api(`/api/history?connectionId=${created.id}`)).json()) as Array<{ sql: string }>;
      expect(hist.some((h) => h.sql.includes("import csv"))).toBe(true);
    } finally {
      await run(`DROP TABLE dbo.[${tbl}]`);
      await api("/api/session/disconnect", { method: "POST" });
    }
  }, 120_000);
});

// Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — the Data tab's search panel sends no profile id until
// the user picks one, so the route must fall back to the connected connection's default the same way
// the agent tools do. File-based LanceDB needs no external service, so this always runs.
describe("BASED-LANCE-CONN-DEFAULT-PROFILES: lance-search route honors the connection's default", () => {
  const SID = "lance-defaults";
  const DIM = 8;
  const target = Array.from({ length: DIM }, (_, j) => Math.sin(12 * 0.7 + j * 0.13));

  test("a vector search with no embeddingProfileId embeds via the connection's profile; deleting it sweeps the reference", async () => {
    const lancedb = await import("@lancedb/lancedb");
    const dir = mkdtempSync(join(tmpdir(), "based-srv-lance-"));
    const ldb = await lancedb.connect(dir);
    await ldb.createTable(
      "docs",
      Array.from({ length: 20 }, (_, i) => ({
        id: i,
        text: `document ${i}`,
        vector: Array.from({ length: DIM }, (_, j) => Math.sin(i * 0.7 + j * 0.13)),
      })),
      { mode: "overwrite" },
    );

    const embedSrv = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { input?: unknown };
        const inputs = Array.isArray(body.input) ? body.input : [body.input];
        return Response.json({
          data: inputs.map((_, index) => ({ object: "embedding", index, embedding: target })),
          model: "stub-embed",
          usage: { prompt_tokens: 1, total_tokens: 1 },
        });
      },
    });

    try {
      const profile = (await (
        await api("/api/embedding-profiles", {
          method: "POST",
          body: JSON.stringify({ name: "stub", baseUrl: `http://127.0.0.1:${embedSrv.port}/v1`, model: "stub-embed" }),
        })
      ).json()) as { id: string };

      const conn = (await (
        await api("/api/connections", {
          method: "POST",
          body: JSON.stringify({
            name: "srv-lance",
            server: "",
            database: "lancedb",
            engine: "lancedb",
            authType: "lancedb-local",
            uri: dir,
            encrypt: false,
            trustServerCertificate: false,
            defaultEmbeddingProfileId: profile.id,
          } satisfies ConnectionInput),
        })
      ).json()) as ConnectionConfig;
      expect(conn.defaultEmbeddingProfileId).toBe(profile.id);

      const connected = await api(`/api/session/connect?sid=${SID}`, { method: "POST", body: JSON.stringify({ connectionId: conn.id }) });
      expect(connected.status).toBe(200);

      // No embeddingProfileId in the body — the connection's default must supply it.
      const res = await api(`/api/session/lance-search?sid=${SID}`, {
        method: "POST",
        body: JSON.stringify({ table: "docs", mode: "vector", query: "anything", keepSize: 2 }),
      });
      expect(res.status).toBe(200);
      const found = (await res.json()) as { columns: Array<{ name: string }>; rows: unknown[][] };
      const idIdx = found.columns.findIndex((c) => c.name === "id");
      expect(found.rows[0]![idIdx]).toBe(12);

      // Deleting the profile clears it off the connection and degrades the same search to a
      // descriptive error instead of "Unknown embedding profile".
      expect((await api(`/api/embedding-profiles/${profile.id}`, { method: "DELETE" })).status).toBe(200);
      const conns = (await (await api("/api/connections")).json()) as ConnectionConfig[];
      expect(conns.find((c) => c.id === conn.id)!.defaultEmbeddingProfileId).toBeNull();

      const after = await api(`/api/session/lance-search?sid=${SID}`, {
        method: "POST",
        body: JSON.stringify({ table: "docs", mode: "vector", query: "anything", keepSize: 2 }),
      });
      expect(after.status).toBe(400);
      const err = (await after.json()) as { error: string };
      expect(err.error).toMatch(/embedding profile/i);
      expect(err.error).not.toMatch(/unknown embedding profile/i);
    } finally {
      embedSrv.stop(true);
      await api(`/api/session/disconnect?sid=${SID}`, { method: "POST" });
    }
  }, 120_000);
});

describe("BASED-UI-SESSION-RESUME: session-lost signal", () => {
  // A server restart wipes in-memory sessions; a fresh sid that never connected reproduces that exact
  // state (no adapter). The endpoint must answer with the distinct 409 `session-lost` the client keys on
  // to auto-resume + retry — NOT a generic 500 — so a wiped session heals instead of surfacing an error.
  test("a session-scoped request with no adapter returns 409 session-lost", async () => {
    const res = await api("/api/session/objects?sid=resume-probe");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("session-lost");
  });
});
