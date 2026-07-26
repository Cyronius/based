// Shared dev-DB wiring for the integration suites.
//
// The server and database come from BASED_TEST_SERVER / BASED_TEST_DB and there is deliberately
// no fallback: a real hostname must never be baked into the repo, and a silent default would make
// a green run ambiguous about which database it actually hit. Unset env → every live suite skips.
// See docs/development.md for the setup.
import { testConnection } from "@based/core";
import type { ConnectionConfig } from "@based/core";

const server = process.env.BASED_TEST_SERVER ?? "";
const database = process.env.BASED_TEST_DB ?? "";

/** Build a dev-DB connection. `id` doubles as the name so suites stay distinguishable in the store. */
export function devConnection(id: string): ConnectionConfig {
  return {
    id,
    name: id,
    server,
    database,
    authType: "azure-cli",
    encrypt: true,
    trustServerCertificate: false,
    createdAt: "",
    updatedAt: "",
  };
}

// One probe for the whole run — each suite connecting separately is pure latency, and this module
// is evaluated once per `bun test` process.
const probe =
  server && database
    ? await testConnection(devConnection("spec-probe"), () => null)
    : {
        ok: false as const,
        error: "BASED_TEST_SERVER / BASED_TEST_DB not set (see docs/development.md)",
      };

export const DEV_DB_AVAILABLE = probe.ok;

/** Log why the live suites are being skipped, once per suite, with the caller's label. */
export function warnDevDbSkip(label: string, what = "live-DB suite"): void {
  console.warn(`[${label}] dev DB unavailable, skipping ${what}: ${probe.error}`);
}
