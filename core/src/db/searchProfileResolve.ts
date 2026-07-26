// Traces: BASED-LANCE-EMBED-PROFILES, BASED-LANCE-RERANK-PROFILES, BASED-LANCE-CONN-DEFAULT-PROFILES
// Shared by server.ts's /api/session/lance-search route and the agent's vector/text/hybrid_search
// tools: turn a wire profile id into a resolved (secret-fetched) profile the adapter can use.
//
// `defaultId` is the connected connection's default profile. The two ids fail differently on
// purpose: an *explicit* unknown id is a caller (usually the model) naming something that doesn't
// exist and must say so, while a dangling *default* — the profile was deleted since the connection
// was configured — degrades to "no profile", so the caller gets the actionable "configure one"
// guidance instead of a uuid it never chose.
import type { EmbeddingProfileStore } from "../storage/embeddingProfiles";
import type { RerankerProfileStore } from "../storage/rerankerProfiles";
import type { ResolvedEmbeddingProfile, ResolvedRerankerProfile } from "./types";

export function resolveEmbeddingProfile(
  store: EmbeddingProfileStore,
  getKey: (id: string) => string | null,
  id?: string,
  defaultId?: string | null,
): ResolvedEmbeddingProfile | undefined {
  const resolved = (() => {
    if (!id) return defaultId ? store.get(defaultId) : null;
    const p = store.get(id);
    if (!p) throw new Error(`Unknown embedding profile: ${id}`);
    return p;
  })();
  if (!resolved) return undefined;
  return {
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    apiKey: getKey(resolved.id) ?? undefined,
    // Traces: BASED-LANCE-EMBED-DIM — back-fill the profile's dimension from the first real embed.
    onDimension: (dimension) => store.recordDimension(resolved.id, dimension),
  };
}

export function resolveRerankerProfile(
  store: RerankerProfileStore,
  getKey: (id: string) => string | null,
  id?: string,
  defaultId?: string | null,
): ResolvedRerankerProfile | undefined {
  const resolved = (() => {
    if (!id) return defaultId ? store.get(defaultId) : null;
    const p = store.get(id);
    if (!p) throw new Error(`Unknown reranker profile: ${id}`);
    return p;
  })();
  if (!resolved) return undefined;
  return {
    baseUrl: resolved.baseUrl,
    model: resolved.model,
    apiKey: getKey(resolved.id) ?? undefined,
    api: resolved.api,
    instruction: resolved.instruction,
  };
}
