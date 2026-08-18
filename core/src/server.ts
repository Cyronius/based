import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { RunAgentInputSchema, type BaseEvent } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { MastraAgent } from "@ag-ui/mastra";
import { APP_VERSION } from "./version";
import { openDb } from "./storage/db";
import { ConnectionStore } from "./storage/connections";
import { TabStore } from "./storage/tabs";
import { WindowStateStore } from "./storage/windowState";
import { HistoryStore } from "./storage/history";
import { SettingsStore, type AppSettings } from "./storage/settings";
import { EmbeddingProfileStore, type EmbeddingProfileInput } from "./storage/embeddingProfiles";
import { RerankerProfileStore, type RerankerProfileInput } from "./storage/rerankerProfiles";
import { AiProfileStore, type AiProfile, type AiProfileInput } from "./storage/aiProfiles";
import {
  getSecret,
  setSecret,
  deleteSecret,
  getAiKey,
  setAiKey,
  deleteAiKey,
  getEmbeddingKey,
  setEmbeddingKey,
  deleteEmbeddingKey,
  getRerankerKey,
  setRerankerKey,
  deleteRerankerKey,
} from "./secrets";
import { createAdapter, engineOf, testConnection } from "./db/adapterFactory";
import { ENGINE_IDS, defaultCapabilitiesFor, descriptorFor, engineProfiles } from "./engines/registry";
import { encodeVectorSample } from "./db/vectorWire";
import { labelClusters, type LabelCluster } from "./agent/labelClusters";
import { createLspSubsystem } from "./lsp";
import { resolveEmbeddingProfile, resolveRerankerProfile } from "./db/searchProfileResolve";
import { buildEditCommands, type TableChangeSet } from "./db/tableEdit";
import { joinScripts, type ScriptAction } from "./db/scripter";
import { scriptWithAdapter } from "./db/scriptDispatch";
import {
  filterFor,
  nextDialogRequest,
  openFileDialog,
  openFolderDialog,
  openWithDefaultApp,
  resolveDialogResult,
  saveFileDialog,
} from "./dialogs";
import { parseCsv } from "./import/csvParse";
import { runCsvImport, type CsvImportRequest } from "./import/csvImport";
import { toCsv } from "./export/csv";
import { writeXlsx } from "./export/xlsx";
import { AiConfigStore, resolveModel, resolveExecutionDefaults, resolveAiTimeouts } from "./agent/provider";
import { AuditStore } from "./agent/audit";
import { createAgentMemory } from "./agent/memory";
import { isContextOverflowError } from "./agent/contextRecovery";
import { buildAgent, AGENT_ID } from "./agent/agent";
import { createSubagentRunner } from "./agent/subagent";
import { SUBAGENT_CONCURRENCY } from "./agent/tools/delegate";
import type { ToolDeps } from "./agent/tools/shared";
import { renderTabContext } from "./agent/tabContext";
import { mapDbMessagesToAgui } from "./agent/threadMessages";
import { transcriptMarkdown } from "./agent/transcript";
import { AgentInstructionsStore } from "./agent/instructionsStore";
import { collectQuery } from "./agent/runSql";
import { isReadOnly } from "./db/classify";
import type {
  ColumnInfo,
  ConnectionInput,
  ConnectionStatus,
  DatabaseAdapter,
  DbEngine,
  ExecuteOptions,
  LanceSearchRequest,
  QueryExecution,
  TableFilter,
  TableSort,
  WireValue,
} from "./db/types";

// Traces: BASED-UI-SESSION-RESUME — a request arrived for a sid whose in-memory session is gone
// (the server process restarted — e.g. dev `bun --watch` — while the browser stayed open). Distinct
// from a genuine "never connected": the client keys on the 409 `session-lost` code to auto-resume
// (re-connect to the same connection) and retry, instead of surfacing a raw error.
class SessionLostError extends Error {
  constructor() {
    super("Not connected");
    this.name = "SessionLostError";
  }
}

export interface ServerOptions {
  port?: number;
  token?: string;
  staticDir?: string;
  dbPath?: string;
  /** LibSQL file for agent memory; defaults to agent.db in the data dir. */
  agentDbPath?: string;
  /** BASED-UI-SHORTCUTS (Ctrl+N): opens a new native window. Set by the shell's core child
   *  (shell-tauri/core-child.ts), which forwards it to Rust as a stdout line; unset in dev:core and
   *  in tests, where the route answers 404. */
  onRequestNewWindow?: () => void;
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

/** Open-.sql size cap (BASED-FILE-OPEN-SQL) — a query tab is not a general text editor. */
const MAX_OPEN_SQL_BYTES = 2 * 1024 * 1024;

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
  const embeddingProfiles = new EmbeddingProfileStore(db);
  const rerankerProfiles = new RerankerProfileStore(db);
  const aiProfiles = new AiProfileStore(db);

