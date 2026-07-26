import type {
  AgentInstructionsConfig,
  AiProfile,
  AiProfileInput,
  AppSettings,
  AuditEntry,
  DbCommandPreview,
  HistoryEntry,
  EmbeddingProfile,
  EmbeddingProfileInput,
  LabelClustersRequest,
  LabelClustersResponse,
  LanceSearchRequest,
  MutationResult,
  QueryChunk,
  RelationsGraph,
  RerankerProfile,
  RerankerProfileInput,
  RoutineParameter,
  ScriptAction,
  SearchRows,
  TableDetails,
  TableChangeSet,
  TableEditResult,
  TableFilter,
  TablePage,
  TableSort,
  VectorSampleHeader,
  WindowState,
} from "./types";

// Per-launch token: the shell passes it in the URL hash; dev falls back to the fixed dev token.
export const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "dev";

// Per-window session id: the shell mints one per window so the backend can treat each window
// as an independent workspace (own DB connection, own SSE stream) rather than one shared session.
export const sessionId = new URLSearchParams(window.location.hash.slice(1)).get("sid") ?? "default";

/** Base URL for the lm-ag-ui agent client; relative so the Vite proxy (dev) and same-origin (prod)
 *  both route `/api/agent/capi` to the core server. */
export const AGENT_BASE_URL = "/api";

export function apiUrl(path: string): string {
  const sep = path.includes("?") ? "&" : "?";
  return `${path}${sep}token=${encodeURIComponent(token)}&sid=${encodeURIComponent(sessionId)}`;
}

// BASED-UI-SESSION-RESUME: the server can wipe a window's session out from under us (its process
// restarted — e.g. dev `bun --watch`) while this tab still believes it's connected. Such requests come
// back 409 `session-lost`. The store registers a healer that re-establishes the session; api()/streamQuery
// await it once and retry, so the restart is invisible to callers instead of surfacing "Not connected".
let sessionHealer: (() => Promise<boolean>) | null = null;
export function setSessionHealer(fn: () => Promise<boolean>): void {
  sessionHealer = fn;
}

/** True when a failed response is the server telling us this window's session vanished. */
function isSessionLost(status: number, code: string | undefined): boolean {
  return status === 409 && code === "session-lost";
}

export async function api<T>(path: string, init?: RequestInit, retry = true): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    let code: string | undefined;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = code = body.error;
    } catch {
      // non-JSON error body
    }
    if (isSessionLost(res.status, code)) {
      if (retry && sessionHealer && (await sessionHealer())) return api<T>(path, init, false);
      message = "Lost the server session and couldn't reconnect.";
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

/** POST the query and feed NDJSON chunks to the callback as they stream in. */
export async function streamQuery(
  sql: string,
  onChunk: (chunk: QueryChunk) => void,
  opts?: { capturePlan?: boolean; captureStats?: boolean; rowCap?: number },
  retry = true,
): Promise<void> {
  const res = await fetch(apiUrl("/api/session/query"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, ...opts }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (retry && isSessionLost(res.status, body.error) && sessionHealer && (await sessionHealer())) {
      return streamQuery(sql, onChunk, opts, false);
    }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onChunk(JSON.parse(line) as QueryChunk);
    }
  }
}

// --- CSV import (BASED-IMPORT-CSV-UI) ---

export function openFileDialogApi(kind: "csv" | "sql" | "xlsx"): Promise<{ path: string | null }> {
  return api<{ path: string | null }>("/api/dialog/open-file", { method: "POST", body: JSON.stringify({ kind }) });
}

// Traces: BASED-FILE-OPEN-SQL — native open dialog + file read in one call; { path: null } on cancel.
/** No `path` → native open dialog; explicit `path` (BASED-OPEN-SQL-ARGV) skips the dialog. */
export function openSqlFileApi(path?: string): Promise<{ path: string | null; content?: string }> {
  return api<{ path: string | null; content?: string }>("/api/file/open-sql", { method: "POST", body: JSON.stringify(path ? { path } : {}) });
}

