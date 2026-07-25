// Traces: BASED-LSP-TRANSPORT, BASED-LSP-DUCKDB
// Drives the /api/lsp WebSocket end-to-end against a real server and a temp-seeded Lance dir: the
// upgrade gating, the JSON-RPC handshake, and the in-house DuckDB language server's completions +
// hover sourced from the attached catalog. (The sqls/MSSQL backend needs a live SQL Server and is
// covered by the env-gated MSSQL suite pattern + manual procedure — see BASED-LSP-MSSQL.)
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as lancedb from "@lancedb/lancedb";
import { startServer } from "@based/core";

const dir = mkdtempSync(join(tmpdir(), "based-lsp-lance-"));
const appDir = mkdtempSync(join(tmpdir(), "based-lsp-app-"));
const TOKEN = "lsp-spec-token";
const server = startServer({ token: TOKEN, dbPath: join(appDir, "app.db"), agentDbPath: join(appDir, "agent.db") });
const base = server.url;
let connectionId = "";

beforeAll(async () => {
  const db = await lancedb.connect(dir);
  await db.createTable(
    "docs",
    Array.from({ length: 10 }, (_, i) => ({
      id: i,
      text: `doc ${i}`,
      vector: Array.from({ length: 4 }, (_, j) => i + j * 0.1),
    })),
    { mode: "overwrite" },
  );

  const res = await fetch(`${base}/api/connections?sid=lsp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      name: "lsp-lance",
      server: "",
      database: "lancedb",
      engine: "lancedb",
      authType: "lancedb-local",
      uri: dir,
      encrypt: false,
      trustServerCertificate: false,
    }),
  });
  connectionId = ((await res.json()) as { id: string }).id;
  const conn = await fetch(`${base}/api/session/connect?sid=lsp`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({ connectionId }),
  });
  expect(conn.ok).toBe(true);
});

afterAll(async () => {
  await server.stop();
});

/** Minimal test-side LSP client over the WebSocket. */
class TestLsp {
  private ws: WebSocket;
  private nextId = 1;
  private pending = new Map<number, (result: unknown) => void>();
  readonly opened: Promise<void>;
  readonly closed: Promise<{ code: number }>;

  constructor(sid: string, token = TOKEN) {
    this.ws = new WebSocket(`${base.replace("http", "ws")}/api/lsp?sid=${sid}&token=${token}`);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener("open", () => resolve());
      this.ws.addEventListener("error", () => reject(new Error("ws error")));
    });
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener("close", (e) => resolve({ code: (e as CloseEvent).code }));
    });
    this.ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String((e as MessageEvent).data)) as { id?: number; result?: unknown };
      if (msg.id != null && this.pending.has(msg.id)) {
        this.pending.get(msg.id)!(msg.result);
        this.pending.delete(msg.id);
      }
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000);
      this.pending.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      this.ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  }

  notify(method: string, params?: unknown): void {
    this.ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
  }

  close(): void {
    this.ws.close();
  }
}

// Traces: BASED-LSP-MSSQL-NATIVE — the in-house MSSQL server driven as plain JSON-RPC against a
// real dev-DB adapter over azure-cli auth: the exact configuration the old sqls bridge could
// never serve (or test). Self-skips without the dev DB, like integration.mssql.
import { MssqlAdapter } from "@based/core/mssql";
import { testConnection } from "@based/core";
import { MssqlLspServer } from "../../../core/src/lsp/mssqlLsp";
import type { ConnectionConfig, JsonRpcMessage } from "@based/core";

const devCfg: ConnectionConfig = {
  id: "spec-lsp-dev",
  name: "spec-lsp-dev",
  server: process.env.BASED_TEST_SERVER ?? "zl5qolt7t8.database.windows.net",
  database: process.env.BASED_TEST_DB ?? "learnermobile_db_ci",
  authType: "azure-cli",
  encrypt: true,
  trustServerCertificate: false,
  createdAt: "",
  updatedAt: "",
};
const devProbe = await testConnection(devCfg, () => null);
const dm = devProbe.ok ? describe : describe.skip;
if (!devProbe.ok) console.warn(`[integration.lsp] dev DB unavailable, skipping mssql-native suite: ${devProbe.error}`);

dm("BASED-LSP-MSSQL-NATIVE: in-house server against the dev DB (Entra-token auth)", () => {
  test("initialize, object/column completions, hover, JSON-RPC errors for unknown methods", async () => {
    const adapter = new MssqlAdapter(devCfg, () => null);
    const outbox: JsonRpcMessage[] = [];
    const server = new MssqlLspServer(
      { listObjects: () => adapter.listObjects(), listAllColumns: () => adapter.listAllColumns() },
      (m) => outbox.push(m),
    );
    const request = (id: number, method: string, params?: unknown) =>
      server.onClientMessage(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    const notify = (method: string, params: unknown) =>
      server.onClientMessage(JSON.stringify({ jsonrpc: "2.0", method, params }));
    const waitFor = async (id: number): Promise<{ result?: unknown; error?: { code: number } }> => {
      for (let i = 0; i < 400; i++) {
        const found = outbox.find((m) => "id" in m && m.id === id);
        if (found) return found as { result?: unknown; error?: { code: number } };
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`No response for request ${id}`);
    };

    try {
      // A known table to anchor the assertions.
      const objects = await adapter.listObjects();
      const known = objects.find((o) => o.type === "table")!;
      const knownColumns = await adapter.getTableColumns(known.schema, known.name);
      const knownCol = knownColumns[0]!.name;
      const label = known.schema === "dbo" ? known.name : `${known.schema}.${known.name}`;

      request(1, "initialize", { capabilities: {} });
      const init = (await waitFor(1)).result as { capabilities: { completionProvider?: unknown; hoverProvider?: boolean } };
      expect(init.capabilities.completionProvider).toBeTruthy();
      expect(init.capabilities.hoverProvider).toBe(true);
      notify("initialized", {});

      const uri = "based:///lsp-test.sql";
      const text = `SELECT * FROM `;
      notify("textDocument/didOpen", { textDocument: { uri, languageId: "sql", version: 1, text } });

      // after FROM → objects include the known table
      request(2, "textDocument/completion", { textDocument: { uri }, position: { line: 0, character: text.length } });
      const comp = (await waitFor(2)).result as { items: Array<{ label: string }> };
      expect(comp.items.some((i) => i.label === label)).toBe(true);

      // alias. → that table's columns
      const aliased = `SELECT t. FROM ${known.schema}.${known.name} t`;
      notify("textDocument/didChange", { textDocument: { uri, version: 2 }, contentChanges: [{ text: aliased }] });
      request(3, "textDocument/completion", { textDocument: { uri }, position: { line: 0, character: "SELECT t.".length } });
      const cols = (await waitFor(3)).result as { items: Array<{ label: string }> };
      expect(cols.items.some((i) => i.label === knownCol)).toBe(true);

      // hover on the table name → markdown naming a known column
      const hoverDoc = `SELECT * FROM ${known.name}`;
      notify("textDocument/didChange", { textDocument: { uri, version: 3 }, contentChanges: [{ text: hoverDoc }] });
      request(4, "textDocument/hover", {
        textDocument: { uri },
        position: { line: 0, character: hoverDoc.length - 1 },
      });
      const hover = (await waitFor(4)).result as { contents: { value: string } } | null;
      expect(hover?.contents.value).toContain(known.name);
      expect(hover?.contents.value).toContain(knownCol);

      // unknown methods get JSON-RPC errors, not silence
      request(5, "textDocument/definition", { textDocument: { uri }, position: { line: 0, character: 0 } });
      const unknown = await waitFor(5);
      expect(unknown.error?.code).toBe(-32601);
    } finally {
      server.dispose();
      await adapter.disconnect();
    }
  }, 120_000);
});

// Traces: BASED-SCRIPT-API — an engine without capabilities.script (LanceDB) gets a 400 from the
// scripting endpoints. Lives here because this file already holds a live LanceDB session over the
// server (canonical spec: specs/based/spec.md).
describe("BASED-SCRIPT-API: capability gating on a LanceDB session", () => {
  test("script + table-details endpoints 400 on an engine without script capability", async () => {
    const script = await fetch(`${base}/api/session/script?sid=lsp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ objects: [{ schema: "", name: "docs", type: "table" }], action: "create" }),
    });
    expect(script.status).toBe(400);
    const det = await fetch(`${base}/api/session/table-details?sid=lsp&schema=&table=docs`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(det.status).toBe(400);
  });
});

