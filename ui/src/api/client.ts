import type {
  AgentInstructionsConfig,
  AiConfig,
  AppSettings,
  DbCommandPreview,
  MutationResult,
  QueryChunk,
  RoutineParameter,
  TableChangeSet,
  TableEditResult,
  TablePage,
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

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(apiUrl(path), {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // non-JSON error body
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
): Promise<void> {
  const res = await fetch(apiUrl("/api/session/query"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql, ...opts }),
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
      if (line) onChunk(JSON.parse(line) as QueryChunk);
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

export function aiGetConfig(): Promise<AiConfig> {
  return api<AiConfig>("/api/ai/config");
}

export function aiSaveConfig(config: AiConfig & { key?: string | null }): Promise<AiConfig> {
  return api<AiConfig>("/api/ai/config", { method: "POST", body: JSON.stringify(config) });
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

/** Read one page of a table's rows for the Data view (BASED-TABLE-BROWSE). */
export function fetchTablePage(schema: string, table: string, offset: number, limit: number): Promise<TablePage> {
  const qs = `schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}&offset=${offset}&limit=${limit}`;
  return api<TablePage>(`/api/session/table-data?${qs}`);
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
