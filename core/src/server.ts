import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { RunAgentInputSchema, type BaseEvent } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { MastraAgent } from "@ag-ui/mastra";
import { openDb } from "./storage/db";
import { ConnectionStore } from "./storage/connections";
import { TabStore } from "./storage/tabs";
import { HistoryStore } from "./storage/history";
import { getSecret, setSecret, deleteSecret, getAiKey, setAiKey, deleteAiKey } from "./secrets";
import { MssqlAdapter, testConnection } from "./db/mssqlAdapter";
import { filterFor, openWithDefaultApp, saveFileDialog } from "./dialogs";
import { toCsv } from "./export/csv";
import { writeXlsx } from "./export/xlsx";
import { AiConfigStore, resolveModel, type AiConfig } from "./agent/provider";
import { AuditStore } from "./agent/audit";
import { createAgentMemory } from "./agent/memory";
import { buildAgent, AGENT_ID } from "./agent/agent";
import { collectQuery } from "./agent/runSql";
import { isReadOnly } from "./db/classify";
import type { ColumnInfo, ConnectionInput, ConnectionStatus, QueryExecution, WireValue } from "./db/types";

export interface ServerOptions {
  port?: number;
  token?: string;
  staticDir?: string;
  dbPath?: string;
  /** LibSQL file for agent memory; defaults to agent.db in the data dir. */
  agentDbPath?: string;
}

export interface RunningServer {
  port: number;
  token: string;
  url: string;
  stop(): Promise<void>;
}

interface SessionState {
  adapter: MssqlAdapter | null;
  connectionId: string | null;
  database: string | null;
  status: ConnectionStatus;
}

