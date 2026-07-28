// Traces: BASED-CONN-SETTINGS-BAG
//
// Engine-specific connection fields moved from ~12 top-level optionals into one `settings` bag, so
// that adding the fourth through eighth engines doesn't grow ConnectionConfig (or the wire type) by
// a field per engine. The migration is deliberately lazy: rows are lifted on READ and rewritten on
// their next save, so there is never a half-migrated table, and `settingStr`/`settingBool` fall back
// to a legacy top-level field so a config that never passed through the store still resolves.
import { describe, expect, test } from "bun:test";
import { migrateConnection, settingBool, settingStr } from "@based/core";
import type { ConnectionConfig } from "@based/core";

/** A row as it was written before the bag existed. */
function legacyRow(): ConnectionConfig {
  return {
    id: "c1",
    name: "dev",
    database: "mydb",
    authType: "sql-login",
    engine: "mssql",
    server: "example.database.windows.net",
    username: "sa",
    encrypt: true,
    trustServerCertificate: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as unknown as ConnectionConfig;
}

describe("migrateConnection: lifting a legacy row", () => {
  test("engine-specific fields move into settings and leave the top level", () => {
    const migrated = migrateConnection(legacyRow());
    expect(migrated.settings).toEqual({
      server: "example.database.windows.net",
      username: "sa",
      encrypt: true,
      trustServerCertificate: false,
    });
    expect((migrated as unknown as Record<string, unknown>).server).toBeUndefined();
    expect((migrated as unknown as Record<string, unknown>).encrypt).toBeUndefined();
  });

  test("cross-engine fields stay top-level", () => {
    const migrated = migrateConnection(legacyRow());
    expect(migrated.id).toBe("c1");
    expect(migrated.name).toBe("dev");
    expect(migrated.database).toBe("mydb");
    expect(migrated.authType).toBe("sql-login");
    expect(migrated.engine).toBe("mssql");
    expect(migrated.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  test("it is idempotent — migrating an already-migrated row changes nothing", () => {
    const once = migrateConnection(legacyRow());
    expect(migrateConnection(once)).toEqual(once);
  });

  test("an explicit settings value wins over a stale top-level sibling", () => {
    // Both present means the row was written after the migration and read by something that also
    // carried the old field. The bag is the newer truth.
    const row = { ...legacyRow(), settings: { server: "new.host" } } as unknown as ConnectionConfig;
    expect(migrateConnection(row).settings.server).toBe("new.host");
  });

  test("a row with no engine-specific fields at all migrates to an empty bag, not undefined", () => {
    const bare = { id: "c", name: "n", database: "", authType: "lancedb-local", createdAt: "", updatedAt: "" } as unknown as ConnectionConfig;
    expect(migrateConnection(bare).settings).toEqual({});
  });
});

describe("settingStr / settingBool", () => {
  const migrated = migrateConnection(legacyRow());

  test("they read the bag", () => {
    expect(settingStr(migrated, "server")).toBe("example.database.windows.net");
    expect(settingBool(migrated, "encrypt")).toBe(true);
    expect(settingBool(migrated, "trustServerCertificate")).toBe(false);
  });

  test("they fall back to a legacy top-level field on an unmigrated config", () => {
    // This fallback is why migrateConnection is a normalization rather than a correctness
    // requirement: a hand-written config, or one read by some path that skips the store, still works.
    const raw = legacyRow();
    expect(settingStr(raw, "server")).toBe("example.database.windows.net");
    expect(settingBool(raw, "encrypt")).toBe(true);
  });

  test("blank strings collapse to undefined — an empty input means 'unset'", () => {
    const blank = migrateConnection({ ...legacyRow(), server: "   " } as unknown as ConnectionConfig);
    expect(settingStr(blank, "server")).toBeUndefined();
  });

  test("a missing key is undefined, and settingBool takes the engine's declared default", () => {
    expect(settingStr(migrated, "warehouse")).toBeUndefined();
    expect(settingBool(migrated, "nothingHere")).toBe(false);
    expect(settingBool(migrated, "nothingHere", true)).toBe(true);
  });

  test("a non-string value is not coerced into one", () => {
    // Reading `encrypt` as a string must not yield "true": the caller asked for the wrong type and
    // silently getting a truthy string would defeat every check downstream.
    expect(settingStr(migrated, "encrypt")).toBeUndefined();
  });
});
