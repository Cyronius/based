// Traces: BASED-AI-PROVIDER-PROFILES
import type { Database } from "bun:sqlite";
import type { ProviderKind } from "../agent/provider";

export interface AiProfile {
  id: string;
  name: string;
  kind: ProviderKind;
  /** Base URL for openai-compatible / azure endpoints (e.g. LM Studio http://host:1234/v1). */
  baseUrl: string;
  model: string;
  /** Azure deployment name (azure-openai only). */
  deployment?: string;
  /** Instruction set this agent runs against (BASED-AGENT-INSTRUCTIONS). "default" or a custom set id. */
  instructionSetId: string;
  /** Model parameter JSON (BASED-AI-PROFILE-PARAMS): call settings + provider options, no secrets. */
  params?: Record<string, unknown>;
  /** No-activity window for this profile's requests, in seconds (BASED-AI-PROFILE-TIMEOUT).
   *  Absent = DEFAULT_AI_TIMEOUT_SECONDS; see `resolveAiTimeouts`. */
  timeoutSeconds?: number;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiProfileInput extends Omit<AiProfile, "id" | "instructionSetId" | "hasKey" | "createdAt" | "updatedAt"> {
  id?: string;
  /** Defaults to "default" when omitted. */
  instructionSetId?: string;
  /** Transient — never persisted in the JSON blob; goes to Credential Manager. */
  apiKey?: string;
  hasKey?: boolean;
}

export class AiProfileStore {
  constructor(private readonly db: Database) {}

  /** Legacy rows predate `instructionSetId`; default them to the built-in "default" set on read. */
  private normalize(p: AiProfile): AiProfile {
    return { ...p, instructionSetId: p.instructionSetId ?? "default" };
  }

  list(): AiProfile[] {
    const rows = this.db.query<{ json: string }, []>("SELECT json FROM ai_profiles").all();
    return rows.map((r) => this.normalize(JSON.parse(r.json) as AiProfile)).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): AiProfile | null {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM ai_profiles WHERE id = ?").get(id);
    return row ? this.normalize(JSON.parse(row.json) as AiProfile) : null;
  }

  /** Persists metadata only — the transient `apiKey` on AiProfileInput never reaches this store. */
  save(input: AiProfileInput): AiProfile {
    const now = new Date().toISOString();
    const existing = input.id ? this.get(input.id) : null;
    const { apiKey: _apiKey, ...meta } = input;
    const profile: AiProfile = {
      ...meta,
      id: input.id ?? crypto.randomUUID(),
      instructionSetId: meta.instructionSetId ?? existing?.instructionSetId ?? "default",
      hasKey: input.hasKey ?? existing?.hasKey ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.run(
      "INSERT INTO ai_profiles (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      [profile.id, JSON.stringify(profile)],
    );
    return profile;
  }

  delete(id: string): void {
    this.db.run("DELETE FROM ai_profiles WHERE id = ?", [id]);
  }
}