const encoder = new TextEncoder();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function startServer(opts: ServerOptions = {}): RunningServer {
  const token = opts.token ?? crypto.randomUUID().replace(/-/g, "");
  const db: Database = openDb(opts.dbPath);
  const connections = new ConnectionStore(db);
  const tabs = new TabStore(db);
  const history = new HistoryStore(db);
  const aiConfig = new AiConfigStore(db);
  const audit = new AuditStore(db);
  const agentMemory = createAgentMemory(opts.agentDbPath);

  const session: SessionState = { adapter: null, connectionId: null, database: null, status: "disconnected" };
  const executions = new Map<string, QueryExecution>();
  const sseClients = new Set<ReadableStreamDefaultController<Uint8Array>>();

  function broadcast(event: Record<string, unknown>): void {
    const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const c of sseClients) {
      try {
        c.enqueue(payload);
      } catch {
        sseClients.delete(c);
      }
    }
  }

  function setStatus(status: ConnectionStatus, detail?: string): void {
    session.status = status;
    broadcast({ type: "connection-status", status, detail: detail ?? null, connectionId: session.connectionId, database: session.database });
  }

  async function connectSession(connectionId: string, database?: string): Promise<void> {
    const cfg = connections.get(connectionId);
    if (!cfg) throw new Error(`Unknown connection: ${connectionId}`);
    if (session.adapter) await session.adapter.disconnect().catch(() => {});
    session.connectionId = connectionId;
    session.database = database ?? cfg.database;
    setStatus("connecting");
    const adapter = new MssqlAdapter(cfg, getSecret, { database: session.database });
    adapter.onStatus((status, detail) => setStatus(status, detail));
    session.adapter = adapter;
    try {
      await adapter.connect();
    } catch (err) {
      session.adapter = null;
      setStatus("disconnected");
      throw err;
    }
  }

  function requireAdapter(): MssqlAdapter {
    if (!session.adapter) throw new Error("Not connected");
    return session.adapter;
  }

  // Traces: BASED-API-AUTH
  function authorized(req: Request, url: URL): boolean {
    const header = req.headers.get("authorization");
    if (header === `Bearer ${token}`) return true;
    return url.searchParams.get("token") === token;
  }

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port ?? 0,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (!path.startsWith("/api/")) return serveStatic(opts.staticDir, path);
      if (!authorized(req, url)) return json({ error: "Unauthorized" }, 401);

      try {
        return await route(req, url, path);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
  });

  async function route(req: Request, url: URL, path: string): Promise<Response> {
    const method = req.method;

    if (path === "/api/health") return json({ ok: true });

    // --- connections ---
    if (path === "/api/connections" && method === "GET") return json(connections.list());
    if (path === "/api/connections" && method === "POST") {
      const input = (await req.json()) as ConnectionInput;
      const saved = connections.save(input);
      if (input.secret) setSecret(saved.id, input.secret);
      return json(saved);
    }
    if (path === "/api/connections/test" && method === "POST") {
      const input = (await req.json()) as ConnectionInput;
      const cfg = {
        ...input,
        id: input.id ?? "test-connection",
        createdAt: "",
        updatedAt: "",
      };
      delete (cfg as { secret?: string }).secret;
      return json(await testConnection(cfg, getSecret, input.secret));
    }
    const connMatch = path.match(/^\/api\/connections\/([^/]+)$/);
    if (connMatch && method === "DELETE") {
      connections.delete(connMatch[1]!);
      deleteSecret(connMatch[1]!);
      return json({ ok: true });
    }

    // --- session ---
    if (path === "/api/session/state") {
      return json({ connectionId: session.connectionId, database: session.database, status: session.status });
    }
    if (path === "/api/session/connect" && method === "POST") {
      const body = (await req.json()) as { connectionId: string; database?: string };
      await connectSession(body.connectionId, body.database);
      const adapter = requireAdapter();
      const [databases, schemas, objects] = await Promise.all([
        adapter.listDatabases(),
        adapter.listSchemas(),
        adapter.listObjects(),
      ]);
      return json({ connectionId: session.connectionId, database: session.database, databases, schemas, objects });
    }
    if (path === "/api/session/disconnect" && method === "POST") {
      if (session.adapter) await session.adapter.disconnect().catch(() => {});
      session.adapter = null;
      session.connectionId = null;
      session.database = null;
      setStatus("disconnected");
      return json({ ok: true });
    }
    if (path === "/api/session/objects") {
      const adapter = requireAdapter();
      const [schemas, objects] = await Promise.all([adapter.listSchemas(), adapter.listObjects()]);
      return json({ schemas, objects });
    }
    if (path === "/api/session/columns") {
      const schema = url.searchParams.get("schema") ?? "dbo";
      const table = url.searchParams.get("table") ?? "";
      return json(await requireAdapter().getTableColumns(schema, table));
    }
    if (path === "/api/session/query" && method === "POST") {
      const body = (await req.json()) as { sql: string };
      return streamQuery(body.sql);
    }
    if (path === "/api/session/cancel" && method === "POST") {
      const body = (await req.json()) as { queryId: string };
      executions.get(body.queryId)?.cancel();
      return json({ ok: true });
    }

    // --- tabs ---
    if (path === "/api/tabs" && method === "GET") {
      return json(tabs.list(url.searchParams.get("connectionId") ?? ""));
    }
    if (path === "/api/tabs" && method === "POST") {
      const body = (await req.json()) as {
        tabs: Array<{ id: string; connectionId: string; title: string; content: string; filePath: string | null; position: number }>;
      };
      return json(body.tabs.map((t) => tabs.upsert(t)));
    }
    const tabMatch = path.match(/^\/api\/tabs\/([^/]+)$/);
    if (tabMatch && method === "DELETE") {
      tabs.delete(tabMatch[1]!);
      return json({ ok: true });
    }

    // --- history ---
    if (path === "/api/history" && method === "GET") {
      return json(history.list(url.searchParams.get("connectionId") ?? ""));
    }

    // --- AI provider config ---
    if (path === "/api/ai/config" && method === "GET") {
      return json(aiConfig.get());
    }
    if (path === "/api/ai/config" && method === "POST") {
      const body = (await req.json()) as AiConfig & { key?: string | null };
      const { key, ...cfg } = body;
      if (key != null) {
        if (key === "") deleteAiKey(cfg.providerId);
        else setAiKey(cfg.providerId, key);
      }
      const hasKey = getAiKey(cfg.providerId) != null;
      return json(aiConfig.save({ ...cfg, hasKey }));
    }

    // --- agent ---
    if (path === "/api/agent/audit" && method === "GET") {
      return json(audit.list(url.searchParams.get("connectionId") ?? ""));
    }
    // Traces: BASED-AGENT-MUTATION-GATE — the only path that runs agent-proposed DML/DDL.
    if (path === "/api/agent/mutation" && method === "POST") {
      const body = (await req.json()) as { sql: string; approved?: boolean };
      if (body.approved !== true) return json({ error: "Mutation not approved" }, 400);
      return runMutation(body.sql);
    }
    const agentMatch = path.match(/^\/api\/agent\/([^/]+)$/);
    if (agentMatch && method === "POST") return agentStream(agentMatch[1]!, req);

    // --- files / export ---
    if (path === "/api/file/save-sql" && method === "POST") {
      const body = (await req.json()) as { content: string; path?: string; defaultName?: string };
      let target = body.path ?? null;
      if (!target) target = await saveFileDialog(body.defaultName ?? "query.sql", filterFor("sql"));
      if (!target) return json({ path: null });
      await Bun.write(target, body.content);
      return json({ path: target });
    }
    if (path === "/api/export" && method === "POST") {
      const body = (await req.json()) as {
        format: "csv" | "xlsx";
        columns: ColumnInfo[];
        rows: WireValue[][];
        openAfter?: boolean;
      };
      let target: string | null;
      if (body.openAfter) {
        target = join(tmpdir(), `based-results-${Date.now()}.${body.format}`);
      } else {
        target = await saveFileDialog(`results.${body.format}`, filterFor(body.format));
        if (!target) return json({ path: null });
      }
      if (body.format === "csv") await Bun.write(target, toCsv(body.columns, body.rows));
      else await writeXlsx(target, body.columns, body.rows);
      if (body.openAfter) openWithDefaultApp(target);
      return json({ path: target });
    }

    // --- SSE ---
    if (path === "/api/events") {
      let controllerRef: ReadableStreamDefaultController<Uint8Array>;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controllerRef = controller;
          sseClients.add(controller);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "connection-status", status: session.status, connectionId: session.connectionId, database: session.database, detail: null })}\n\n`,
            ),
          );
        },
        cancel() {
          sseClients.delete(controllerRef);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    return json({ error: "Not found" }, 404);
  }

  function streamQuery(sqlText: string): Response {
    const adapter = requireAdapter();
    const queryId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const connectionId = session.connectionId!;
    const database = session.database!;
    let closed = false;
    let firstError: string | null = null;

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (obj: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
          } catch {
            closed = true;
          }
        };
        send({ type: "start", queryId });
        const exec = adapter.execute(sqlText, (chunk) => {
          if (chunk.type === "error" && !firstError) firstError = chunk.message;
          send(chunk);
        });
        executions.set(queryId, exec);
        exec.completion
          .then(({ status, durationMs }) => {
            history.add({ connectionId, database, sql: sqlText, startedAt, durationMs, status, error: firstError });
          })
          .catch(() => {})
          .finally(() => {
            executions.delete(queryId);
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // already closed by client
              }
            }
          });
      },
      cancel() {
        closed = true;
        executions.get(queryId)?.cancel();
      },
    });

    return new Response(stream, {
      headers: { "content-type": "application/x-ndjson", "x-query-id": queryId },
    });
  }

  // Traces: BASED-AGENT-MUTATION-GATE, BASED-AGENT-AUDIT — runs an approved mutation and audits it.
  async function runMutation(sqlText: string): Promise<Response> {
    const adapter = requireAdapter();
    const startedAt = new Date().toISOString();
    const result = await collectQuery(adapter, sqlText);
    const status = result.status === "ok" ? "ok" : "error";
    audit.add({
      connectionId: session.connectionId!,
      database: session.database!,
      kind: "mutation",
      sql: sqlText,
      approved: true,
      startedAt,
      durationMs: result.durationMs,
      status,
      error: result.errors[0] ?? null,
    });
    return json({
      status,
      messages: result.messages,
      errors: result.errors,
      rowCounts: result.resultSets.map((rs) => rs.rowCount),
      durationMs: result.durationMs,
    });
  }

  // Traces: BASED-AGENT-ENDPOINT — expose the Mastra agent as an AG-UI SSE stream.
  async function agentStream(agentId: string, req: Request): Promise<Response> {
    if (agentId !== AGENT_ID) return json({ error: "Unknown agent" }, 404);
    if (!session.adapter) return json({ error: "Connect to a database first" }, 409);

    let model;
    try {
      const cfg = aiConfig.get();
      model = resolveModel(cfg, getAiKey(cfg.providerId));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const input = RunAgentInputSchema.parse(await req.json());
    const connectionId = session.connectionId!;
    const agent = buildAgent({
      model,
      memory: agentMemory,
      toolDeps: {
        getAdapter: requireAdapter,
        connectionId: () => session.connectionId!,
        database: () => session.database!,
        audit,
      },
    });

    // AG-UI event encoder (SSE); its `encode` yields a string frame (see spike 4).
    const aguiEncoder = new EventEncoder({ accept: req.headers.get("accept") ?? undefined });
    // `as any`: @ag-ui/core types differ nominally between our copy and @ag-ui/mastra's copy.
    const agui = new MastraAgent({ agent, resourceId: connectionId } as never);

    // `closed` + cancel()-based teardown: if the client disconnects mid-stream, unsubscribe so the
    // RxJS observable never enqueues into a closed controller (that throw would otherwise surface as
    // an unhandled RxJS error and crash the process).
    let sub: { unsubscribe(): void } | null = null;
    let closed = false;
    const stream = new ReadableStream({
      start(controller) {
        sub = (agui.run(input as never) as { subscribe(o: unknown): { unsubscribe(): void } }).subscribe({
          next: (event: BaseEvent) => {
            if (closed) return;
            try {
              controller.enqueue(aguiEncoder.encode(event));
            } catch {
              closed = true;
              sub?.unsubscribe();
            }
          },
          error: (err: unknown) => {
            if (!closed) {
              try {
                controller.enqueue(
                  aguiEncoder.encode({ type: "RUN_ERROR", message: String((err as { message?: string })?.message ?? err) } as unknown as BaseEvent),
                );
              } catch {
                // controller already torn down
              }
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
            closed = true;
          },
          complete: () => {
            if (!closed) {
              closed = true;
              try {
                controller.close();
              } catch {
                // already closed
              }
            }
          },
        });
      },
      cancel() {
        closed = true;
        sub?.unsubscribe();
      },
    });

    return new Response(stream, {
      headers: { "content-type": aguiEncoder.getContentType(), "cache-control": "no-cache", connection: "keep-alive" },
    });
  }

  async function serveStatic(staticDir: string | undefined, path: string): Promise<Response> {
    if (!staticDir) return new Response("based core server", { status: 200 });
    const rel = path === "/" ? "index.html" : path.slice(1);
    const file = Bun.file(join(staticDir, rel));
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(join(staticDir, "index.html")));
  }

  const port = server.port!;
  return {
    port,
    token,
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      for (const exec of executions.values()) exec.cancel();
      if (session.adapter) await session.adapter.disconnect().catch(() => {});
      await server.stop(true);
      db.close();
    },
  };
}
