// Traces: BASED-AGENT-READY — tells the chat whether a send can work before the user tries one.
import type { ProviderKind } from "./provider";

export type AgentReadyState = "none" | "no-key" | "unreachable" | "ok";

export interface AgentReadiness {
  state: AgentReadyState;
  profileName?: string;
  detail?: string;
}

async function fetchModelIds(url: string, headers: Record<string, string>, timeoutMs: number): Promise<string[]> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
}

/** GET {baseUrl}/models. Throws on network failure or a non-2xx. */
export function listModels(baseUrl: string, apiKey: string | null, timeoutMs = 3000): Promise<string[]> {
  return fetchModelIds(`${baseUrl.replace(/\/+$/, "")}/models`, apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, timeoutMs);
}

// Same defaults the AI SDK providers use when the profile leaves the base URL blank.
const DEFAULT_BASE_URL: Partial<Record<ProviderKind, string>> = {
  openai: "https://api.openai.com/v1",
  anthropic: "https://api.anthropic.com/v1",
};

/** Traces: BASED-AI-MODEL-PICKER — model ids a profile's endpoint serves, sorted. Azure has no
 *  listing on its inference endpoint, so it returns []. Throws on network failure or a non-2xx. */
export async function listProviderModels(kind: ProviderKind, baseUrl: string, apiKey: string | null, timeoutMs = 10000): Promise<string[]> {
  if (kind === "azure-openai") return [];
  const base = (baseUrl.trim() || DEFAULT_BASE_URL[kind] || "").replace(/\/+$/, "");
  if (!base) throw new Error("The profile has no base URL.");
  const ids =
    kind === "anthropic"
      ? await fetchModelIds(`${base}/models?limit=1000`, { ...(apiKey ? { "x-api-key": apiKey } : {}), "anthropic-version": "2023-06-01" }, timeoutMs)
      : await listModels(base, apiKey, timeoutMs);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

export async function agentReadiness(
  profile: { name: string; kind: ProviderKind; baseUrl: string } | null,
  apiKey: string | null,
  probe: typeof listModels = listModels,
): Promise<AgentReadiness> {
  if (!profile) return { state: "none" };
  const profileName = profile.name;
  // Hosted providers are not probed: a request costs money and adds a delay on every rail open.
  if (profile.kind !== "openai-compatible") return apiKey ? { state: "ok", profileName } : { state: "no-key", profileName };
  if (!profile.baseUrl) return { state: "unreachable", profileName, detail: "The profile has no base URL." };
  try {
    await probe(profile.baseUrl, apiKey);
    return { state: "ok", profileName };
  } catch (err) {
    return { state: "unreachable", profileName, detail: `${profile.baseUrl} — ${err instanceof Error ? err.message : String(err)}` };
  }
}
