import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { RunAgentInputSchema, type BaseEvent } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { MastraAgent } from "@ag-ui/mastra";
import { openDb } from "./storage/db";
import { ConnectionStore } from "./storage/connections";
import { TabStore } from "./storage/tabs";
import { WindowStateStore } from "./storage/windowState";
import { HistoryStore } from "./storage/history";
import { SettingsStore, type AppSettings } from "./storage/settings";
import { getSecret, setSecret, deleteSecret, getAiKey, setAiKey, deleteAiKey } from "./secrets";
import { createAdapter, engineOf, testConnection } from "./db/adapterFactory";
import { buildEditCommands, type TableChangeSet } from "./db/tableEdit";
import { filterFor, openFolderDialog, openWithDefaultApp, saveFileDialog } from "./dialogs";
import { toCsv } from "./export/csv";
import { writeXlsx } from "./export/xlsx";
import { AiConfigStore, resolveModel, type AiConfig } from "./agent/provider";
import { AuditStore } from "./agent/audit";
import { createAgentMemory } from "./agent/memory";
import { buildAgent, AGENT_ID } from "./agent/agent";
import { AgentInstructionsStore } from "./agent/instructionsStore";
import { collectQuery } from "./agent/runSql";
import { isReadOnly } from "./db/classify";
import type {
  ColumnInfo,
  ConnectionInput,
  ConnectionStatus,
  DatabaseAdapter,
  ExecuteOptions,
  QueryExecution,
  WireValue,
} from "./db/types";

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
  adapter: DatabaseAdapter | null;
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
  const windowState = new WindowStateStore(db);
  const history = new HistoryStore(db);
  const aiConfig = new AiConfigStore(db);
  const settings = new SettingsStore(db);
  const agentInstructions = new AgentInstructionsStore(db);
  const audit = new AuditStore(db);
  const agentMemory = createAgentMemory(opts.agentDbPath);

  const sessions = new Map<string, SessionState>();
  const executions = new Map<string, QueryExecution>();
  const sseClients = new Set<{ sid: string; controller: ReadableStreamDefaultController<Uint8Array> }>();

  function getSession(sid: string): SessionState {
    let s = sessions.get(sid);
    if (!s) {
      s = { adapter: null, connectionId: null, database: null, status: "disconnected" };
      sessions.set(sid, s);
    }
    return s;
  }

  function broadcast(sid: string, event: Record<string, unknown>): void {
    const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
    for (const client of sseClients) {
      if (client.sid !== sid) continue;
      try {
        client.controller.enqueue(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  }

  function setStatus(sid: string, status: ConnectionStatus, detail?: string): void {
    const session = getSession(sid);
    session.status = status;
    broadcast(sid, { type: "connection-status", status, detail: detail ?? null, connectionId: session.connectionId, database: session.database });
  }

  async function connectSession(sid: string, connectionId: string, database?: string): Promise<void> {
    const session = getSession(sid);
    const cfg = connections.get(connectionId);
    if (!cfg) throw new Error(`Unknown connection: ${connectionId}`);
    if (session.adapter) await session.adapter.disconnect().catch(() => {});
    session.connectionId = connectionId;
    session.database = database ?? cfg.database;
    setStatus(sid, "connecting");
    const adapter = createAdapter(cfg, getSecret, { database: session.database });
    adapter.onStatus((status, detail) => setStatus(sid, status, detail));
    session.adapter = adapter;
    try {
      await adapter.connect();
    } catch (err) {
      session.adapter = null;
      setStatus(sid, "disconnected");
      throw err;
    }
    windowState.save(sid, { connectionId });
  }

  function requireAdapter(sid: string): DatabaseAdapter {
    const adapter = getSession(sid).adapter;
    if (!adapter) throw new Error("Not connected");
    return adapter;
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
    const sid = url.searchParams.get("sid") ?? "default";

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
      windowState.deleteByConnection(connMatch[1]!);
      return json({ ok: true });
    }

    // --- session ---
    if (path === "/api/session/state") {
      const session = getSession(sid);
      return json({ connectionId: session.connectionId, database: session.database, status: session.status });
    }
    if (path === "/api/session/connect" && method === "POST") {
      const body = (await req.json()) as { connectionId: string; database?: string };
      await connectSession(sid, body.connectionId, body.database);
      const adapter = requireAdapter(sid);
      const [databases, schemas, objects] = await Promise.all([
        adapter.listDatabases(),
        adapter.listSchemas(),
        adapter.listObjects(),
      ]);
      const session = getSession(sid);
      return json({ connectionId: session.connectionId, database: session.database, databases, schemas, objects });
    }
    if (path === "/api/session/disconnect" && method === "POST") {
      const session = getSession(sid);
      if (session.adapter) await session.adapter.disconnect().catch(() => {});
      session.adapter = null;
      session.connectionId = null;
      session.database = null;
      setStatus(sid, "disconnected");
      return json({ ok: true });
    }
    // Called on window close so a long-running multi-window session doesn't leak adapters/SSE registrations.
    // Also drops this window's persisted state — a cleanly closed window isn't reopened on next launch.
    if (path === "/api/session/close" && method === "POST") {
      const session = sessions.get(sid);
      if (session?.adapter) await session.adapter.disconnect().catch(() => {});
      sessions.delete(sid);
      windowState.delete(sid);
      for (const client of sseClients) {
        if (client.sid !== sid) continue;
        try {
          client.controller.close();
        } catch {
          // already closed
        }
        sseClients.delete(client);
      }
      return json({ ok: true });
    }
    if (path === "/api/session/objects") {
      const adapter = requireAdapter(sid);
      const [schemas, objects] = await Promise.all([adapter.listSchemas(), adapter.listObjects()]);
      return json({ schemas, objects });
    }
    if (path === "/api/session/columns") {
      const schema = url.searchParams.get("schema") ?? "dbo";
      const table = url.searchParams.get("table") ?? "";
      return json(await requireAdapter(sid).getTableColumns(schema, table));
    }
    // Traces: BASED-VIEW-DEFINITION, BASED-ROUTINE-DETAILS — SQL definition text for a view/procedure/function.
    if (path === "/api/session/definition") {
      const schema = url.searchParams.get("schema") ?? "dbo";
      const name = url.searchParams.get("name") ?? "";
      const definition = (await requireAdapter(sid).getObjectDefinition?.(schema, name)) ?? null;
      return json({ definition });
    }
    // Traces: BASED-ROUTINE-DETAILS — stored procedure / function parameter list.
    if (path === "/api/session/parameters") {
      const schema = url.searchParams.get("schema") ?? "dbo";
      const name = url.searchParams.get("name") ?? "";
      const parameters = (await requireAdapter(sid).getRoutineParameters?.(schema, name)) ?? [];
      return json(parameters);
    }
    if (path === "/api/session/query" && method === "POST") {
      const body = (await req.json()) as { sql: string; capturePlan?: boolean; captureStats?: boolean; rowCap?: number };
      return streamQuery(sid, body.sql, {
        capturePlan: !!body.capturePlan,
        captureStats: !!body.captureStats,
        rowCap: body.rowCap,
      });
    }
    // Traces: BASED-TABLE-BROWSE — paginated table data read for the Data view.
    if (path === "/api/session/table-data") {
      const schema = url.searchParams.get("schema") ?? "dbo";
      const table = url.searchParams.get("table") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      return json(await requireAdapter(sid).readTablePage(schema, table, { offset, limit }));
    }
    // Traces: BASED-TABLE-DML, BASED-TABLE-COMMIT — build the parameterized commands and (unless
    // previewing) run them in one transaction, recording a history row.
    if (path === "/api/session/table-edit" && method === "POST") {
      const body = (await req.json()) as TableChangeSet & { preview?: boolean };
      return tableEdit(sid, body);
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
        tabs: Array<{
          id: string;
          connectionId: string;
          title: string;
          content: string;
          filePath: string | null;
          position: number;
          kind: "query" | "table" | "routine";
          meta: unknown | null;
        }>;
      };
      return json(body.tabs.map((t) => tabs.upsert(t)));
    }
    const tabMatch = path.match(/^\/api\/tabs\/([^/]+)$/);
    if (tabMatch && method === "DELETE") {
      tabs.delete(tabMatch[1]!);
      return json({ ok: true });
    }

    // --- window state (per-window restore across restarts, BASED-WINDOW-RESTORE) ---
    if (path === "/api/windows" && method === "GET") {
      return json(windowState.list());
    }
    if (path === "/api/window-state" && method === "GET") {
      return json(windowState.get(sid) ?? { sid, connectionId: null, activeTabId: null, schemaFilter: "" });
    }
    if (path === "/api/window-state" && method === "POST") {
      const body = (await req.json()) as Partial<{ activeTabId: string | null; schemaFilter: string }>;
      return json(windowState.save(sid, body));
    }

    // --- history ---
    if (path === "/api/history" && method === "GET") {
      return json(history.list(url.searchParams.get("connectionId") ?? ""));
    }

    // --- app settings (theme, etc.) ---
    if (path === "/api/settings" && method === "GET") {
      return json(settings.get());
    }
    if (path === "/api/settings" && method === "POST") {
      const body = (await req.json()) as Partial<AppSettings>;
      return json(settings.save(body));
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

    // Traces: BASED-AGENT-INSTRUCTIONS — named, user-editable instruction sets; "default" is virtual/locked.
    if (path === "/api/agent/instructions" && method === "GET") {
      return json(agentInstructions.list());
    }
    if (path === "/api/agent/instructions" && method === "POST") {
      const body = (await req.json()) as { id?: string; name: string; core: string; mssqlPersona: string; lancePersona: string };
      try {
        return json(agentInstructions.saveSet(body));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    if (path === "/api/agent/instructions/active" && method === "POST") {
      const { id } = (await req.json()) as { id: string };
      try {
        return json(agentInstructions.setActive(id));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    const instructionsMatch = path.match(/^\/api\/agent\/instructions\/([^/]+)$/);
    if (instructionsMatch && method === "DELETE") {
      try {
        return json(agentInstructions.deleteSet(instructionsMatch[1]!));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    // --- agent ---
    if (path === "/api/agent/audit" && method === "GET") {
      return json(audit.list(url.searchParams.get("connectionId") ?? ""));
    }
    // Traces: BASED-AGENT-MUTATION-GATE — the only path that runs agent-proposed DML/DDL.
    if (path === "/api/agent/mutation" && method === "POST") {
      const body = (await req.json()) as { sql: string; approved?: boolean };
      if (body.approved !== true) return json({ error: "Mutation not approved" }, 400);
      return runMutation(sid, body.sql);
    }
    const agentMatch = path.match(/^\/api\/agent\/([^/]+)$/);
    if (agentMatch && method === "POST") return agentStream(sid, agentMatch[1]!, req);

    // --- dialogs ---
    // Traces: BASED-LANCE-FOLDER-BROWSE
    if (path === "/api/dialog/folder" && method === "POST") {
      const body = (await req.json()) as { startingFolder?: string };
      const path_ = await openFolderDialog(body.startingFolder);
      return json({ path: path_ });
    }

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
      let clientRef: { sid: string; controller: ReadableStreamDefaultController<Uint8Array> };
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          clientRef = { sid, controller };
          sseClients.add(clientRef);
          const session = getSession(sid);
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ type: "connection-status", status: session.status, connectionId: session.connectionId, database: session.database, detail: null })}\n\n`,
            ),
          );
        },
        cancel() {
          sseClients.delete(clientRef);
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" },
      });
    }

    return json({ error: "Not found" }, 404);
  }

  function streamQuery(sid: string, sqlText: string, opts: ExecuteOptions): Response {
    const adapter = requireAdapter(sid);
    if (!adapter.capabilities.sql) {
      return json({ error: "This connection does not support raw SQL queries." }, 400);
    }
    const queryId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    const session = getSession(sid);
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
        const exec = adapter.execute(
          sqlText,
          (chunk) => {
            if (chunk.type === "error" && !firstError) firstError = chunk.message;
            send(chunk);
          },
          opts,
        );
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

  // Traces: BASED-TABLE-DML, BASED-TABLE-COMMIT — builds parameterized commands from a change set,
  // previews them or commits them in one transaction, and records a history row for a commit.
  async function tableEdit(sid: string, body: TableChangeSet & { preview?: boolean }): Promise<Response> {
    const adapter = requireAdapter(sid);
    if (!adapter.capabilities.write) {
      return json({ error: "This connection is read-only; row edits are not supported." }, 400);
    }
    let commands;
    try {
      commands = buildEditCommands(body);
    } catch (err) {
      // A build failure (no PK for update/delete, invalid identifier) is a client error, not a 500.
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
    if (body.preview) return json({ commands });

    const startedAt = new Date().toISOString();
    const t0 = performance.now();
    const result = await adapter.runCommands(commands);
    const durationMs = Math.round(performance.now() - t0);
    const status = result.error ? "error" : "ok";
    const session = getSession(sid);
    history.add({
      connectionId: session.connectionId!,
      database: session.database!,
      sql: commands.map((c) => c.sql).join(";\n"),
      startedAt,
      durationMs,
      status,
      error: result.error,
    });
    return json({ status, rowsAffected: result.rowsAffected, error: result.error, durationMs });
  }

  // Traces: BASED-AGENT-MUTATION-GATE, BASED-AGENT-AUDIT — runs an approved mutation and audits it.
  async function runMutation(sid: string, sqlText: string): Promise<Response> {
    const adapter = requireAdapter(sid);
    const startedAt = new Date().toISOString();
    const result = await collectQuery(adapter, sqlText);
    const status = result.status === "ok" ? "ok" : "error";
    const session = getSession(sid);
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
  async function agentStream(sid: string, agentId: string, req: Request): Promise<Response> {
    if (agentId !== AGENT_ID) return json({ error: "Unknown agent" }, 404);
    const session = getSession(sid);
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
    const connCfg = connections.get(connectionId);
    const engine = connCfg ? engineOf(connCfg) : "mssql";
    const active = agentInstructions.resolveActive(engine);
    const agent = buildAgent({
      model,
      memory: agentMemory,
      engine,
      core: active.core,
      persona: active.persona,
      toolDeps: {
        getAdapter: () => requireAdapter(sid),
        connectionId: () => getSession(sid).connectionId!,
        database: () => getSession(sid).database!,
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
      for (const session of sessions.values()) {
        if (session.adapter) await session.adapter.disconnect().catch(() => {});
      }
      await server.stop(true);
      db.close();
    },
  };
}
