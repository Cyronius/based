// Traces: BASED-LANCE-EMBED-PROFILES, BASED-LANCE-RERANK-PROFILES
// Shared by server.ts's /api/session/lance-search route and the agent's vector/text/hybrid_search
// tools: turn a wire profile id into a resolved (secret-fetched) profile the adapter can use.
import type { EmbeddingProfileStore } from "../storage/embeddingProfiles";
import type { RerankerProfileStore } from "../storage/rerankerProfiles";
import type { ResolvedEmbeddingProfile, ResolvedRerankerProfile } from "./types";

export function resolveEmbeddingProfile(
  store: EmbeddingProfileStore,
  getKey: (id: string) => string | null,
  id?: string,
): ResolvedEmbeddingProfile | undefined {
  if (!id) return undefined;
  const p = store.get(id);
  if (!p) throw new Error(`Unknown embedding profile: ${id}`);
  return { baseUrl: p.baseUrl, model: p.model, apiKey: getKey(p.id) ?? undefined };
}

export function resolveRerankerProfile(
  store: RerankerProfileStore,
  getKey: (id: string) => string | null,
  id?: string,
): ResolvedRerankerProfile | undefined {
  if (!id) return undefined;
  const p = store.get(id);
  if (!p) throw new Error(`Unknown reranker profile: ${id}`);
  return { baseUrl: p.baseUrl, model: p.model, apiKey: getKey(p.id) ?? undefined, api: p.api, instruction: p.instruction };
}
