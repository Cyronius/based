// Traces: BASED-SECRET-STORE — the plaintext fallback for sessions with no usable OS keyring
// (see plans/plaintext-secret-fallback.md). This is deliberately a dumb table: the value is stored
// as given, unencrypted — an app-embedded encryption key would be obfuscation, not security. The
// loudness lives in secrets.ts (per-write warning) and the UI (warning before the user types a key).
import type { Database } from "bun:sqlite";

export class SecretsFallbackStore {
  constructor(private readonly db: Database) {}

  get(account: string): string | null {
    const row = this.db
      .query<{ secret: string }, [string]>("SELECT secret FROM secrets_fallback WHERE account = ?")
      .get(account);
    return row ? row.secret : null;
  }

  set(account: string, secret: string): void {
    this.db.run(
      "INSERT INTO secrets_fallback (account, secret) VALUES (?, ?) ON CONFLICT(account) DO UPDATE SET secret = excluded.secret",
      [account, secret],
    );
  }

  delete(account: string): void {
    this.db.run("DELETE FROM secrets_fallback WHERE account = ?", [account]);
  }
}
