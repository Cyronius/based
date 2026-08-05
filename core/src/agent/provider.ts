// Traces: BASED-AI-PROVIDER, BASED-AI-PROVIDER-WIRED, BASED-AI-PROFILE-PARAMS, BASED-AI-PROFILE-TIMEOUT
// Provider configuration (persisted, secret-free) + resolution to an AI SDK LanguageModel.
// All four kinds are wired natively: openai-compatible (e.g. a local LM Studio server) plus
// openai / azure-openai / anthropic via their official @ai-sdk providers (the ai@7 generation —
// @ai-sdk/provider@4.x; Mastra's ai@6 transitive copies are a separate, untouched tree).
import type { Database } from "bun:sqlite";
import type { LanguageModel } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAzure } from "@ai-sdk/azure";
import { createAnthropic } from "@ai-sdk/anthropic";

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

export class AiConfigStore {
  constructor(private readonly db: Database) {}

  /** `null` when no config has ever been saved — there is no built-in default. */
  get(): AiConfig | null {
    const row = this.db.query<{ json: string }, []>("SELECT json FROM ai_config WHERE id = 1").get();
    return row ? (JSON.parse(row.json) as AiConfig) : null;
  }

  save(config: AiConfig): AiConfig {
    this.db.run("INSERT INTO ai_config (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json", [
      JSON.stringify(config),
    ]);
    return config;
  }
}

/** The subset of AiConfig/AiProfile resolveModel needs — satisfied by either shape. */
export interface ResolvableAiConfig {
  /** Stable id used to name the openai-compatible provider instance (cosmetic; not a secret key). */
  id: string;
  kind: ProviderKind;
  baseUrl: string;
  model: string;
  deployment?: string;
}

/**
 * Resolve the active config into an AI SDK model. `apiKey` comes from Credential Manager (may be
 * empty for a keyless local server — LM Studio ignores it, but the SDK wants a non-empty string).
 */
