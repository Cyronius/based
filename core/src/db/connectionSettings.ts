// Traces: BASED-CONN-SETTINGS-BAG
// Engine-specific connection fields live in one `settings` bag rather than as top-level optionals.
// With eight engines the flat shape reaches ~40 optional fields, every one of them visible to every
// other engine's code and to the wire type; the bag keeps ConnectionConfig's surface to what is
// genuinely cross-engine (identity, engine, auth, timestamps, the browse scope) and lets an engine's
// FieldSpec list define the rest.
//
// Migration is lazy and read-time: a row written before the bag existed is lifted on load, and
// rewritten in the new shape on its next save. Nothing is rewritten in bulk, so there is no
// half-migrated table to recover from and a downgrade still finds its own fields intact.
import type { ConnectionConfig } from "./types";

/** Fields that were top-level before the bag. Read-migrated into `settings`; never written again. */
export const LEGACY_SETTING_KEYS = [
  "server",
  "uri",
  "region",
  "username",
  "tenantId",
  "clientId",
  "encrypt",
  "trustServerCertificate",
  "account",
  "warehouse",
  "role",
  "schema",
] as const;

type LegacyRow = Partial<Record<(typeof LEGACY_SETTING_KEYS)[number], unknown>>;

/** Lift a stored row into the current shape. Values already in `settings` win over legacy
 *  top-level ones, so a row saved after the migration is never clobbered by a stale sibling. */
export function migrateConnection(raw: ConnectionConfig & LegacyRow): ConnectionConfig {
  const settings: Record<string, unknown> = {};
  for (const key of LEGACY_SETTING_KEYS) {
    if (raw[key] !== undefined) settings[key] = raw[key];
  }
  const merged = { ...settings, ...(raw.settings ?? {}) };
  const cleaned = { ...raw } as ConnectionConfig & LegacyRow;
  for (const key of LEGACY_SETTING_KEYS) delete cleaned[key];
  return { ...(cleaned as ConnectionConfig), settings: merged };
}

/** Read a setting, preferring the bag and falling back to a legacy top-level field of the same
 *  name. The fallback is the point: it makes `migrateConnection` a normalization rather than a
 *  correctness requirement, so a config that never went through the store — a hand-written one, a
 *  test fixture, a row read by some other path — still resolves. */
function raw(cfg: ConnectionConfig, key: string): unknown {
  const fromBag = cfg.settings?.[key];
  if (fromBag !== undefined) return fromBag;
  return (cfg as unknown as Record<string, unknown>)[key];
}

/** A string setting, or undefined when unset/blank. Blank collapses to undefined because an empty
 *  text input and an absent one mean the same thing to every engine here. */
export function settingStr(cfg: ConnectionConfig, key: string): string | undefined {
  const value = raw(cfg, key);
  if (typeof value !== "string") return undefined;
  return value.trim() ? value : undefined;
}

/** A boolean setting. `fallback` is what an engine's FieldSpec declares as its default. */
export function settingBool(cfg: ConnectionConfig, key: string, fallback = false): boolean {
  const value = raw(cfg, key);
  return typeof value === "boolean" ? value : fallback;
}
