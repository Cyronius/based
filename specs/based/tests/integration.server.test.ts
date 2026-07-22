// Traces: BASED-API-AUTH, BASED-HISTORY, BASED-CONN-TEST (endpoint), BASED-SECRET-STORE (delete via API)
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startServer, getSecret, testConnection } from "@based/core";
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
      { id: "st1", connectionId: "conn-a", title: "Q1", content: "SELECT 1", filePath: null, position: 0 },
      { id: "st2", connectionId: "conn-a", title: "Q2", content: "SELECT 2", filePath: null, position: 1 },
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