describe("LSP over WebSocket", () => {
  test("BASED-LSP-TRANSPORT: bad token is refused; un-connected sid is refused", async () => {
    const bad = new TestLsp("lsp", "wrong-token");
    await expect(bad.opened).rejects.toThrow();

    const unconnected = new TestLsp("never-connected-sid");
    await expect(unconnected.opened).rejects.toThrow();
  });

  test("BASED-LSP-DUCKDB: initialize → completions include the Lance table; hover describes it", async () => {
    const lsp = new TestLsp("lsp");
    await lsp.opened;
    const init = (await lsp.request("initialize", {
      processId: null,
      capabilities: { general: { positionEncodings: ["utf-16"] } },
    })) as { capabilities: { completionProvider?: unknown; hoverProvider?: boolean } };
    expect(init.capabilities.completionProvider).toBeTruthy();
    expect(init.capabilities.hoverProvider).toBe(true);
    lsp.notify("initialized", {});

    const uri = "based:///tab-1.sql";
    lsp.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "sql", version: 1, text: "SELECT * FROM " },
    });
    const completion = (await lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 14 },
    })) as { items: Array<{ label: string; kind?: number }> };
    expect(completion.items.map((i) => i.label)).toContain("docs");

    // Hover over the table name in a doc that mentions it.
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 2 },
      contentChanges: [{ text: "SELECT * FROM docs" }],
    });
    const hover = (await lsp.request("textDocument/hover", {
      textDocument: { uri },
      position: { line: 0, character: 16 },
    })) as { contents: { value: string } } | null;
    expect(hover?.contents.value).toMatch(/docs/);
    expect(hover?.contents.value).toMatch(/vector/i);

    // Column completion after the table alias pattern (catalog fallback path exercises `d.` too).
    lsp.notify("textDocument/didChange", {
      textDocument: { uri, version: 3 },
      contentChanges: [{ text: "SELECT docs. FROM docs" }],
    });
    const colCompletion = (await lsp.request("textDocument/completion", {
      textDocument: { uri },
      position: { line: 0, character: 12 },
    })) as { items: Array<{ label: string }> };
    expect(colCompletion.items.map((i) => i.label)).toContain("text");

    lsp.close();
  }, 120_000);

  test("BASED-LSP-TRANSPORT: disconnecting the session closes the LSP socket", async () => {
    const lsp = new TestLsp("lsp");
    await lsp.opened;
    await lsp.request("initialize", { processId: null, capabilities: {} });
    await fetch(`${base}/api/session/disconnect?sid=lsp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    // terminate() (abrupt, code 1006) is deliberate: a server-initiated graceful close wedges
    // Bun's server.stop(force) — see closeForSession in core/src/lsp/index.ts.
    const { code } = await lsp.closed;
    expect(typeof code).toBe("number");
    // Reconnect for any later suites sharing the session.
    await fetch(`${base}/api/session/connect?sid=lsp`, {
      method: "POST",
      headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ connectionId }),
    });
  }, 120_000);
});
