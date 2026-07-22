import type { AiConfig, MutationResult, QueryChunk } from "./types";

// Per-launch token: the shell passes it in the URL hash; dev falls back to the fixed dev token.
export const token = new URLSearchParams(window.location.hash.slice(1)).get("token") ?? "dev";

/** Base URL for the lm-ag-ui agent client; relative so the Vite proxy (dev) and same-origin (prod)
 *  both route `/api/agent/margin` to the core server. */
export const AGENT_BASE_URL = "/api";

export function apiUrl(path: string): string {
  return `${path}${path.includes("?") ? "&" : "?"}token=${encodeURIComponent(token)}`;
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
export async function streamQuery(sql: string, onChunk: (chunk: QueryChunk) => void): Promise<void> {
  const res = await fetch(apiUrl("/api/session/query"), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ sql }),
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

export function aiGetConfig(): Promise<AiConfig> {
  return api<AiConfig>("/api/ai/config");
}

export function aiSaveConfig(config: AiConfig & { key?: string | null }): Promise<AiConfig> {
  return api<AiConfig>("/api/ai/config", { method: "POST", body: JSON.stringify(config) });
}

/** Run an agent-proposed mutation after the user approves it (BASED-AGENT-MUTATION-GATE). */
export function runAgentMutation(sql: string): Promise<MutationResult> {
  return api<MutationResult>("/api/agent/mutation", {
    method: "POST",
    body: JSON.stringify({ sql, approved: true }),
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
