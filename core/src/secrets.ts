// Traces: BASED-SECRET-STORE
// The OS keychain via @napi-rs/keyring — Windows Credential Manager, macOS login Keychain, the
// Secret Service on Linux — one API for all three (napi prebuild; Bun napi loading validated in
// spike 5). The only platform branch is the Linux availability guard below.
import { Entry } from "@napi-rs/keyring";
import { existsSync } from "node:fs";

const SERVICE = process.env.BASED_KEYRING_SERVICE ?? "based-db-client";

/** Linux only: is there a keyring to talk to at all? The Secret Service lives on the session
 *  D-Bus, and with no session bus (WSL2, headless CI, a bare TTY login) @napi-rs/keyring does not
 *  throw — it segfaults the Bun process (observed Bun 1.3.14 on WSL2 Ubuntu 24.04). Availability
 *  therefore has to be decided *before* the native call; no try/catch can contain a SIGSEGV.
 *  Returns null when the keyring is reachable, else a reason naming what is missing. Pure
 *  (platform/env/fs injected) so every branch is unit-testable from any host. */
export function keyringUnavailableReason(
  platform: string = process.platform,
  env: Record<string, string | undefined> = process.env,
  socketExists: (path: string) => boolean = existsSync,
): string | null {
  // Kill-switch on every platform: a bus can exist with no Secret Service behind it (WSL2 with
  // systemd), and the bus check below cannot see that — probing the service IS the crashing call.
  if (env.BASED_KEYRING === "off") return "the keyring is disabled (BASED_KEYRING=off)";
  if (platform !== "linux") return null; // Credential Manager / login Keychain are always present
  if (env.DBUS_SESSION_BUS_ADDRESS) return null;
  if (env.XDG_RUNTIME_DIR && socketExists(`${env.XDG_RUNTIME_DIR}/bus`)) return null;
  return (
    "the keyring service is unavailable — no session D-Bus (DBUS_SESSION_BUS_ADDRESS is unset and " +
    "there is no $XDG_RUNTIME_DIR/bus socket), so the Secret Service cannot be reached"
  );
}

// --- plaintext fallback (see plans/plaintext-secret-fallback.md) ---
// When the keyring is unavailable, secrets go to the `secrets_fallback` table in app.db —
// unencrypted, and loudly: one warning per write here, and the UI warns before the user types a
// key (GET /api/secret-store). Reads fall through to the fallback even when the keyring works, so
// a key saved keyring-less still resolves after the machine gains a keyring; the next write with a
// working keyring purges the fallback row (upgrade-in-place, like the v2-marker migration).
// Module-level registration, one broker per process — the same pattern as dialogs.ts.
import type { SecretsFallbackStore } from "./storage/secretsFallback";

let fallback: SecretsFallbackStore | null = null;

/** Server startup hands the app.db-backed store in; tests may pass null to detach. */
export function registerSecretsFallback(store: SecretsFallbackStore | null): void {
  fallback = store;
}

/** Detach `store` only if it is still the registered one — a stopping server must not yank a
 *  registration a newer server (same-process tests) has already replaced. */
export function unregisterSecretsFallback(store: SecretsFallbackStore): void {
  if (fallback === store) fallback = null;
}

/** What the secret-store currently is, for the UI's pre-save warning (GET /api/secret-store). */
export function secretStoreStatus(): { backend: "keyring" | "plaintext"; reason?: string } {
  const reason = keyringUnavailableReason();
  return reason ? { backend: "plaintext", reason } : { backend: "keyring" };
}

let warnedKeyringUnavailable = false;

/** Reads and deletes degrade to the fallback when the keyring is unreachable; writes land there
 *  too, each with its own warning — every plaintext write is a distinct event worth a line. */
function keyringUnavailable(): string | null {
  const reason = keyringUnavailableReason();
  if (reason && !warnedKeyringUnavailable) {
    warnedKeyringUnavailable = true;
    console.warn(`based: ${reason}; secrets are stored UNENCRYPTED in app.db this session`);
  }
  return reason;
}

// Traces: BASED-SECRET-STORE — every secret goes through these three, byte-oriented rather than
// string-oriented. Both the encoding and the cap are Windows constraints, applied on every platform
// so one entry format reads back anywhere and a secret that saves on macOS also saves on Windows.
// Windows Credential Manager caps a credential blob at 2560 bytes; `setPassword`
// encodes the string as UTF-16 first, which halves the usable room to ~1280 characters. That is
// under a 2048-bit PKCS8 PEM (1704 chars), so key-pair auth could not be saved at all on Windows —
// it failed with "Value of 'password encoded as UTF-16' is longer than the platform limit of 2560
// chars". `setSecret` stores the bytes as given, so UTF-8 gets the whole 2560.
//
// A blob written by the old `setPassword` path is still UTF-16LE, and `getSecret` hands it back
// verbatim, so reads must be able to tell the two apart. Hence the marker: it cannot collide,
// because a legacy blob interleaves NULs (UTF-16LE "v2:" is 76 00 32 00 3a 00, never 76 32 3a).
// Entries are upgraded in place the next time they are written; nothing is rewritten in bulk.
// That legacy path only ever ran on Windows, so a macOS install has no such blob to upgrade.
const V2_MARKER = new Uint8Array([0x76, 0x32, 0x3a]); // "v2:" in UTF-8

/** 2560 bytes minus the marker — the Windows ceiling, enforced on every platform. */
export const MAX_SECRET_BYTES = 2560 - V2_MARKER.length;