  // Traces: BASED-AI-PROVIDER-PROFILES — migrate a real legacy single ai_config row into a
  // "Default" profile the first time profiles are read, whether that's the settings popover
  // listing them or the agent resolving one to run against. A fresh install with no legacy row and
  // no profiles yet stays genuinely empty — there is no built-in default to seed.
  function ensureAiProfiles(): AiProfile[] {
    const list = aiProfiles.list();
    if (list.length > 0) return list;
    const legacy = aiConfig.get();
    if (!legacy) return [];
    let created = aiProfiles.save({
      name: "Default",
      kind: legacy.kind,
      baseUrl: legacy.baseUrl,
      model: legacy.model,
      deployment: legacy.deployment,
      instructionSetId: "default",
    });
    const legacyKey = getAiKey(legacy.providerId);
    if (legacyKey) {
      setAiKey(created.id, legacyKey);
      created = aiProfiles.save({ ...created, hasKey: true });
    }
    settings.save({ activeAiProfileId: created.id });
    return [created];
  }

  function activeAiProfile(): AiProfile {
    const list = ensureAiProfiles();
    if (list.length === 0) {
      throw new Error("No agent profile configured — add one in Settings → Agent.");
    }
    const activeId = settings.get().activeAiProfileId;
    return list.find((p) => p.id === activeId) ?? list[0]!;
  }

  // Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — the connected connection's default search profiles.
  // Re-read per call (never captured at connect/agent-build time) so editing the connection applies
  // immediately and a mid-session switch can't carry the previous connection's profile over.
  function connectionDefaults(sid: string): { embedding: string | null; reranker: string | null } {
    const connectionId = sessions.get(sid)?.connectionId;
    const cfg = connectionId ? connections.get(connectionId) : null;
    return { embedding: cfg?.defaultEmbeddingProfileId ?? null, reranker: cfg?.defaultRerankerProfileId ?? null };
  }
  const agentInstructions = new AgentInstructionsStore(db);
  const audit = new AuditStore(db);
  const agentMemory = createAgentMemory(opts.agentDbPath);

  const sessions = new Map<string, SessionState>();
  const executions = new Map<string, QueryExecution>();
  const sseClients = new Set<{ sid: string; controller: ReadableStreamDefaultController<Uint8Array> }>();
  // Traces: BASED-LSP-TRANSPORT — one LSP backend per connected session, over /api/lsp WebSocket.
  const lsp = createLspSubsystem({
    getSession: (sid) => getSession(sid),
    getConnection: (id) => connections.get(id) ?? undefined,
  });

  function getSession(sid: string): SessionState {
    let s = sessions.get(sid);
    if (!s) {
      s = { adapter: null, connectionId: null, database: null, status: "disconnected" };
      sessions.set(sid, s);
    }
    return s;
  }

