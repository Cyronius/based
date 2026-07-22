// Traces: BASED-API-AUTH, BASED-HISTORY, BASED-CONN-TEST (endpoint), BASED-SECRET-STORE (delete via API),
//         BASED-TABLE-COMMIT (endpoint + history row)
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startServer, getSecret, testConnection, MssqlAdapter } from "@based/core";
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
    await api("/api/tabs", { method: "POST", body: JSON.stringify({ tabs }) });
    const listed = (await (await api("/api/tabs?connectionId=conn-a")).json()) as Array<{ id: string }>;
    expect(listed.map((t) => t.id)).toEqual(["st1", "st2"]);
    await api("/api/tabs/st1", { method: "DELETE" });
    const after = (await (await api("/api/tabs?connectionId=conn-a")).json()) as Array<{ id: string }>;
    expect(after.map((t) => t.id)).toEqual(["st2"]);
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
