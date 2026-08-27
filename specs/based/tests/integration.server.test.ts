// Traces: BASED-API-AUTH, BASED-HISTORY, BASED-CONN-TEST (endpoint), BASED-SECRET-STORE (delete via API),
//         BASED-TABLE-COMMIT (endpoint + history row), BASED-UI-SESSION-RESUME (session-lost signal)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startServer, getSecret } from "@based/core";
import { MssqlAdapter } from "@based/core/mssql";
import type { ConnectionInput, ConnectionConfig } from "@based/core";
import { DEV_DB_AVAILABLE, devConnection, warnDevDbSkip } from "./_devDb";

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

  // Traces: BASED-CHAT-TRANSCRIPT-UI — explicit-path mode (the Save As dialog path is manual).
  // The server, not the client, renders the markdown; that is what keeps the button's output
  // identical to the save_chat_transcript tool's.
  test("save-transcript renders the posted messages as markdown at the given path", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "based-spec-chat-")), "chat.md");
    const messages = [
      { id: "1", role: "user", content: "how many orders?" },
      { id: "2", role: "assistant", toolCalls: [{ id: "t1", type: "function", function: { name: "run_query", arguments: "{}" } }] },
      { id: "3", role: "tool", toolCallId: "t1", content: '{"rowCount":1204}' },
      { id: "4", role: "assistant", content: "1,204 orders." },
    ];
    const saved = (await (
      await api("/api/file/save-transcript", { method: "POST", body: JSON.stringify({ messages, title: "Orders", path }) })
    ).json()) as { path: string | null };
    expect(saved.path).toBe(path);

    const written = await Bun.file(path).text();
    expect(written.startsWith("# Orders\n")).toBe(true);
    expect(written).toContain("## You\n\nhow many orders?");
    expect(written).toContain("## Capi\n\n1,204 orders.");
    // Prose only: the tool call and its result are not part of the document.
    expect(written).not.toContain("run_query");
    expect(written).not.toContain("rowCount");
    expect(written.match(/^## .+$/gm)).toEqual(["## You", "## Capi"]);
  });

  test("save-transcript without a messages array is a 400", async () => {
    const res = await api("/api/file/save-transcript", { method: "POST", body: JSON.stringify({ title: "nope" }) });
    expect(res.status).toBe(400);
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
const devCfg: ConnectionConfig = devConnection("spec-srv-dev");
const d = DEV_DB_AVAILABLE ? describe : describe.skip;
if (!DEV_DB_AVAILABLE) warnDevDbSkip("integration.server", "history-over-API");

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
if (DEV_DB_AVAILABLE) {
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

// Traces: BASED-AGENT-MUTATION-GATE, BASED-INDEX-INTROSPECT, BASED-LANCE-SCAN, BASED-CAPABILITIES-WIRE
// The server-side gates and the two new read routes, against a real read-only LanceDB connection.
//
// The mutation gate is the one that mattered: /api/agent/mutation was the ONLY write path with no
// capabilities.write check — CSV import and grid edit both had one. So on a LOCAL LanceDB connection
// an approved mutation went straight into the DuckDB/Lance bridge; only cloud was saved, and only by
// accident (execute emits an error chunk there). "Read-only" was being enforced by the frontend
// simply not offering the tool — except it offered it unconditionally.
describe("BASED-AGENT-MUTATION-GATE: writes are refused on a read-only connection", () => {
  const SID = "lance-gate";
  let connectionId = "";

  beforeAll(async () => {
    const lancedb = await import("@lancedb/lancedb");
    const dir = mkdtempSync(join(tmpdir(), "based-srv-gate-"));
    const ldb = await lancedb.connect(dir);
    await ldb.createTable(
      "docs",
      Array.from({ length: 12 }, (_, i) => ({ id: i, text: `document ${i}` })),
      { mode: "overwrite" },
    );
    const conn = (await (
      await api("/api/connections", {
        method: "POST",
        body: JSON.stringify({
          name: "srv-lance-gate",
          server: "",
          database: "lancedb",
          engine: "lancedb",
          authType: "lancedb-local",
          uri: dir,
          encrypt: false,
          trustServerCertificate: false,
        } satisfies ConnectionInput),
      })
    ).json()) as ConnectionConfig;
    connectionId = conn.id;
    const connected = await api(`/api/session/connect?sid=${SID}`, {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    expect(connected.status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await api(`/api/session/disconnect?sid=${SID}`, { method: "POST" });
  });

  test("an APPROVED mutation is still refused when the engine cannot write", async () => {
    // approved:true is the user having clicked Approve. The gate is not about consent — the user
    // consented — it is about the connection being incapable.
    const res = await api(`/api/agent/mutation?sid=${SID}`, {
      method: "POST",
      body: JSON.stringify({ sql: "INSERT INTO docs (id) VALUES (99)", approved: true }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/read-only/i);
  });

  test("the connect response advertises the variant and the read-only capability set", async () => {
    // Traces: BASED-CAPABILITIES-WIRE — everything the agent surface and the UI gate on rides here.
    const state = (await (await api(`/api/session/state?sid=${SID}`)).json()) as {
      capabilities: {
        write: boolean;
        sql: boolean;
        engine: string;
        variant: string;
        wherePredicate: boolean;
        structuredFilters: boolean;
        countRows: boolean;
        indexIntrospect: boolean;
      };
    };
    expect(state.capabilities.write).toBe(false);
    expect(state.capabilities.engine).toBe("lancedb");
    expect(state.capabilities.variant).toBe("lancedb-local");
    expect(state.capabilities.wherePredicate).toBe(true);
    expect(state.capabilities.structuredFilters).toBe(false);
    expect(state.capabilities.countRows).toBe(true);
    expect(state.capabilities.indexIntrospect).toBe(true);
  });

  test("GET /api/session/row-count returns the total and honours a where predicate", async () => {
    const all = (await (await api(`/api/session/row-count?sid=${SID}&schema=&table=docs`)).json()) as { count: number };
    expect(all.count).toBe(12);
    const some = (await (
      await api(`/api/session/row-count?sid=${SID}&schema=&table=docs&where=${encodeURIComponent("id < 4")}`)
    ).json()) as { count: number };
    expect(some.count).toBe(4);
  });

  test("GET /api/session/indexes answers on an engine with no DDL scripting", async () => {
    // Deliberately NOT gated on `script` the way /table-details is: LanceDB has no DDL to script but
    // very much has indexes, and their absence is the actionable fact for text/hybrid search.
    const res = await api(`/api/session/indexes?sid=${SID}&schema=&table=docs`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { indexes: unknown[] }).indexes).toEqual([]);
  });

  test("GET /api/session/table-data honours a where predicate", async () => {
    const page = (await (
      await api(`/api/session/table-data?sid=${SID}&schema=&table=docs&offset=0&limit=50&where=${encodeURIComponent("id < 3")}`)
    ).json()) as { rows: unknown[][] };
    expect(page.rows.length).toBe(3);
  });
});

// Traces: BASED-AGENT-LANCE-CREATE, BASED-LANCE-CREATE-TABLE — the create-table routes and their
// gates, against a real local LanceDB connection bootstrapped from an EMPTY directory (which also
// exercises the BASED-LANCE-CONNECT empty-dir bootstrap through the server).
describe("BASED-AGENT-LANCE-CREATE: create-table routes", () => {
  const SID = "lance-create";
  let connectionId = "";

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-srv-create-"));
    const conn = (await (
      await api("/api/connections", {
        method: "POST",
        body: JSON.stringify({
          name: "srv-lance-create",
          server: "",
          database: "lancedb",
          engine: "lancedb",
          authType: "lancedb-local",
          uri: dir,
          encrypt: false,
          trustServerCertificate: false,
        } satisfies ConnectionInput),
      })
    ).json()) as ConnectionConfig;
    connectionId = conn.id;
    const connected = await api(`/api/session/connect?sid=${SID}`, {
      method: "POST",
      body: JSON.stringify({ connectionId }),
    });
    expect(connected.status).toBe(200);
  }, 120_000);

  afterAll(async () => {
    await api(`/api/session/disconnect?sid=${SID}`, { method: "POST" });
  });

  const auditRows = async () =>
    (await (await api(`/api/agent/audit?connectionId=${connectionId}`)).json()) as Array<{
      sql: string;
      kind: string;
      approved: boolean;
      status: string;
    }>;

  test("the connect response advertises the createTable capability", async () => {
    const state = (await (await api(`/api/session/state?sid=${SID}`)).json()) as {
      capabilities: { createTable: boolean; write: boolean };
    };
    expect(state.capabilities.createTable).toBe(true);
    expect(state.capabilities.write).toBe(false); // rows stay read-only
  });

  test("the agent route without approved:true is a 400 and leaves no audit row", async () => {
    const res = await api(`/api/agent/create-table?sid=${SID}`, {
      method: "POST",
      body: JSON.stringify({ name: "sneaky", columns: [{ name: "id", type: "string" }] }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/not approved/i);
    expect((await auditRows()).length).toBe(0);
  });

  test("an approved agent create makes the table and writes an audit row", async () => {
    const res = await api(`/api/agent/create-table?sid=${SID}`, {
      method: "POST",
      body: JSON.stringify({
        approved: true,
        name: "agent_made",
        columns: [
          { name: "id", type: "string" },
          { name: "embedding", type: "vector", dim: 4 },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; columns: Array<{ name: string; isVector?: boolean }> };
    expect(body.status).toBe("ok");
    expect(body.columns.find((c) => c.name === "embedding")?.isVector).toBe(true);

    const rows = await auditRows();
    expect(rows.length).toBe(1);
    expect(rows[0]!.kind).toBe("mutation");
    expect(rows[0]!.approved).toBe(true);
    expect(rows[0]!.sql).toMatch(/create table agent_made/i);

    const { objects } = (await (await api(`/api/session/objects?sid=${SID}`)).json()) as { objects: Array<{ name: string }> };
    expect(objects.map((o) => o.name)).toContain("agent_made");
  });

  test("the dialog route creates without an audit row, and a duplicate name is a 400", async () => {
    const res = await api(`/api/session/create-table?sid=${SID}`, {
      method: "POST",
      body: JSON.stringify({ name: "dialog_made", columns: [{ name: "label", type: "string" }] }),
    });
    expect(res.status).toBe(200);
    expect((await auditRows()).some((r) => /dialog_made/.test(r.sql))).toBe(false);

    const dup = await api(`/api/session/create-table?sid=${SID}`, {
      method: "POST",
      body: JSON.stringify({ name: "dialog_made", columns: [{ name: "label", type: "string" }] }),
    });
    expect(dup.status).toBe(400);
    expect(((await dup.json()) as { error: string }).error).toMatch(/already exists/i);
  });
});

// The capability gate needs an engine WITHOUT createTable, which requires the live dev DB.
const dCreateGate = DEV_DB_AVAILABLE ? describe : describe.skip;
if (!DEV_DB_AVAILABLE) warnDevDbSkip("integration.server", "create-table capability gate");

dCreateGate("BASED-LANCE-CREATE-TABLE: refused on an engine without the capability", () => {
  const SID = "mssql-create-gate";

  test("POST /api/session/create-table on SQL Server is a 400", async () => {
    const { id: _omit, createdAt: _c, updatedAt: _u, ...input } = devConnection("srv-create-gate");
    const created = (await (
      await api("/api/connections", { method: "POST", body: JSON.stringify(input) })
    ).json()) as ConnectionConfig;
    const connected = await api(`/api/session/connect?sid=${SID}`, {
      method: "POST",
      body: JSON.stringify({ connectionId: created.id }),
    });
    expect(connected.status).toBe(200);
    try {
      const res = await api(`/api/session/create-table?sid=${SID}`, {
        method: "POST",
        body: JSON.stringify({ name: "nope", columns: [{ name: "id", type: "string" }] }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toMatch(/does not support creating tables/i);
    } finally {
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

// Traces: BASED-ENGINE-PROFILE-WIRE — the endpoint the connection dialog renders from. The UI holds
// no engine list of its own, so if this payload is wrong or incomplete the dialog silently offers
// the wrong form (or none) rather than failing loudly.
describe("BASED-ENGINE-PROFILE-WIRE: GET /api/engines", () => {
  test("requires auth like every other endpoint", async () => {
    expect((await fetch(`${base}/api/engines`)).status).toBe(401);
  });

  test("serves one renderable profile per registered engine", async () => {
    const res = await api("/api/engines");
    expect(res.status).toBe(200);
    const { engines } = (await res.json()) as { engines: Array<Record<string, unknown>> };
    expect(engines.length).toBeGreaterThan(1);

    const byId = new Map(engines.map((e) => [e.id as string, e]));
    expect([...byId.keys()].sort()).toEqual(["lancedb", "mssql", "snowflake"]);

    for (const engine of engines) {
      const fields = engine.fields as Array<{ key: string; label: string; kind: string }>;
      const authModes = engine.authModes as Array<{ id: string; label: string; secretLabel: string | null }>;
      const namespace = engine.namespace as { key: string | null; default: string; grouping: string };
      const quote = engine.quote as { open: string; close: string; escape: string };

      expect(String(engine.label).trim()).not.toBe("");
      expect(fields.length).toBeGreaterThan(0);
      expect(authModes.length).toBeGreaterThan(0);
      expect(["typed", "flat"]).toContain(namespace.grouping);
      expect(quote.open.length).toBeGreaterThan(0);
      // The dialog renders by `kind` alone, so an unknown kind would render nothing at all.
      for (const f of fields) {
        expect(["text", "password", "select", "checkbox", "directory", "file", "embedding-profile", "reranker-profile"]).toContain(f.kind);
        expect(String(f.label).trim()).not.toBe("");
      }
      // Every profile names a subtitle field it actually declares (the left rail reads it).
      expect(fields.map((f) => f.key)).toContain(engine.subtitleField as string);
    }
  });

  test("Snowflake advertises its three auth modes, and SSO stores no secret", async () => {
    const { engines } = (await (await api("/api/engines")).json()) as {
      engines: Array<{ id: string; authModes: Array<{ id: string; secretLabel: string | null }> }>;
    };
    const snowflake = engines.find((e) => e.id === "snowflake")!;
    const modes = new Map(snowflake.authModes.map((m) => [m.id, m.secretLabel]));
    expect([...modes.keys()].sort()).toEqual(["snowflake-keypair", "snowflake-oauth", "snowflake-password"]);
    expect(modes.get("snowflake-password")).toBe("Password");
    // External-browser SSO must not render a secret input — there is nothing to store.
    expect(modes.get("snowflake-oauth")).toBeNull();
  });
});
