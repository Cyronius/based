// Traces: BASED-LAZY-ENGINES, BASED-LANCE-ENGINE
// Engine adapters (and their native stacks — tedious, @lancedb napi, DuckDB) must not evaluate when
// @based/core is imported; they load on demand inside createAdapter. The import-graph assertions run
// in a child bun process because this test process itself loads adapters via sibling test files.
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { createAdapter } from "@based/core";
import type { ConnectionConfig } from "@based/core";

// A separate script file (not `bun -e`): multiline -e scripts break Windows argv quoting.
const CHILD_SCRIPT_PATH = join(import.meta.dir, "helpers", "lazyEnginesChild.ts");

function cfgFor(engine?: "mssql" | "lancedb"): ConnectionConfig {
  return {
    id: "lazy-spec",
    name: "lazy-spec",
    server: "localhost",
    database: "db",
    authType: engine === "lancedb" ? "lancedb-local" : "sql-login",
    engine,
    uri: engine === "lancedb" ? "c:\\nonexistent" : undefined,
    encrypt: false,
    trustServerCertificate: false,
    createdAt: "",
    updatedAt: "",
  };
}

describe("lazy engine loading", () => {
  test("BASED-LAZY-ENGINES: importing @based/core evaluates no engine module", async () => {
    const proc = Bun.spawn(["bun", CHILD_SCRIPT_PATH], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, err).toBe(0);
    const report = JSON.parse(out.trim()) as { total: number; mssql: number; lance: number; duckdb: number };
    expect(report.total).toBeGreaterThan(0); // require.cache is observable at all
    expect(report.mssql).toBe(0);
    expect(report.lance).toBe(0);
    expect(report.duckdb).toBe(0);
  }, 30_000);

  test("BASED-LAZY-ENGINES: async createAdapter resolves the right class per engine", async () => {
    const { MssqlAdapter } = await import("@based/core/mssql");
    const { LanceDbAdapter } = await import("@based/core/lancedb");
    const noSecret = () => null;

    const mssql = await createAdapter(cfgFor("mssql"), noSecret);
    expect(mssql).toBeInstanceOf(MssqlAdapter);

    const lance = await createAdapter(cfgFor("lancedb"), noSecret);
    expect(lance).toBeInstanceOf(LanceDbAdapter);

    // BASED-LANCE-ENGINE back-compat: an engine-less legacy config is MSSQL.
    const legacy = await createAdapter(cfgFor(undefined), noSecret);
    expect(legacy).toBeInstanceOf(MssqlAdapter);
  });
});
