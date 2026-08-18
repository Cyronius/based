// Traces: BASED-LANCE-EMBED-PROFILES
import type { Database } from "bun:sqlite";

export interface EmbeddingProfile {
  id: string;
  name: string;
  /** e.g. http://localhost:1234/v1 (LM Studio), https://api.openai.com/v1 */
  baseUrl: string;
  model: string;
  hasKey: boolean;
  /** Traces: BASED-LANCE-EMBED-DIM — output dimension of `model`. Optional because it can't be known
   *  until the model has been called once: user-settable, and otherwise back-filled by embedQuery
   *  from the first successful response (see recordDimension). Reported by list_search_profiles so
   *  profile↔column compatibility is one lookup instead of cross-tool reasoning about model names. */
  dimension?: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingProfileInput extends Omit<EmbeddingProfile, "id" | "hasKey" | "createdAt" | "updatedAt"> {
  id?: string;
  /** Transient — never persisted in the JSON blob; goes to the OS keychain. */
  apiKey?: string;
  hasKey?: boolean;
}

export class EmbeddingProfileStore {
  constructor(private readonly db: Database) {}

  list(): EmbeddingProfile[] {
    const rows = this.db.query<{ json: string }, []>("SELECT json FROM embedding_profiles").all();
    return rows.map((r) => JSON.parse(r.json) as EmbeddingProfile).sort((a, b) => a.name.localeCompare(b.name));
  }

  get(id: string): EmbeddingProfile | null {
    const row = this.db.query<{ json: string }, [string]>("SELECT json FROM embedding_profiles WHERE id = ?").get(id);
    return row ? (JSON.parse(row.json) as EmbeddingProfile) : null;
  }

  /** Persists metadata only — the transient `apiKey` on EmbeddingProfileInput never reaches this store. */
  save(input: EmbeddingProfileInput): EmbeddingProfile {
    const now = new Date().toISOString();
    const existing = input.id ? this.get(input.id) : null;
    const { apiKey: _apiKey, ...meta } = input;
    const profile: EmbeddingProfile = {
      ...meta,
      id: input.id ?? crypto.randomUUID(),
      hasKey: input.hasKey ?? existing?.hasKey ?? false,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.db.run(
      "INSERT INTO embedding_profiles (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      [profile.id, JSON.stringify(profile)],
    );
    return profile;
  }

  delete(id: string): void {
    this.db.run("DELETE FROM embedding_profiles WHERE id = ?", [id]);
  }

  /** Traces: BASED-LANCE-EMBED-DIM — remember the dimension the model actually returned. Called on
   *  every successful embed and idempotent; a changed value wins, because the profile's model may
   *  have been edited to a different one. Never throws: a failed write must not fail the search. */
  recordDimension(id: string, dimension: number): void {
    try {
      const existing = this.get(id);
      if (!existing || existing.dimension === dimension) return;
      this.db.run("UPDATE embedding_profiles SET json = ? WHERE id = ?", [
        JSON.stringify({ ...existing, dimension }),
        id,
      ]);
    } catch {
      // best-effort metadata
    }
  }
}