export function resolveModel(config: ResolvableAiConfig, apiKey: string | null): LanguageModel {
  switch (config.kind) {
    case "openai-compatible": {
      // LM Studio ignores the key but the SDK wants a non-empty string. The provider *name* is the
      // stable "openai-compatible" (not the profile id) so params JSON has a predictable
      // providerOptions namespace (BASED-AI-PROFILE-PARAMS) — the model spreads that namespace's
      // object straight into the request body.
      const key = apiKey && apiKey.length > 0 ? apiKey : "not-needed";
      const provider = createOpenAICompatible({ name: "openai-compatible", baseURL: config.baseUrl, apiKey: key });
      return provider(config.model);
    }
    case "openai": {
      const provider = createOpenAI({ apiKey: requireKey(apiKey, "openai"), ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
      return provider(config.model);
    }
    case "azure-openai": {
      // baseUrl is the full resource endpoint (https://<resource>.openai.azure.com); what runs is
      // the *deployment*, not the model field.
      if (!config.deployment) throw new Error('Azure OpenAI requires a deployment name (profile "Deployment" field)');
      const provider = createAzure({ apiKey: requireKey(apiKey, "azure-openai"), ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
      return provider(config.deployment);
    }
    case "anthropic": {
      const provider = createAnthropic({ apiKey: requireKey(apiKey, "anthropic"), ...(config.baseUrl ? { baseURL: config.baseUrl } : {}) });
      return provider(config.model);
    }
  }
}

function requireKey(apiKey: string | null, kind: ProviderKind): string {
  if (!apiKey) throw new Error(`Provider "${kind}" requires an API key — set one on the profile (stored in Credential Manager)`);
  return apiKey;
}

// --- per-profile model parameters (BASED-AI-PROFILE-PARAMS) ---

/** AI SDK call-settings keys recognized at the top level of a profile's params JSON. */
const MODEL_SETTING_KEYS = [
  "temperature",
  "topP",
  "topK",
  "maxOutputTokens",
  "presencePenalty",
  "frequencyPenalty",
  "stopSequences",
  "seed",
  "maxRetries",
] as const;
const MODEL_SETTING_KEY_SET: ReadonlySet<string> = new Set(MODEL_SETTING_KEYS);

/** providerOptions namespace per kind — must match the provider's registered name (azure rides the
 *  openai models, so its namespace is "openai"). */
export function providerOptionsNamespace(kind: ProviderKind): string {
  switch (kind) {
    case "openai-compatible":
      return "openai-compatible";
    case "openai":
    case "azure-openai":
      return "openai";
    case "anthropic":
      return "anthropic";
  }
}

export interface ExecutionDefaults {
  /** AI SDK call settings (temperature, topP, …) for Mastra's `modelSettings`. */
  modelSettings?: Record<string, unknown>;
  /** Provider-specific options keyed by provider namespace for Mastra's `providerOptions`. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

/**
 * Split a profile's params JSON into Mastra execution defaults. Recognized call-settings keys →
 * `modelSettings`; an explicit `providerOptions` key passes through verbatim; every other key lands
 * under the kind's provider-options namespace. Pure — unit-tested (BASED-AI-PROFILE-PARAMS).
 */
export function resolveExecutionDefaults(kind: ProviderKind, params: Record<string, unknown> | undefined): ExecutionDefaults {
  if (!params) return {};
  const modelSettings: Record<string, unknown> = {};
  const namespaced: Record<string, unknown> = {};
  let explicit: Record<string, Record<string, unknown>> | undefined;
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined) continue;
    if (k === "providerOptions" && v !== null && typeof v === "object" && !Array.isArray(v)) {
      explicit = v as Record<string, Record<string, unknown>>;
    } else if (MODEL_SETTING_KEY_SET.has(k)) {
      modelSettings[k] = v;
    } else {
      namespaced[k] = v;
    }
  }
  const ns = providerOptionsNamespace(kind);
  let providerOptions: Record<string, Record<string, unknown>> | undefined;
  if (explicit || Object.keys(namespaced).length > 0) {
    providerOptions = { ...explicit };
    if (Object.keys(namespaced).length > 0) providerOptions[ns] = { ...providerOptions[ns], ...namespaced };
  }
  const result: ExecutionDefaults = {};
  if (Object.keys(modelSettings).length > 0) result.modelSettings = modelSettings;
  if (providerOptions) result.providerOptions = providerOptions;
  return result;
}

// --- per-profile request timeouts (BASED-AI-PROFILE-TIMEOUT) ---

/**
 * Default no-activity window for an AI request, in seconds. In the chat this drives an
 * ask-to-keep-waiting prompt rather than a kill, so it can be short; one-shot calls (cluster
 * labeling) still abort on it. Profiles on very slow backends can raise it.
 */
export const DEFAULT_AI_TIMEOUT_SECONDS = 120;

/** Wall-clock caps get this multiple of the idle window (subagent tasks, hard backstops). */
export const AI_RUN_TIMEOUT_MULTIPLIER = 15;

export interface AiTimeouts {
  /** No-activity window in ms — the chat's stall-prompt timer and the abort on one-shot calls. */
  idleMs: number;
  /** Wall-clock cap in ms for runs with no user in the loop (subagent tasks); never reset by activity. */
  runMs: number;
}

/**
 * Resolve a profile's `timeoutSeconds` into the two windows the app enforces. Absent, non-finite or
 * non-positive values fall back to the default, so a blank field means "use the default" rather
 * than "no timeout". Pure — unit-tested (BASED-AI-PROFILE-TIMEOUT).
 */
export function resolveAiTimeouts(timeoutSeconds: number | null | undefined): AiTimeouts {
  const seconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.floor(timeoutSeconds)
      : DEFAULT_AI_TIMEOUT_SECONDS;
  const idleMs = seconds * 1000;
  return { idleMs, runMs: idleMs * AI_RUN_TIMEOUT_MULTIPLIER };
}