function writeSecret(account: string, secret: string): void {
  const body = new TextEncoder().encode(secret);
  // The cap is a portability rule (a secret saved anywhere must save on Windows), not a keyring
  // rule — so it applies to the plaintext fallback too, before the availability branch.
  if (body.length > MAX_SECRET_BYTES) {
    throw new Error(
      `Secret is ${body.length} bytes; the OS credential store holds at most ${MAX_SECRET_BYTES}. ` +
        "A 2048-bit private key fits; a 4096-bit one does not.",
    );
  }
  const reason = keyringUnavailable();
  if (reason) {
    if (!fallback) throw new Error(`Cannot store the secret: ${reason}, and no fallback store is registered.`);
    console.warn(`based: storing secret "${account}" UNENCRYPTED in app.db — ${reason}`);
    fallback.set(account, secret);
    return;
  }
  const blob = new Uint8Array(V2_MARKER.length + body.length);
  blob.set(V2_MARKER);
  blob.set(body, V2_MARKER.length);
  new Entry(SERVICE, account).setSecret(blob);
  // A working keyring supersedes any plaintext copy left by a keyring-less session.
  fallback?.delete(account);
}

function readSecret(account: string): string | null {
  if (keyringUnavailable()) return fallback?.get(account) ?? null;
  let bytes: Array<number> | null;
  try {
    bytes = new Entry(SERVICE, account).getSecret();
  } catch {
    bytes = null;
  }
  // Keyring miss falls through to the fallback: a key saved by a keyring-less session must still
  // resolve once the machine has a keyring (it is purged on the next write, not on read).
  if (!bytes || bytes.length === 0) return fallback?.get(account) ?? null;
  const blob = new Uint8Array(bytes);
  const isV2 = blob.length >= V2_MARKER.length && V2_MARKER.every((b, i) => blob[i] === b);
  return isV2
    ? new TextDecoder().decode(blob.subarray(V2_MARKER.length))
    : new TextDecoder("utf-16le").decode(blob);
}

function removeSecret(account: string): void {
  fallback?.delete(account);
  if (keyringUnavailable()) return; // no keyring to also delete from
  try {
    new Entry(SERVICE, account).deletePassword();
  } catch {
    // nothing stored — fine
  }
}

export function setSecret(connectionId: string, secret: string): void {
  writeSecret(connectionId, secret);
}

export function getSecret(connectionId: string): string | null {
  return readSecret(connectionId);
}

export function deleteSecret(connectionId: string): void {
  removeSecret(connectionId);
}

// Traces: BASED-SNOWFLAKE-AUTH — key-pair auth needs two values (a PEM and its optional passphrase)
// but the connection channel is one string per connection id. Rather than a second keyring
// namespace to keep in sync with create/delete, key-pair connections store a JSON blob in the
// existing slot. Every other auth type keeps storing a plain string, so nothing else changes.
export interface KeyPairSecret {
  key: string;
  pass?: string;
}

export function encodeKeyPairSecret(secret: KeyPairSecret): string {
  return JSON.stringify(secret);
}

/** Parse a key-pair blob. A plain-string secret (hand-entered PEM, or one written before this
 *  format existed) is treated as the key with no passphrase rather than failing the connection. */
export function decodeKeyPairSecret(raw: string): KeyPairSecret {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("{")) return { key: raw };
  try {
    const parsed = JSON.parse(trimmed) as Partial<KeyPairSecret>;
    if (typeof parsed.key !== "string") return { key: raw };
    return { key: parsed.key, pass: typeof parsed.pass === "string" && parsed.pass ? parsed.pass : undefined };
  } catch {
    return { key: raw };
  }
}

// Traces: BASED-AI-PROVIDER — the AI provider API key lives in the OS keychain, keyed by
// provider id, never in the local store or the webview.
const AI_ACCOUNT_PREFIX = "ai:";

export function setAiKey(providerId: string, key: string): void {
  writeSecret(AI_ACCOUNT_PREFIX + providerId, key);
}

export function getAiKey(providerId: string): string | null {
  return readSecret(AI_ACCOUNT_PREFIX + providerId);
}

export function deleteAiKey(providerId: string): void {
  removeSecret(AI_ACCOUNT_PREFIX + providerId);
}

// Traces: BASED-LANCE-EMBED-PROFILES — embedding profile API keys, keyed by profile id.
const EMBED_ACCOUNT_PREFIX = "embed:";

export function setEmbeddingKey(profileId: string, key: string): void {
  writeSecret(EMBED_ACCOUNT_PREFIX + profileId, key);
}

export function getEmbeddingKey(profileId: string): string | null {
  return readSecret(EMBED_ACCOUNT_PREFIX + profileId);
}

export function deleteEmbeddingKey(profileId: string): void {
  removeSecret(EMBED_ACCOUNT_PREFIX + profileId);
}

// Traces: BASED-LANCE-RERANK-PROFILES — reranker profile API keys, keyed by profile id.
const RERANK_ACCOUNT_PREFIX = "rerank:";

export function setRerankerKey(profileId: string, key: string): void {
  writeSecret(RERANK_ACCOUNT_PREFIX + profileId, key);
}

export function getRerankerKey(profileId: string): string | null {
  return readSecret(RERANK_ACCOUNT_PREFIX + profileId);
}

export function deleteRerankerKey(profileId: string): void {
  removeSecret(RERANK_ACCOUNT_PREFIX + profileId);
}
