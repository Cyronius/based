// Traces: BASED-SECRET-STORE
// Windows Credential Manager via @napi-rs/keyring (napi prebuild; Bun napi loading validated in spike 5).
import { Entry } from "@napi-rs/keyring";

const SERVICE = process.env.BASED_KEYRING_SERVICE ?? "based-db-client";

export function setSecret(connectionId: string, secret: string): void {
  new Entry(SERVICE, connectionId).setPassword(secret);
}

export function getSecret(connectionId: string): string | null {
  try {
    return new Entry(SERVICE, connectionId).getPassword();
  } catch {
    return null;
  }
}

export function deleteSecret(connectionId: string): void {
  try {
    new Entry(SERVICE, connectionId).deletePassword();
  } catch {
    // no secret stored — fine
  }
}

// Traces: BASED-AI-PROVIDER — the AI provider API key lives in Credential Manager, keyed by
// provider id, never in the local store or the webview.
const AI_ACCOUNT_PREFIX = "ai:";

export function setAiKey(providerId: string, key: string): void {
  new Entry(SERVICE, AI_ACCOUNT_PREFIX + providerId).setPassword(key);
}

export function getAiKey(providerId: string): string | null {
  try {
    return new Entry(SERVICE, AI_ACCOUNT_PREFIX + providerId).getPassword();
  } catch {
    return null;
  }
}

export function deleteAiKey(providerId: string): void {
  try {
    new Entry(SERVICE, AI_ACCOUNT_PREFIX + providerId).deletePassword();
  } catch {
    // no key stored — fine
  }
}

// Traces: BASED-LANCE-EMBED-PROFILES — embedding profile API keys, keyed by profile id.
const EMBED_ACCOUNT_PREFIX = "embed:";

export function setEmbeddingKey(profileId: string, key: string): void {
  new Entry(SERVICE, EMBED_ACCOUNT_PREFIX + profileId).setPassword(key);
}

export function getEmbeddingKey(profileId: string): string | null {
  try {
    return new Entry(SERVICE, EMBED_ACCOUNT_PREFIX + profileId).getPassword();
  } catch {
    return null;
  }
}

export function deleteEmbeddingKey(profileId: string): void {
  try {
    new Entry(SERVICE, EMBED_ACCOUNT_PREFIX + profileId).deletePassword();
  } catch {
    // no key stored — fine
  }
}

// Traces: BASED-LANCE-RERANK-PROFILES — reranker profile API keys, keyed by profile id.
const RERANK_ACCOUNT_PREFIX = "rerank:";

export function setRerankerKey(profileId: string, key: string): void {
  new Entry(SERVICE, RERANK_ACCOUNT_PREFIX + profileId).setPassword(key);
}

export function getRerankerKey(profileId: string): string | null {
  try {
    return new Entry(SERVICE, RERANK_ACCOUNT_PREFIX + profileId).getPassword();
  } catch {
    return null;
  }
}

export function deleteRerankerKey(profileId: string): void {
  try {
    new Entry(SERVICE, RERANK_ACCOUNT_PREFIX + profileId).deletePassword();
  } catch {
    // no key stored — fine
  }
}
