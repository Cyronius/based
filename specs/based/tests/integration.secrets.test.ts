// Traces: BASED-SECRET-STORE, BASED-SNOWFLAKE-AUTH
import { createRequire } from "node:module";
import { describe, expect, test } from "bun:test";
import { MAX_SECRET_BYTES, setSecret, getSecret, deleteSecret } from "@based/core";

const TEST_ID = `spec-test-${process.pid}`;
const SERVICE = process.env.BASED_KEYRING_SERVICE ?? "based-db-client";

// keyring is core's dependency, not specs'. Resolved the way core would, so the legacy-format test
// can write a credential the old way — the one thing the public API deliberately cannot do.
const { Entry } = createRequire(import.meta.resolve("@based/core"))("@napi-rs/keyring") as {
  Entry: new (service: string, account: string) => { setPassword(v: string): void };
};

/** A 2048-bit PKCS#8 PEM, the shape key-pair auth has to store. Length is what matters here, not
 *  the bytes — 1704 chars is what `openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt` produces. */
const PEM_SIZED = "-".repeat(1704);

describe("BASED-SECRET-STORE: Windows Credential Manager round-trip", () => {
  test("set → get → delete → get null", () => {
    try {
      setSecret(TEST_ID, "s3cret-value");
      expect(getSecret(TEST_ID)).toBe("s3cret-value");
      deleteSecret(TEST_ID);
      expect(getSecret(TEST_ID)).toBeNull();
    } finally {
      deleteSecret(TEST_ID);
    }
  });

  test("get of never-stored id is null, delete is a no-op", () => {
    expect(getSecret("spec-test-never-stored")).toBeNull();
    deleteSecret("spec-test-never-stored");
  });

  // Traces: BASED-SNOWFLAKE-AUTH — this is the case that made key-pair auth unusable on Windows.
  // Credential Manager caps a blob at 2560 bytes and the old `setPassword` path spent two bytes per
  // character encoding to UTF-16, so a 1704-char PEM overflowed at ~1280 and threw.
  test("a 2048-bit PEM-sized secret round-trips", () => {
    const id = `${TEST_ID}-pem`;
    try {
      setSecret(id, PEM_SIZED);
      expect(getSecret(id)).toBe(PEM_SIZED);
    } finally {
      deleteSecret(id);
    }
  });

  test("multi-byte characters survive, and are charged by byte not by character", () => {
    const id = `${TEST_ID}-utf8`;
    try {
      setSecret(id, "pässwörd–✓🔑");
      expect(getSecret(id)).toBe("pässwörd–✓🔑");
      // The cap is on bytes: an emoji costs 4, so this must not be measured in characters.
      expect(() => setSecret(id, "🔑".repeat(MAX_SECRET_BYTES / 4 + 1))).toThrow(/credential store/);
    } finally {
      deleteSecret(id);
    }
  });

  test("an oversized secret is refused with an actionable message, not a driver error", () => {
    const id = `${TEST_ID}-huge`;
    try {
      expect(() => setSecret(id, "x".repeat(MAX_SECRET_BYTES + 1))).toThrow(
        /holds at most 2557|credential store/,
      );
      expect(getSecret(id)).toBeNull();
    } finally {
      deleteSecret(id);
    }
  });

  // Secrets written before the byte-oriented format must keep working — they are UTF-16LE blobs
  // with no marker, and there is no bulk rewrite, so the read path has to recognise both.
  test("a secret written by the legacy setPassword path still reads back", () => {
    const id = `${TEST_ID}-legacy`;
    try {
      new Entry(SERVICE, id).setPassword("legacy-ünïcode-value");
      expect(getSecret(id)).toBe("legacy-ünïcode-value");
      // …and is upgraded in place on its next write.
      setSecret(id, "rewritten-value");
      expect(getSecret(id)).toBe("rewritten-value");
    } finally {
      deleteSecret(id);
    }
  });
});