  // Traces: BASED-AGENT-INSTRUCTIONS — an instruction set stores only the editable half of the
  // prompt. The capability briefing is generated per connection and never persisted, so it rides
  // every instructions response read-only: without it the editor would show a persona that says
  // nothing about which tools exist, and the user would helpfully write those facts back in by hand
  // — pinning them to whichever connection they had in mind. Uses the live connection's
  // capabilities when there is one (so the editor shows what this session actually sends) and the
  // representative rendering otherwise.
  function withBriefings<T extends object>(sid: string, config: T) {
    const live = getSession(sid).adapter?.capabilities;
    const forEngine = (engine: DbEngine) => (live && live.engine === engine ? live : defaultCapabilitiesFor(engine));
    return {
      ...config,
      briefings: Object.fromEntries(
        ENGINE_IDS.map((id) => [id, descriptorFor(id).briefing(forEngine(id))]),
      ) as Record<DbEngine, string>,
      briefingIsLive: live ? live.engine : null,
    };
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
    lsp.closeForSession(sid); // the old engine's LSP backend is wrong for the new connection
    if (session.adapter) await session.adapter.disconnect().catch(() => {});
    session.connectionId = connectionId;
    session.database = database ?? cfg.database;
    setStatus(sid, "connecting");
    const adapter = await createAdapter(cfg, getSecret, { database: session.database });
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
    if (!adapter) throw new SessionLostError();
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
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;

      if (!path.startsWith("/api/")) return serveStatic(opts.staticDir, path);
      if (!authorized(req, url)) return json({ error: "Unauthorized" }, 401);

      // Traces: BASED-LSP-TRANSPORT — WebSocket upgrade for the LSP channel (token via query param,
      // since browsers can't set headers on WebSocket connects; authorized() above covers both).
      if (path === "/api/lsp") {
        const sid = url.searchParams.get("sid") ?? "default";
        const refusal = lsp.handleUpgrade(req, srv, sid);
        return refusal ?? (undefined as unknown as Response); // null → Bun completed the 101 upgrade
      }

      try {
        return await route(req, url, path);
      } catch (err) {
        if (err instanceof SessionLostError) return json({ error: "session-lost" }, 409);
        return json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    },
    websocket: lsp.websocket,
  });

  async function route(req: Request, url: URL, path: string): Promise<Response> {
    const method = req.method;
    const sid = url.searchParams.get("sid") ?? "default";

    // The version is here so a user can report which build they are on without hunting for it.
    if (path === "/api/health") return json({ ok: true, version: APP_VERSION });

    // --- connections ---
    // Traces: BASED-ENGINE-PROFILE-WIRE — the engine catalog the webview renders connection forms
    // from. Serving it (rather than the UI holding a hand-mirrored copy) is what makes adding an
    // engine a core-only change: the dialog knows field *kinds*, never engine names.
    if (path === "/api/engines" && method === "GET") return json({ engines: engineProfiles() });
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
      return json({
        connectionId: session.connectionId,
        database: session.database,
        status: session.status,
        capabilities: session.adapter?.capabilities ?? null,
      });
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
      return json({
        connectionId: session.connectionId,
        database: session.database,
        databases,
        schemas,
        objects,
        capabilities: adapter.capabilities,
      });
    }
    if (path === "/api/session/disconnect" && method === "POST") {
      const session = getSession(sid);
      lsp.closeForSession(sid);
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
      lsp.closeForSession(sid);
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
    // Traces: BASED-TABLE-BROWSE, BASED-TABLE-ORDERBY — paginated table data read for the Data
    // view; optional `sort`/`filters` URL-encoded JSON (server-side ORDER BY / WHERE, adapter-validated).
    if (path === "/api/session/table-data") {
      const schema = url.searchParams.get("schema") ?? "dbo";
      const table = url.searchParams.get("table") ?? "";
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      let orderBy: TableSort[] | undefined;
      let filters: TableFilter[] | undefined;
      try {
        const sortRaw = url.searchParams.get("sort");
        const filtersRaw = url.searchParams.get("filters");
        if (sortRaw) orderBy = JSON.parse(sortRaw) as TableSort[];
        if (filtersRaw) filters = JSON.parse(filtersRaw) as TableFilter[];
      } catch {
        return json({ error: "Malformed sort/filters JSON" }, 400);
      }
      // `?where=` present but empty means "no filter" — an empty predicate is a parse error downstream.
      const where = url.searchParams.get("where") || undefined;
      return json(await requireAdapter(sid).readTablePage(schema, table, { offset, limit, orderBy, filters, where }));
    }
    // Traces: BASED-LANCE-SCAN — exact row count, optionally narrowed the way the engine narrows
    // (a `where` predicate on LanceDB, structured filters on SQL Server).
    if (path === "/api/session/row-count") {
      const adapter = requireAdapter(sid);
      if (!adapter.capabilities.countRows || !adapter.countRows) {
        return json({ error: "This engine does not support row counts" }, 400);
      }
      const schema = url.searchParams.get("schema") ?? "dbo";
      const table = url.searchParams.get("table") ?? "";
      const where = url.searchParams.get("where") || undefined;
      let filters: TableFilter[] | undefined;
      try {
        const filtersRaw = url.searchParams.get("filters");
        if (filtersRaw) filters = JSON.parse(filtersRaw) as TableFilter[];
      } catch {
        return json({ error: "Malformed filters JSON" }, 400);
      }
      return json({ count: await adapter.countRows(schema, table, { where, filters }) });
    }
    // Traces: BASED-INDEX-INTROSPECT — index metadata for the Details panel and the agent's
    // get_indexes. Unlike /table-details this is NOT gated on `script`: LanceDB has no DDL to
    // script but very much has indexes, and their absence is the actionable fact.
    if (path === "/api/session/indexes") {
      const adapter = requireAdapter(sid);
      if (!adapter.capabilities.indexIntrospect || !adapter.getIndexes) {
        return json({ error: "This engine does not expose index metadata" }, 400);
      }
      const schema = url.searchParams.get("schema") ?? "dbo";
      const table = url.searchParams.get("table") ?? "";
      return json({ indexes: await adapter.getIndexes(schema, table) });
    }
    // Traces: BASED-TABLE-DETAILS — full introspection + server-computed CREATE script for the
    // enriched Details view and the scripter.
    if (path === "/api/session/table-details") {
      const adapter = requireAdapter(sid);
      if (!adapter.capabilities.script || !adapter.getTableDetails) {
        return json({ error: "This engine does not support object scripting" }, 400);
      }
      const schema = url.searchParams.get("schema") || adapter.dialect.defaultSchema;
      const table = url.searchParams.get("table") ?? "";
      const details = await adapter.getTableDetails(schema, table);
      // Views have no table DDL to synthesize — their definition text comes from BASED-VIEW-DEFINITION.
      const isTable = (await adapter.listObjects()).some((o) => o.schema === schema && o.name === table && o.type === "table");
      return json({
        details,
        createScript: isTable ? await scriptWithAdapter(adapter, { kind: "table", details }, "create") : null,
      });
    }
    // Traces: BASED-RELATIONS — bulk tables + FK edges for the ER diagram.
    if (path === "/api/session/relations") {
      const adapter = requireAdapter(sid);
      if (!adapter.capabilities.relations || !adapter.getRelations) {
        return json({ error: "This engine does not support relationship introspection" }, 400);
      }
      const schema = url.searchParams.get("schema") ?? undefined;
      return json(await adapter.getRelations(schema || undefined));
    }
    // Traces: BASED-SCRIPT-API — multi-object scripting; per-object failures collect into `errors`
    // while the rest still script, joined with GO in request order.
    if (path === "/api/session/script" && method === "POST") {
      const adapter = requireAdapter(sid);
      if (!adapter.capabilities.script) return json({ error: "This engine does not support object scripting" }, 400);
      const body = (await req.json()) as {
        objects: Array<{ schema: string; name: string; type: "table" | "view" | "procedure" | "function" }>;
        action: ScriptAction;
      };
      const scripts: string[] = [];
      const errors: Array<{ schema: string; name: string; message: string }> = [];
      for (const obj of body.objects ?? []) {
        try {
          if (obj.type === "table") {
            const details = await adapter.getTableDetails!(obj.schema, obj.name);
            scripts.push(await scriptWithAdapter(adapter, { kind: "table", details }, body.action));
          } else {
            const definition = await adapter.getObjectDefinition?.(obj.schema, obj.name);
            if (definition == null) throw new Error(`No definition found for ${obj.schema}.${obj.name}`);
            const type = obj.type === "view" ? "view" : obj.type === "procedure" ? "procedure" : "function";
            scripts.push(
              await scriptWithAdapter(adapter, { kind: "module", type, schema: obj.schema, name: obj.name, definition }, body.action),
            );
          }
        } catch (err) {
          errors.push({ schema: obj.schema, name: obj.name, message: err instanceof Error ? err.message : String(err) });
        }
      }
      return json({ sql: joinScripts(scripts), errors });
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
    // Traces: BASED-EMBED-VECTORS — full-precision vector sample (binary: BASED-EMBED-WIRE) for the
    // Embeddings visualization. Present only on engines exposing readVectorSample (LanceDB).
    if (path === "/api/session/table-vectors") {
      const adapter = requireAdapter(sid);
      if (!adapter.readVectorSample) {
        return json({ error: "This connection does not expose raw vectors." }, 400);
      }
      const schema = url.searchParams.get("schema") ?? "";
      const table = url.searchParams.get("table") ?? "";
      const column = url.searchParams.get("column") ?? "";
      const limit = Number(url.searchParams.get("limit") ?? "5000");
      try {
        const sample = await adapter.readVectorSample(schema, table, { column, limit });
        return new Response(encodeVectorSample(sample) as unknown as BodyInit, {
          headers: { "content-type": "application/octet-stream" },
        });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    // Traces: BASED-EMBED-LABELS-AI — name embedding clusters with the active AI profile's model.
    // One generateText call, not the agent loop; input is clamped server-side (clampClusters).
    if (path === "/api/session/label-clusters" && method === "POST") {
      const body = (await req.json()) as { clusters?: LabelCluster[] };
      if (!Array.isArray(body.clusters) || body.clusters.length === 0) {
        return json({ error: "No clusters to label" }, 400);
      }
      let model;
      let profile: AiProfile;
      try {
        profile = activeAiProfile();
        model = resolveModel(profile, getAiKey(profile.id));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
      try {
        // The abort window comes from the profile, not a fixed 60 s — a slow local model can take
        // minutes to answer (BASED-AI-PROFILE-TIMEOUT).
        const { idleMs } = resolveAiTimeouts(profile.timeoutSeconds);
        const labels = await labelClusters(model, body.clusters, AbortSignal.timeout(idleMs));
        return json({ labels, model: profile.model });
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    // Traces: BASED-LANCE-SEARCH-UNIFIED — vector/keyword/hybrid search for the Data tab + agent tools.
    if (path === "/api/session/lance-search" && method === "POST") {
      const body = (await req.json()) as LanceSearchRequest;
      const adapter = requireAdapter(sid);
      if (!adapter.capabilities.search || !adapter.search) {
        return json({ error: "This connection does not support search." }, 400);
      }
      try {
        const { embeddingProfileId, rerankerProfileId, ...rest } = body;
        // A caller that names no embedding profile falls back to the connection's
        // (BASED-LANCE-CONN-DEFAULT-PROFILES). The reranker gets no fallback on this route either:
        // the Data tab preselects the connection's reranker into its dropdown, so an absent id here
        // means the user explicitly chose "None" and must be honored.
        const embeddingProfile = resolveEmbeddingProfile(
          embeddingProfiles,
          getEmbeddingKey,
          embeddingProfileId,
          connectionDefaults(sid).embedding,
        );
        const rerankerProfile = resolveRerankerProfile(rerankerProfiles, getRerankerKey, rerankerProfileId);
        const result = await adapter.search({ ...rest, embeddingProfile, rerankerProfile });
        return json(result);
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    // --- tabs ---
    if (path === "/api/tabs" && method === "GET") {
      return json(tabs.list(url.searchParams.get("connectionId") ?? ""));
    }
    if (path === "/api/tabs" && method === "POST") {
      const body = (await req.json()) as {
        connectionId?: string;
        tabs: Array<{
          id: string;
          connectionId: string;
          title: string;
          content: string;
          filePath: string | null;
          position: number;
          kind: "query" | "table" | "routine" | "diagram";
          meta: unknown | null;
        }>;
      };
      // Replace the connection's full tab set so the persisted rows mirror what's open (closed
      // tabs of every kind get pruned). connectionId is explicit so an empty payload still scopes.
      const connectionId = body.connectionId ?? body.tabs[0]?.connectionId;
      if (!connectionId) return json({ error: "connectionId required" }, 400);
      return json(tabs.replaceForConnection(connectionId, body.tabs));
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
    if (path === "/api/window/new" && method === "POST") {
      if (!opts.onRequestNewWindow) return json({ error: "not supported" }, 404);
      opts.onRequestNewWindow();
      return json({ ok: true });
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

    // --- AI provider profiles (BASED-AI-PROVIDER-PROFILES) ---
    if (path === "/api/ai-profiles" && method === "GET") return json(ensureAiProfiles());
    if (path === "/api/ai-profiles" && method === "POST") {
      const body = (await req.json()) as AiProfileInput;
      const { apiKey, ...meta } = body;
      const saved = aiProfiles.save(meta);
      if (apiKey != null) {
        if (apiKey === "") deleteAiKey(saved.id);
        else setAiKey(saved.id, apiKey);
      }
      const hasKey = getAiKey(saved.id) != null;
      return json(aiProfiles.save({ ...saved, hasKey }));
    }
    const aiProfileMatch = path.match(/^\/api\/ai-profiles\/([^/]+)$/);
    if (aiProfileMatch && method === "DELETE") {
      aiProfiles.delete(aiProfileMatch[1]!);
      deleteAiKey(aiProfileMatch[1]!);
      if (settings.get().activeAiProfileId === aiProfileMatch[1]) settings.save({ activeAiProfileId: null });
      return json({ ok: true });
    }
    if (path === "/api/ai-profiles/active" && method === "POST") {
      const { id } = (await req.json()) as { id: string };
      return json(settings.save({ activeAiProfileId: id }));
    }

    // --- embedding profiles (BASED-LANCE-EMBED-PROFILES) ---
    if (path === "/api/embedding-profiles" && method === "GET") return json(embeddingProfiles.list());
    if (path === "/api/embedding-profiles" && method === "POST") {
      const body = (await req.json()) as EmbeddingProfileInput;
      const { apiKey, ...meta } = body;
      const saved = embeddingProfiles.save(meta);
      if (apiKey != null) {
        if (apiKey === "") deleteEmbeddingKey(saved.id);
        else setEmbeddingKey(saved.id, apiKey);
      }
      const hasKey = getEmbeddingKey(saved.id) != null;
      return json(embeddingProfiles.save({ ...saved, hasKey }));
    }
    const embedProfileMatch = path.match(/^\/api\/embedding-profiles\/([^/]+)$/);
    if (embedProfileMatch && method === "DELETE") {
      embeddingProfiles.delete(embedProfileMatch[1]!);
      deleteEmbeddingKey(embedProfileMatch[1]!);
      // BASED-LANCE-CONN-DEFAULT-PROFILES: a deleted profile stops being any connection's default.
      connections.clearSearchProfileRefs(embedProfileMatch[1]!);
      return json({ ok: true });
    }

    // --- reranker profiles (BASED-LANCE-RERANK-PROFILES) ---
    if (path === "/api/reranker-profiles" && method === "GET") return json(rerankerProfiles.list());
    if (path === "/api/reranker-profiles" && method === "POST") {
      const body = (await req.json()) as RerankerProfileInput;
      const { apiKey, ...meta } = body;
      const saved = rerankerProfiles.save(meta);
      if (apiKey != null) {
        if (apiKey === "") deleteRerankerKey(saved.id);
        else setRerankerKey(saved.id, apiKey);
      }
      const hasKey = getRerankerKey(saved.id) != null;
      return json(rerankerProfiles.save({ ...saved, hasKey }));
    }
    const rerankProfileMatch = path.match(/^\/api\/reranker-profiles\/([^/]+)$/);
    if (rerankProfileMatch && method === "DELETE") {
      rerankerProfiles.delete(rerankProfileMatch[1]!);
      deleteRerankerKey(rerankProfileMatch[1]!);
      // BASED-LANCE-CONN-DEFAULT-PROFILES: a deleted profile stops being any connection's default.
      connections.clearSearchProfileRefs(rerankProfileMatch[1]!);
      return json({ ok: true });
    }

    // Traces: BASED-AGENT-INSTRUCTIONS — named, user-editable instruction sets; "default" is virtual/locked.
    if (path === "/api/agent/instructions" && method === "GET") {
      return json(withBriefings(sid, agentInstructions.list()));
    }
    if (path === "/api/agent/instructions" && method === "POST") {
      const body = (await req.json()) as {
        id?: string;
        name: string;
        core: string;
        personas: Partial<Record<DbEngine, string>>;
      };
      try {
        return json(withBriefings(sid, agentInstructions.saveSet(body)));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    if (path === "/api/agent/instructions/active" && method === "POST") {
      const { id } = (await req.json()) as { id: string };
      try {
        return json(withBriefings(sid, agentInstructions.setActive(id)));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }
    const instructionsMatch = path.match(/^\/api\/agent\/instructions\/([^/]+)$/);
    if (instructionsMatch && method === "DELETE") {
      try {
        return json(withBriefings(sid, agentInstructions.deleteSet(instructionsMatch[1]!)));
      } catch (err) {
        return json({ error: err instanceof Error ? err.message : String(err) }, 400);
      }
    }

    // --- agent ---
    if (path === "/api/agent/audit" && method === "GET") {
      return json(audit.list(url.searchParams.get("connectionId") ?? ""));
    }
    // Traces: BASED-AGENT-THREADS — per-tab thread history restore + deletion. Memory-only: neither
    // route needs a live DB connection (restore must work before/independent of connect ordering).
    const threadMessagesMatch = path.match(/^\/api\/agent\/threads\/([^/]+)\/messages$/);
    if (threadMessagesMatch && method === "GET") {
      const threadId = decodeURIComponent(threadMessagesMatch[1]!);
      const resourceId = url.searchParams.get("resourceId") ?? getSession(sid).connectionId ?? "";
      if (!resourceId) return json([]);
      try {
        return json(await recallThreadMessages(threadId, resourceId));
      } catch {
        return json([]); // unknown thread / storage hiccup → empty history, never an error
      }
    }
    const threadMatch = path.match(/^\/api\/agent\/threads\/([^/]+)$/);
    if (threadMatch && method === "DELETE") {
      try {
        await agentMemory.deleteThread(decodeURIComponent(threadMatch[1]!));
      } catch {
        // deleting an unknown thread is a no-op
      }
      return json({ ok: true });
    }
    // Traces: BASED-AGENT-MUTATION-GATE — the only path that runs agent-proposed DML/DDL.
    if (path === "/api/agent/mutation" && method === "POST") {
      const body = (await req.json()) as { sql: string; approved?: boolean };
      if (body.approved !== true) return json({ error: "Mutation not approved" }, 400);
      return runMutation(sid, body.sql);
    }
    const agentMatch = path.match(/^\/api\/agent\/([^/]+)$/);
    if (agentMatch && method === "POST") return agentStream(sid, agentMatch[1]!, req);

    // --- shell dialog channel (BASED-DIALOG-CHANNEL) ---
    // Not for the UI. The shell polls `next` in a background thread, draws the native picker, and
    // posts the answer back to `result`; core/src/dialogs.ts is the other end. `next` holds the
    // request open rather than returning empty immediately, so a picker opens on the first poll
    // after the user asks for it instead of on the next tick of a busy loop.
    if (path === "/api/shell/dialog/next" && method === "GET") {
      // `holdMs` shortens the hold for a caller that wants a faster cadence than the shell's, and
      // is what lets a test establish attachment without waiting out a full hold. Clamped so a
      // caller cannot pin a connection open indefinitely.
      //
      // Parsed only when actually present: `Number(null)` is 0, so reading the param unconditionally
      // turned the shell's own poll — which sends no holdMs — into a 0 ms hold, i.e. a spin loop
      // that also missed any request raised a tick later.
      const rawParam = url.searchParams.get("holdMs");
      const raw = rawParam === null ? Number.NaN : Number(rawParam);
      const holdMs = Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 60_000) : undefined;
      const request = await nextDialogRequest(holdMs);
      return request ? json(request) : new Response(null, { status: 204 });
    }
    if (path === "/api/shell/dialog/result" && method === "POST") {
      const body = (await req.json()) as { id?: string; path?: string | null };
      if (typeof body.id !== "string") return json({ error: "id is required" }, 400);
      resolveDialogResult(body.id, body.path ?? null);
      return json({ ok: true });
    }

    // --- dialogs ---
    // Traces: BASED-LANCE-FOLDER-BROWSE
    if (path === "/api/dialog/folder" && method === "POST") {
      const body = (await req.json()) as { startingFolder?: string };
      const path_ = await openFolderDialog(body.startingFolder);
      return json({ path: path_ });
    }
    // Traces: BASED-DIALOG-OPEN-FILE
    if (path === "/api/dialog/open-file" && method === "POST") {
      const body = (await req.json()) as { kind?: "sql" | "csv" | "xlsx" };
      const path_ = await openFileDialog(filterFor(body.kind ?? "csv"));
      return json({ path: path_ });
    }

    // --- CSV import (BASED-IMPORT-CSV-RUN) ---
    if (path === "/api/import/csv/inspect" && method === "POST") {
      const body = (await req.json()) as { path: string; sampleRows?: number };
      const file = Bun.file(body.path);
      if (!(await file.exists())) return json({ error: `File not found: ${body.path}` }, 400);
      const sample = Math.min(Math.max(1, body.sampleRows ?? 50), 500);
      // Read only the head of the file — enough bytes for the sample rows.
      const head = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
      const rows = parseCsv(new TextDecoder("utf-8").decode(head));
      return json({ header: rows[0] ?? [], rows: rows.slice(1, 1 + sample) });
    }
    if (path === "/api/import/csv/run" && method === "POST") {
      const adapter = requireAdapter(sid);
      const session = getSession(sid);
      if (!adapter.capabilities.write) return json({ error: "This engine does not support writes" }, 400);
      const body = (await req.json()) as CsvImportRequest;
      const columns = await adapter.getTableColumns(body.schema, body.table);
      if (columns.length === 0) return json({ error: `No columns for ${body.schema}.${body.table}` }, 400);
      const connectionId = session.connectionId!;
      const database = session.database!;
      const startedAt = new Date().toISOString();
      let closed = false;
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
          runCsvImport(adapter, body, columns, send)
            .then((result) => {
              history.add({
                connectionId,
                database,
                sql: `-- import csv → ${body.schema}.${body.table}: ${result.inserted} rows inserted, ${result.failed} failed (${body.path})`,
                startedAt,
                durationMs: Date.now() - new Date(startedAt).getTime(),
                status: result.status,
                error: result.error ?? null,
              });
            })
            .catch((err: unknown) => {
              send({ type: "done", status: "error", inserted: 0, failed: 0, durationMs: 0, error: err instanceof Error ? err.message : String(err) });
            })
            .finally(() => {
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
        },
      });
      return new Response(stream, { headers: { "content-type": "application/x-ndjson" } });
    }

    // --- files / export ---
    // Traces: BASED-FILE-OPEN-SQL — explicit `path` skips the dialog (mirrors save-sql), which is
    // also what makes this testable and lets the shell's open-.sql-at-launch flow reuse it.
    if (path === "/api/file/open-sql" && method === "POST") {
      const body = (await req.json()) as { path?: string };
      let target = body.path ?? null;
      if (!target) target = await openFileDialog(filterFor("sql"));
      if (!target) return json({ path: null });
      const file = Bun.file(target);
      if (!(await file.exists())) return json({ error: `File not found: ${target}` }, 400);
      if (file.size > MAX_OPEN_SQL_BYTES) {
        return json({ error: `File is too large to open (${Math.round(file.size / 1024)} KB; limit ${MAX_OPEN_SQL_BYTES / 1024} KB): ${target}` }, 400);
      }
      const raw = await file.text();
      // Strip a UTF-8 BOM — invisible in the editor but breaks the SQL if left in.
      return json({ path: target, content: raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw });
    }
    if (path === "/api/file/save-sql" && method === "POST") {
      const body = (await req.json()) as { content: string; path?: string; defaultName?: string };
      let target = body.path ?? null;
      if (!target) target = await saveFileDialog(body.defaultName ?? "query.sql", filterFor("sql"));
      if (!target) return json({ path: null });
      await Bun.write(target, body.content);
      return json({ path: target });
    }
    // Traces: BASED-CHAT-TRANSCRIPT-UI — the chat rail's own download button. The client posts the
    // messages it is actually rendering (which include the assistant's just-finished reply, not yet
    // flushed to agent.db) and the server formats them, so transcriptMarkdown stays single-sourced
    // with the save_chat_transcript tool. Explicit `path` skips the dialog, mirroring save-sql.
    if (path === "/api/file/save-transcript" && method === "POST") {
      const body = (await req.json()) as { messages?: unknown[]; title?: string; path?: string; defaultName?: string };
      if (!Array.isArray(body.messages)) return json({ error: "messages must be an array" }, 400);
      let target = body.path ?? null;
      if (!target) target = await saveFileDialog(body.defaultName ?? "based-chat.md", filterFor("md"));
      if (!target) return json({ path: null }); // user cancelled the dialog
      await Bun.write(target, transcriptMarkdown(body.messages as never, { title: body.title }));
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
      commands = buildEditCommands(body, adapter.dialect);
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
    // Every other write path checks this (CSV import, grid edit) — this one did not, so on a local
    // LanceDB connection an approved mutation went straight into the DuckDB/Lance bridge. The agent
    // not being *offered* run_mutation on a read-only engine is UX; this is the enforcement.
    if (!adapter.capabilities.write) {
      return json({ error: "This connection is read-only — it does not support writes." }, 400);
    }
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

  // Traces: BASED-AGENT-THREADS, BASED-AGENT-TRANSCRIPT — one reader for a thread's stored
  // messages, shared by the history-restore route and the save_chat_transcript tool so a transcript
  // can never show a different conversation than the rail does.
  async function recallThreadMessages(threadId: string, resourceId: string) {
    const { messages } = await agentMemory.recall({ threadId, resourceId, perPage: false });
    return mapDbMessagesToAgui(messages as never);
  }

  // Traces: BASED-AGENT-ENDPOINT — expose the Mastra agent as an AG-UI SSE stream.
  async function agentStream(sid: string, agentId: string, req: Request): Promise<Response> {
    if (agentId !== AGENT_ID) return json({ error: "Unknown agent" }, 404);
    const session = getSession(sid);
    if (!session.adapter) return json({ error: "Connect to a database first" }, 409);

    let model;
    let profile: AiProfile;
    try {
      profile = activeAiProfile();
      model = resolveModel(profile, getAiKey(profile.id));
    } catch (err) {
      return json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    const input = RunAgentInputSchema.parse(await req.json());
    const connectionId = session.connectionId!;
    const connCfg = connections.get(connectionId);
    const engine = connCfg ? engineOf(connCfg) : "mssql";
    // Instructions are tied to the active provider profile (BASED-AI-PROVIDER-PROFILES): the agent
    // runs the persona from the set the active profile links to, falling back to "default".
    const active = agentInstructions.resolveById(profile.instructionSetId ?? "default", engine);
    // Traces: BASED-AGENT-TAB-CONTEXT — the client's workspace snapshot rides forwardedProps (an
    // injected system message would be dropped by the @ag-ui/mastra converter).
    const contextNote = renderTabContext(
      (input as { forwardedProps?: { tabContext?: unknown } }).forwardedProps?.tabContext,
    );
    // Traces: BASED-AGENT-SURFACE-VARIANT — the LIVE adapter's capabilities, not the config's
    // engine: only the connected adapter knows cloud from local from base-folder, and the whole
    // tool surface and persona are generated from that distinction.
    const capabilities = requireAdapter(sid).capabilities;
    // Per-profile model params (temperature, reasoning_effort, …) ride the agent's default options
    // so every run of the active profile carries them (BASED-AI-PROFILE-PARAMS).
    const executionDefaults = resolveExecutionDefaults(profile.kind, profile.params);
    // Traces: BASED-AGENT-DELEGATE — the deps a SUBAGENT gets. Identical to the parent's minus
    // runSubagent, which is exactly what keeps `delegate` off a child's surface (no recursion).
    const childDeps: ToolDeps = {
      getAdapter: () => requireAdapter(sid),
      connectionId: () => getSession(sid).connectionId!,
      database: () => getSession(sid).database!,
      audit,
      embeddingProfiles,
      rerankerProfiles,
      getEmbeddingKey,
      getRerankerKey,
      // BASED-LANCE-CONN-DEFAULT-PROFILES — resolved per tool call, not captured here.
      defaultEmbeddingProfileId: () => connectionDefaults(sid).embedding,
      defaultRerankerProfileId: () => connectionDefaults(sid).reranker,
    };
    const agent = buildAgent({
      model,
      memory: agentMemory,
      capabilities,
      core: active.core,
      // Voice only — the connection's capability briefing is injected by buildAgent regardless, so
      // a custom instruction set can never leave the agent describing a connection it isn't on.
      persona: active.persona,
      contextNote: contextNote ?? undefined,
      executionDefaults,
      // Per-profile tool-step budget (BASED-AI-PROFILE-STEPCAP); exhausting it ends the run
      // tool-calls-last, which the UI turns into a "keep going?" prompt.
      maxSteps: profile.maxToolSteps,
      toolDeps: {
        ...childDeps,
        // Traces: BASED-AGENT-TRANSCRIPT — parent-only, exactly like runSubagent below: a subagent
        // shares this thread id but must not write the user's transcript, and the missing dep is
        // what removes save_chat_transcript from its surface rather than a check at call time.
        threadId: () => (input as { threadId?: string }).threadId,
        recallThread: recallThreadMessages,
        runSubagent: createSubagentRunner({
          model,
          capabilities,
          toolDeps: childDeps,
          persona: active.persona,
          executionDefaults,
          // The whole-run window, not the idle one: a child task spans many model calls, no user
          // can be asked to extend it mid-tool, and the short idle window would strangle it.
          timeoutMs: resolveAiTimeouts(profile.timeoutSeconds).runMs,
          concurrency: SUBAGENT_CONCURRENCY,
        }),
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
                // Traces: BASED-AGENT-CONTEXT-RECOVERY — reaching here with an overflow means the
                // recovery processor already shed what it could and the request STILL doesn't fit,
                // so the user has to act. Say what to do; the raw provider JSON (token counts,
                // error codes) tells them nothing they can use.
                const message = isContextOverflowError(err)
                  ? "This conversation no longer fits the model's context window. Start a new chat, or switch to a profile with a larger context."
                  : String((err as { message?: string })?.message ?? err);
                controller.enqueue(aguiEncoder.encode({ type: "RUN_ERROR", message } as unknown as BaseEvent));
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
      await lsp.stopAll();
      for (const exec of executions.values()) exec.cancel();
      for (const session of sessions.values()) {
        if (session.adapter) await session.adapter.disconnect().catch(() => {});
      }
      // Bounded: after a server-initiated WebSocket close, Bun's stop(force) can wedge forever
      // (observed on Windows, Bun 1.3.14 — even with the LSP settle delay). Every stop() caller
      // exits the process right after, so a bounded wait beats hanging shutdown/test runs.
      await Promise.race([server.stop(true), new Promise((resolve) => setTimeout(resolve, 2_000))]);
      db.close();
    },
  };
}
