// Traces: BASED-LANCE-RERANK-PROFILES
import type { Database } from "bun:sqlite";
import type { RerankerApi } from "../db/types";

export interface RerankerProfile {
  id: string;
  name: string;
  /** Endpoint base URL. `rerank` api: a Cohere/TEI-shape server (e.g. https://api.cohere.ai/v2,
   *  self-hosted TEI/Infinity), `/rerank` appended by the caller. `openai` api: an
   *  OpenAI-compatible base like http://localhost:1234/v1, `/chat/completions` appended. */
  baseUrl: string;
  model?: string;
  /** How the endpoint is called (BASED-LANCE-RERANK-OPENAI). Absent = "rerank" (legacy rows). */
  api?: RerankerApi;
  /** openai api only: Qwen3-Reranker task instruction override. */
  instruction?: string;
  hasKey: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface RerankerProfileInput extends Omit<RerankerProfile, "id" | "hasKey" | "createdAt" | "updatedAt"> {
  id?: string;
  /** Transient — never persisted in the JSON blob; goes to Credential Manager. */
  apiKey?: string;
  hasKey?: boolean;
}

export class RerankerProfileStore {
  constructor(private readonly db: Database) {}

  list(): RerankerProfile[] {
    const rows = this.db.query<{ json: string }, []>("SELECT json FROM reranker_profiles").all();
    return rows.map((r) => JSON.parse(r.json) as RerankerProfile).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): RerankerProfile | null {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM reranker_profiles WHERE id = ?").get(id);
    return row ? (JSON.parse(row.json) as RerankerProfile) : null;
  }

  /** Persists metadata only — the transient `apiKey` on RerankerProfileInput never reaches this store. */
  save(input: RerankerProfileInput): RerankerProfile {
    const now = new Date().toISOString();
    const existing = input.id ? this.get(input.id) : null;
    const { apiKey: _apiKey, ...meta } = input;
    const profile: RerankerProfile = {
      ...meta,
      id: input.id ?? crypto.randomUUID(),
      hasKey: input.hasKey ?? existing?.hasKey ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.run(
      "INSERT INTO reranker_profiles (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      [profile.id, JSON.stringify(profile)],
    );
    return profile;
  }

  delete(id: string): void {
    this.db.run("DELETE FROM reranker_profiles WHERE id = ?", [id]);
  }
}
