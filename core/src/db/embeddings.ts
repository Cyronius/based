// Traces: BASED-LANCE-EMBED-COMPUTE
// based computes query embeddings itself, rather than relying on LanceDB's native registered-
// embedding-function mechanism (which requires setup outside based on a per-table basis). Any
// OpenAI-compatible /v1/embeddings endpoint works here — LM Studio, OpenAI, or similar.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { embed } from "ai";
import type { ResolvedEmbeddingProfile } from "./types";

export async function embedQuery(profile: ResolvedEmbeddingProfile, text: string): Promise<number[]> {
  const key = profile.apiKey && profile.apiKey.length > 0 ? profile.apiKey : "not-needed";
  const provider = createOpenAICompatible({ name: "based-embed", baseURL: profile.baseUrl, apiKey: key });
  const { embedding } = await embed({ model: provider.embeddingModel(profile.model), value: text });
  return embedding;
}
