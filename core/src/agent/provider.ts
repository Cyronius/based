// Traces: BASED-AI-PROVIDER
// Provider configuration (persisted, secret-free) + resolution to an AI SDK LanguageModel.
// This pass wires the openai-compatible path (the local LM Studio default); the openai / azure /
// anthropic branches are stubbed against the same shape for the deferred settings screen.
import type { Database } from "bun:sqlite";
import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

export type ProviderKind = "openai-compatible" | "openai" | "azure-openai" | "anthropic";

export interface AiConfig {
  /** Stable id used to key the API key in Credential Manager. */
  providerId: string;
  kind: ProviderKind;
  /** Base URL for openai-compatible / azure endpoints (e.g. LM Studio http://host:1234/v1). */
  baseUrl: string;
  /** Model id the agent runs against. */
  model: string;
  /** Azure deployment name (azure-openai only). */
  deployment?: string;
  /** Whether an API key is stored in Credential Manager for this provider. */
  hasKey: boolean;
}

/** Out-of-box default: local LM Studio, OpenAI-compatible, no key required. */
export const DEFAULT_AI_CONFIG: AiConfig = {
  providerId: "default",
  kind: "openai-compatible",
  baseUrl: "http://172.18.80.1:1234/v1",
  model: "google/gemma-4-26b-a4b",
  hasKey: false,
};

export class AiConfigStore {
  constructor(private readonly db: Database) {}

  get(): AiConfig {
    const row = this.db.query<{ json: string }, []>("SELECT json FROM ai_config WHERE id = 1").get();
    return row ? { ...DEFAULT_AI_CONFIG, ...(JSON.parse(row.json) as Partial<AiConfig>) } : DEFAULT_AI_CONFIG;
  }

  save(config: AiConfig): AiConfig {
    this.db.run("INSERT INTO ai_config (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", [
      JSON.stringify(config),
    ]);
    return config;
  }
}

/**
 * Resolve the active config into an AI SDK model. `apiKey` comes from Credential Manager (may be
 * empty for a keyless local server — LM Studio ignores it, but the SDK wants a non-empty string).
 */
export function resolveModel(config: AiConfig, apiKey: string | null): LanguageModel {
  const key = apiKey && apiKey.length > 0 ? apiKey : "not-needed";
  switch (config.kind) {
    case "openai-compatible": {
      const provider = createOpenAICompatible({ name: config.providerId, baseURL: config.baseUrl, apiKey: key });
      return provider(config.model);
    }
    case "openai":
    case "azure-openai":
    case "anthropic":
      // Deferred: the settings screen wires these via their @ai-sdk/* providers. Until then any
      // provider reachable through an OpenAI-compatible gateway works via the branch above.
      throw new Error(`Provider "${config.kind}" is not wired yet — use an openai-compatible endpoint for now`);
  }
}