export function inspectCsv(path: string): Promise<{ header: string[]; rows: string[][] }> {
  return api<{ header: string[]; rows: string[][] }>("/api/import/csv/inspect", {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export interface CsvImportRequest {
  path: string;
  schema: string;
  table: string;
  hasHeader: boolean;
  mapping: Array<{ csvIndex: number; column: string }>;
  nullEmpty: boolean;
  skipBadRows: boolean;
}

export type CsvImportChunk =
  | { type: "progress"; inserted: number; totalRows: number }
  | { type: "rowError"; row: number; error: string }
  | { type: "done"; status: "ok" | "error"; inserted: number; failed: number; durationMs: number; error?: string };

/** POST the import request and feed NDJSON progress chunks to the callback as they stream in. */
export async function streamCsvImport(reqBody: CsvImportRequest, onChunk: (chunk: CsvImportChunk) => void): Promise<void> {
  const res = await fetch(apiUrl("/api/import/csv/run"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(reqBody),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line) onChunk(JSON.parse(line) as CsvImportChunk);
    }
  }
}

export function getSettings(): Promise<AppSettings> {
  return api<AppSettings>("/api/settings");
}

export function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  return api<AppSettings>("/api/settings", { method: "POST", body: JSON.stringify(patch) });
}

/** This window's persisted view state (BASED-WINDOW-RESTORE) — which connection/tab/schema filter
 *  it last showed, keyed by the sid the shell minted for it. */
export function fetchWindowState(): Promise<WindowState> {
  return api<WindowState>("/api/window-state");
}

export function saveWindowState(patch: Partial<Pick<WindowState, "activeTabId" | "schemaFilter">>): Promise<WindowState> {
  return api<WindowState>("/api/window-state", { method: "POST", body: JSON.stringify(patch) });
}

/** Query history for a connection (BASED-HISTORY-UI), most-recent-first. */
export function fetchHistory(connectionId: string): Promise<HistoryEntry[]> {
  return api<HistoryEntry[]>(`/api/history?connectionId=${encodeURIComponent(connectionId)}`);
}

/** Agent audit log for a connection (BASED-AGENT-AUDIT), most-recent-first. */
export function fetchAgentAudit(connectionId: string): Promise<AuditEntry[]> {
  return api<AuditEntry[]>(`/api/agent/audit?connectionId=${encodeURIComponent(connectionId)}`);
}

/** Named AI provider (agent) profiles (BASED-AI-PROVIDER-PROFILES) — CRUD mirrors embedding/reranker
 *  profiles; the active one is switched via `setActiveAiProfile` and persisted in AppSettings. */
export function listAiProfiles(): Promise<AiProfile[]> {
  return api<AiProfile[]>("/api/ai-profiles");
}

export function saveAiProfile(input: AiProfileInput): Promise<AiProfile> {
  return api<AiProfile>("/api/ai-profiles", { method: "POST", body: JSON.stringify(input) });
}

export function deleteAiProfile(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/api/ai-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

export function setActiveAiProfile(id: string): Promise<AppSettings> {
  return api<AppSettings>("/api/ai-profiles/active", { method: "POST", body: JSON.stringify({ id }) });
}

/** Named, per-engine agent instruction sets (BASED-AGENT-INSTRUCTIONS). The "default" set is
 *  always present and read-only. */
export function getAgentInstructions(): Promise<AgentInstructionsConfig> {
  return api<AgentInstructionsConfig>("/api/agent/instructions");
}

/** Create (omit `id`) or update (matching `id`) a custom instruction set. Rejects `id: "default"`. */
export function saveAgentInstructionSet(set: {
  id?: string;
  name: string;
  core: string;
  mssqlPersona: string;
  lancePersona: string;
}): Promise<AgentInstructionsConfig> {
  return api<AgentInstructionsConfig>("/api/agent/instructions", { method: "POST", body: JSON.stringify(set) });
}

export function setActiveAgentInstructionSet(id: string): Promise<AgentInstructionsConfig> {
  return api<AgentInstructionsConfig>("/api/agent/instructions/active", { method: "POST", body: JSON.stringify({ id }) });
}

export function deleteAgentInstructionSet(id: string): Promise<AgentInstructionsConfig> {
  return api<AgentInstructionsConfig>(`/api/agent/instructions/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Run an agent-proposed mutation after the user approves it (BASED-AGENT-MUTATION-GATE). */
export function runAgentMutation(sql: string): Promise<MutationResult> {
  return api<MutationResult>("/api/agent/mutation", {
    method: "POST",
    body: JSON.stringify({ sql, approved: true }),
  });
}

/** Read one page of a table's rows for the Data view (BASED-TABLE-BROWSE); optional server-side
 *  sort + filters for engines with `orderedBrowse` (BASED-TABLE-ORDERBY). */
export function fetchTablePage(
  schema: string,
  table: string,
  offset: number,
  limit: number,
  sort?: TableSort[],
  filters?: TableFilter[],
): Promise<TablePage> {
  let qs = `schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&offset=${offset}&limit=${limit}`;
  if (sort && sort.length > 0) qs += `&sort=${encodeURIComponent(JSON.stringify(sort))}`;
  if (filters && filters.length > 0) qs += `&filters=${encodeURIComponent(JSON.stringify(filters))}`;
  return api<TablePage>(`/api/session/table-data?${qs}`);
}

/** Full table introspection + server-computed CREATE script (BASED-TABLE-DETAILS). */
export function fetchTableDetails(schema: string, table: string): Promise<{ details: TableDetails; createScript: string | null }> {
  return api<{ details: TableDetails; createScript: string | null }>(
    `/api/session/table-details?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}`,
  );
}

/** Script one or more objects as CREATE/DROP/etc. (BASED-SCRIPT-API). */
export function postScript(
  objects: Array<{ schema: string; name: string; type: "table" | "view" | "procedure" | "function" }>,
  action: ScriptAction,
): Promise<{ sql: string; errors: Array<{ schema: string; name: string; message: string }> }> {
  return api("/api/session/script", { method: "POST", body: JSON.stringify({ objects, action }) });
}

/** Bulk tables + FK edges for the ER diagram (BASED-RELATIONS). Empty schema = whole database. */
export function fetchRelations(schema?: string): Promise<RelationsGraph> {
  return api<RelationsGraph>(`/api/session/relations${schema ? `?schema=${encodeURIComponent(schema)}` : ""}`);
}

/** Build (but do not run) the parameterized commands for a change set — the Review SQL peek. */
export function previewTableEdit(change: TableChangeSet): Promise<{ commands: DbCommandPreview[] }> {
  return api<{ commands: DbCommandPreview[] }>("/api/session/table-edit", {
    method: "POST",
    body: JSON.stringify({ ...change, preview: true }),
  });
}

/** Commit a change set in one transaction (BASED-TABLE-COMMIT). */
export function commitTableEdit(change: TableChangeSet): Promise<TableEditResult> {
  return api<TableEditResult>("/api/session/table-edit", {
    method: "POST",
    body: JSON.stringify(change),
  });
}

/** SQL definition text for a view/procedure/function (BASED-VIEW-DEFINITION, BASED-ROUTINE-DETAILS). */
export function fetchObjectDefinition(schema: string, name: string): Promise<{ definition: string | null }> {
  const qs = `schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(name)}`;
  return api<{ definition: string | null }>(`/api/session/definition?${qs}`);
}

/** Parameter list for a stored procedure or function (BASED-ROUTINE-DETAILS). */
export function fetchRoutineParameters(schema: string, name: string): Promise<RoutineParameter[]> {
  const qs = `schema=${encodeURIComponent(schema)}&name=${encodeURIComponent(name)}`;
  return api<RoutineParameter[]>(`/api/session/parameters?${qs}`);
}

/** Unified vector/keyword/hybrid search for the Data tab (BASED-LANCE-SEARCH-UNIFIED). */
export function runLanceSearch(req: LanceSearchRequest): Promise<SearchRows> {
  return api<SearchRows>("/api/session/lance-search", { method: "POST", body: JSON.stringify(req) });
}

/** Full-precision vector sample for the Embeddings view (BASED-EMBED-VECTORS). Binary response
 *  (BASED-EMBED-WIRE): [u32 headerLen][JSON header, 4-byte padded][raw f32 block] — the padding
 *  makes the Float32Array view over the response buffer legal without a copy. */
export async function fetchTableVectors(
  schema: string,
  table: string,
  column: string,
  limit: number,
  retry = true,
): Promise<{ header: VectorSampleHeader; vectors: Float32Array }> {
  const qs = `schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&column=${encodeURIComponent(column)}&limit=${limit}`;
  const res = await fetch(apiUrl(`/api/session/table-vectors?${qs}`), {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (retry && isSessionLost(res.status, body.error) && sessionHealer && (await sessionHealer())) {
      return fetchTableVectors(schema, table, column, limit, false);
    }
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  const headerLen = new DataView(buf).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, headerLen))) as VectorSampleHeader;
  const vectors = new Float32Array(buf, 4 + headerLen, (buf.byteLength - 4 - headerLen) / 4);
  return { header, vectors };
}

/** One-shot AI naming for embedding clusters (BASED-EMBED-LABELS-AI). */
export function labelClusters(req: LabelClustersRequest): Promise<LabelClustersResponse> {
  return api<LabelClustersResponse>("/api/session/label-clusters", { method: "POST", body: JSON.stringify(req) });
}

/** Named embedding profiles (BASED-LANCE-EMBED-PROFILES). */
export function listEmbeddingProfiles(): Promise<EmbeddingProfile[]> {
  return api<EmbeddingProfile[]>("/api/embedding-profiles");
}

export function saveEmbeddingProfile(input: EmbeddingProfileInput): Promise<EmbeddingProfile> {
  return api<EmbeddingProfile>("/api/embedding-profiles", { method: "POST", body: JSON.stringify(input) });
}

export function deleteEmbeddingProfile(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/api/embedding-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Named reranker profiles (BASED-LANCE-RERANK-PROFILES). */
export function listRerankerProfiles(): Promise<RerankerProfile[]> {
  return api<RerankerProfile[]>("/api/reranker-profiles");
}

export function saveRerankerProfile(input: RerankerProfileInput): Promise<RerankerProfile> {
  return api<RerankerProfile>("/api/reranker-profiles", { method: "POST", body: JSON.stringify(input) });
}

export function deleteRerankerProfile(id: string): Promise<{ ok: boolean }> {
  return api<{ ok: boolean }>(`/api/reranker-profiles/${encodeURIComponent(id)}`, { method: "DELETE" });
}

/** Native folder picker for the LanceDB directory-path field (BASED-LANCE-FOLDER-BROWSE). */
export function browseFolder(startingFolder?: string): Promise<{ path: string | null }> {
  return api<{ path: string | null }>("/api/dialog/folder", {
    method: "POST",
    body: JSON.stringify({ startingFolder }),
  });
}

export function openEvents(onEvent: (event: Record<string, unknown>) => void): EventSource {
  const es = new EventSource(apiUrl("/api/events"));
  es.onmessage = (e) => {
    try {
      onEvent(JSON.parse(e.data));
    } catch {
      // ignore malformed frames
    }
  };
  return es;
}
