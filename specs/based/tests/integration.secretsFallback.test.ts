// Traces: BASED-SECRET-STORE — the plaintext fallback for keyring-less sessions
// (plans/plaintext-secret-fallback.md). BASED_KEYRING=off forces the unavailable state, so every
// branch here runs on any host; the upgrade test additionally uses the host's real keyring, same
// requirement as integration.secrets.test.ts.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  MAX_SECRET_BYTES,
  SecretsFallbackStore,
  deleteSecret,
  getSecret,
  openDb,
  registerSecretsFallback,
  secretStoreStatus,
  setSecret,
  startServer,
} from "@based/core";
import type { Database } from "bun:sqlite";

const PREV_ENV = process.env.BASED_KEYRING;
let db: Database;
let store: SecretsFallbackStore;

beforeAll(() => {
  db = openDb(":memory:");
  store = new SecretsFallbackStore(db);
  registerSecretsFallback(store);
});

afterAll(() => {
  registerSecretsFallback(null);
  if (PREV_ENV === undefined) delete process.env.BASED_KEYRING;
  else process.env.BASED_KEYRING = PREV_ENV;
});

function rawRow(account: string): string | undefined {
  return db.query<{ secret: string }, [string]>("SELECT secret FROM secrets_fallback WHERE account = ?").get(account)
    ?.secret;
}

function withKeyringOff<T>(fn: () => T): T {
  process.env.BASED_KEYRING = "off";
  try {
    return fn();
  } finally {
    if (PREV_ENV === undefined) delete process.env.BASED_KEYRING;
    else process.env.BASED_KEYRING = PREV_ENV;
  }
}

describe("BASED-SECRET-STORE: plaintext fallback when the keyring is unavailable", () => {
  test("unavailable: set → get round-trips via the fallback, and the raw row IS plaintext", () => {
    withKeyringOff(() => {
      setSecret("fb-roundtrip", "hunter2");
      expect(getSecret("fb-roundtrip")).toBe("hunter2");
      // Plaintext is the contract, not an accident — the warning says exactly this.
      expect(rawRow("fb-roundtrip")).toBe("hunter2");
      deleteSecret("fb-roundtrip");
      expect(getSecret("fb-roundtrip")).toBeNull();
      expect(rawRow("fb-roundtrip")).toBeUndefined();
    });
  });

  test("unavailable: the byte cap still applies — portability rule, not a keyring rule", () => {
    withKeyringOff(() => {
      expect(() => setSecret("fb-huge", "x".repeat(MAX_SECRET_BYTES + 1))).toThrow(/holds at most/);
      expect(getSecret("fb-huge")).toBeNull();
      expect(rawRow("fb-huge")).toBeUndefined();
    });
  });

  // Needs the host's real keyring, like the rest of integration.secrets.test.ts.
  test("available: a pre-seeded fallback row is readable, and a keyring write purges it", () => {
    const id = "fb-upgrade";
    try {
      store.set(id, "saved-without-keyring");
      // Keyring miss falls through to the fallback — a key saved on a keyring-less machine works.
      expect(getSecret(id)).toBe("saved-without-keyring");
      // The next write with a working keyring upgrades in place: keyring holds it, row is gone.
      setSecret(id, "saved-with-keyring");
      expect(rawRow(id)).toBeUndefined();
      expect(getSecret(id)).toBe("saved-with-keyring");
    } finally {
      deleteSecret(id);
    }
  });

  test("secretStoreStatus names the live backend", () => {
    withKeyringOff(() => {
      const off = secretStoreStatus();
      expect(off.backend).toBe("plaintext");
      expect(off.reason).toMatch(/BASED_KEYRING=off/);
    });
  });

  // Last on purpose: startServer registers its own app.db-backed fallback store, replacing the
  // in-memory one the tests above use.
  test("GET /api/secret-store reports what the editors need to warn about", async () => {
    const server = startServer({
      token: "fb-token",
      dbPath: join(mkdtempSync(join(tmpdir(), "based-spec-fb-")), "app.db"),
    });
    process.env.BASED_KEYRING = "off"; // set for the whole await — the handler reads env server-side
    try {
      const res = await fetch(`${server.url}/api/secret-store`, { headers: { authorization: "Bearer fb-token" } });
      const status = (await res.json()) as { backend: string; reason?: string };
      expect(status.backend).toBe("plaintext");
      expect(status.reason).toMatch(/BASED_KEYRING=off/);
    } finally {
      if (PREV_ENV === undefined) delete process.env.BASED_KEYRING;
      else process.env.BASED_KEYRING = PREV_ENV;
      await server.stop();
    }
  });
});
