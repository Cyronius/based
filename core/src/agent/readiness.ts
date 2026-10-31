// Traces: BASED-AGENT-READY — tells the chat whether a send can work before the user tries one.
import type { ProviderKind } from "./provider";

export type AgentReadyState = "none" | "no-key" | "unreachable" | "ok";

export interface AgentReadiness {
  state: AgentReadyState;
  profileName?: string;
  detail?: string;
}

/** GET {baseUrl}/models; also feeds model-id checks later. Throws on network failure or a non-2xx. */
export async function listModels(baseUrl: string, apiKey: string | null, timeoutMs = 3000): Promise<string[]> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { data?: Array<{ id?: string }> };
  return (body.data ?? []).flatMap((m) => (m.id ? [m.id] : []));
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
