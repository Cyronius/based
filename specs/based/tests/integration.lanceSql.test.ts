// Traces: BASED-LANCE-SQL
// SQL over local LanceDB via the embedded DuckDB bridge. Like the other Lance suites this seeds
// scratch datasets in temp dirs and always runs — but note the first-ever run on a machine needs
// network for `INSTALL lance` (DuckDB downloads the extension); after that it's cached under
// %USERPROFILE%\.duckdb. If the install fails, the dedicated boot-failure test still asserts the
// graceful error path and the rest of the suite reports the same descriptive error.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as lancedb from "@lancedb/lancedb";
import type { ConnectionConfig, QueryChunk, WireValue } from "@based/core";
import { LanceDbAdapter } from "@based/core/lancedb";

const DIM = 8;
const soloDir = mkdtempSync(join(tmpdir(), "based-lancesql-solo-"));
const baseDir = mkdtempSync(join(tmpdir(), "based-lancesql-base-"));
const noSecret = () => null;

function cfgFor(dir: string): ConnectionConfig {
  return {
    id: `spec-lancesql-${dir.slice(-6)}`,
    name: "spec-lancesql",
    server: "",
    database: "lancedb",
    engine: "lancedb",
    authType: "lancedb-local",
    uri: dir,
    encrypt: false,
    trustServerCertificate: false,
    createdAt: "",
    updatedAt: "",
  };
}

const docs = Array.from({ length: 40 }, (_, i) => ({
  id: i,
  text: `document ${i}`,
  vector: Array.from({ length: DIM }, (_, j) => Math.sin(i * 0.7 + j * 0.13)),
}));

beforeAll(async () => {
  const solo = await lancedb.connect(soloDir);
  await solo.createTable("docs", docs, { mode: "overwrite" });

  // Base folder: two nested LanceDB databases → two attached namespaces.
  mkdirSync(join(baseDir, "alpha"), { recursive: true });
  mkdirSync(join(baseDir, "beta"), { recursive: true });
  const alpha = await lancedb.connect(join(baseDir, "alpha"));
  await alpha.createTable(
    "items",
    Array.from({ length: 10 }, (_, i) => ({ id: i, label: `item-${i}` })),
    { mode: "overwrite" },
  );
  const beta = await lancedb.connect(join(baseDir, "beta"));
  await beta.createTable(
    "owners",
    Array.from({ length: 10 }, (_, i) => ({ id: i, owner: `owner-${i % 3}` })),
    { mode: "overwrite" },
  );
});

afterAll(() => {
  // temp dirs are left for the OS to reap; rm on Windows can race the still-open native handle.
});

async function runSql(
  adapter: LanceDbAdapter,
  sql: string,
  opts?: { rowCap?: number; capturePlan?: boolean; captureStats?: boolean },
): Promise<{ chunks: QueryChunk[]; status: string }> {
  const chunks: QueryChunk[] = [];
  const exec = adapter.execute(sql, (c) => chunks.push(c), opts);
  const { status } = await exec.completion;
  return { chunks, status };
}

function rowsOf(chunks: QueryChunk[]): WireValue[][] {
  return chunks.filter((c) => c.type === "rows").flatMap((c) => (c as { rows: WireValue[][] }).rows);
}

describe("Lance SQL (embedded DuckDB)", () => {
  test("BASED-LANCE-SQL: local capabilities.sql is true; cloud is false", () => {
    const local = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    expect(local.capabilities.sql).toBe(true);
    const cloud = new LanceDbAdapter(
      { ...cfgFor(soloDir), authType: "lancedb-cloud", uri: "db://nope" },
      noSecret,
    );
    expect(cloud.capabilities.sql).toBe(false);
  });

  test("BASED-LANCE-SQL: SELECT streams resultset/rows/resultsetEnd/done with correct rows", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      const { chunks, status } = await runSql(adapter, "SELECT id, text FROM docs ORDER BY id LIMIT 3");
      expect(status).toBe("ok");
      expect(chunks.map((c) => c.type)).toEqual(["resultset", "rows", "resultsetEnd", "done"]);
      const rs = chunks[0] as Extract<QueryChunk, { type: "resultset" }>;
      expect(rs.columns.map((c) => c.name)).toEqual(["id", "text"]);
      expect(rowsOf(chunks)).toEqual([
        [0, "document 0"],
        [1, "document 1"],
        [2, "document 2"],
      ]);
      const end = chunks.find((c) => c.type === "resultsetEnd") as Extract<QueryChunk, { type: "resultsetEnd" }>;
      expect(end.rowCount).toBe(3);
      expect(end.truncated).toBe(false);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL: vector columns serialize as {$:'vec', dim, preview}", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      const { chunks, status } = await runSql(adapter, "SELECT vector FROM docs LIMIT 1");
      expect(status).toBe("ok");
      const cell = rowsOf(chunks)[0]![0] as { $: string; dim: number; preview: number[] };
      expect(cell.$).toBe("vec");
      expect(cell.dim).toBe(DIM);
      expect(cell.preview.length).toBeGreaterThan(0);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL: aggregates and multi-statement scripts work", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      const { chunks, status } = await runSql(adapter, "SELECT count(*) AS n FROM docs; SELECT max(id) AS m FROM docs");
      expect(status).toBe("ok");
      const resultsets = chunks.filter((c) => c.type === "resultset");
      expect(resultsets.length).toBe(2);
      const allRows = rowsOf(chunks);
      expect(allRows[0]![0]).toBe(40);
      expect(allRows[1]![0]).toBe(39);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL: base-folder mode attaches each subfolder as a namespace; cross-namespace JOIN", async () => {
    const adapter = new LanceDbAdapter(cfgFor(baseDir), noSecret);
    await adapter.connect();
    try {
      const { chunks, status } = await runSql(
        adapter,
        `SELECT i.label, o.owner FROM alpha.main.items i JOIN beta.main.owners o ON i.id = o.id ORDER BY i.id LIMIT 2`,
      );
      expect(status).toBe("ok");
      expect(rowsOf(chunks)).toEqual([
        ["item-0", "owner-0"],
        ["item-1", "owner-1"],
      ]);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL: rowCap truncates and stops scanning", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      const { chunks, status } = await runSql(adapter, "SELECT id FROM docs", { rowCap: 5 });
      expect(status).toBe("ok");
      const end = chunks.find((c) => c.type === "resultsetEnd") as Extract<QueryChunk, { type: "resultsetEnd" }>;
      expect(end.truncated).toBe(true);
      expect(rowsOf(chunks).length).toBe(5);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL: cancel() aborts a long-running query with status cancelled", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      // Warm the bridge so cancel targets the query, not the boot.
      await runSql(adapter, "SELECT 1");
      const chunks: QueryChunk[] = [];
      const exec = adapter.execute(
        "SELECT count(*) FROM range(1000000) a, range(100000) b",
        (c) => chunks.push(c),
      );
      setTimeout(() => exec.cancel(), 300);
      const { status } = await exec.completion;
      expect(status).toBe("cancelled");
      expect(chunks.some((c) => c.type === "cancelled")).toBe(true);
      const done = chunks.at(-1) as Extract<QueryChunk, { type: "done" }>;
      expect(done.status).toBe("cancelled");
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL: a bad query emits an error chunk and done(status error)", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      const { chunks, status } = await runSql(adapter, "SELECT * FROM no_such_table");
      expect(status).toBe("error");
      const err = chunks.find((c) => c.type === "error") as Extract<QueryChunk, { type: "error" }>;
      expect(err.message).toMatch(/no_such_table/);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL: bridge boot failure emits a descriptive error and later runs retry the boot", async () => {
    const { LanceSqlBridge, LanceSqlSetupError } = await import("@based/core/lancedb-sql");
    // A folder name containing a double quote cannot be attached — a deterministic boot failure
    // (the INSTALL-offline variant carries the same LanceSqlSetupError copy but needs a blocked
    // network to reproduce; that path is exercised manually).
    const bridge = new LanceSqlBridge({ dir: soloDir, folders: ['bad"name'] }, 100);
    const chunks: QueryChunk[] = [];
    const { status } = await bridge.execute("SELECT 1", (c: QueryChunk) => chunks.push(c)).completion;
    expect(status).toBe("error");
    const err = chunks.find((c) => c.type === "error") as Extract<QueryChunk, { type: "error" }>;
    expect(err.message).toMatch(/double quote/);
    // A failed boot is not cached: the next run attempts it again (and fails the same way, cleanly).
    const again: QueryChunk[] = [];
    const second = await bridge.execute("SELECT 1", (c: QueryChunk) => again.push(c)).completion;
    expect(second.status).toBe("error");
    expect(again.some((c) => c.type === "error")).toBe(true);
    await bridge.close();
    // And the setup error type is exported for callers that need to distinguish boot failures.
    expect(new LanceSqlSetupError("x")).toBeInstanceOf(Error);
  }, 120_000);

  test("BASED-LANCE-SQL: querying a table in an unreadable attached dir errors gracefully", async () => {
    const { LanceSqlBridge } = await import("@based/core/lancedb-sql");
    // ATTACH of a nonexistent dir is lazy (no boot error); the failure surfaces at query time.
    const bridge = new LanceSqlBridge({ dir: join(soloDir, "does-not-exist-at-all"), folders: null }, 100);
    const chunks: QueryChunk[] = [];
    const { status } = await bridge.execute("SELECT * FROM docs", (c: QueryChunk) => chunks.push(c)).completion;
    expect(status).toBe("error");
    const err = chunks.find((c) => c.type === "error") as Extract<QueryChunk, { type: "error" }>;
    expect(err.message.length).toBeGreaterThan(10);
    await bridge.close();
  }, 120_000);

  test("BASED-LANCE-SQL-PLAN: capturePlan emits one duckdb-json plan chunk; results unaffected", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      const { chunks, status } = await runSql(
        adapter,
        "SELECT id, count(*) AS n FROM docs WHERE id > 5 GROUP BY id ORDER BY id",
        { capturePlan: true },
      );
      expect(status).toBe("ok");
      const plans = chunks.filter((c) => c.type === "plan") as Array<Extract<QueryChunk, { type: "plan" }>>;
      expect(plans.length).toBe(1);
      const plan = plans[0]!;
      expect(plan.format).toBe("duckdb-json");
      // The wire payload parses to a non-empty operator tree that names the scanned table somewhere.
      const tree = JSON.parse((plan as { json: string }).json) as unknown[];
      expect(tree.length).toBeGreaterThan(0);
      expect(JSON.stringify(tree)).toMatch(/docs/);
      // Results still stream from the same run — exactly one resultset, no capture side effects on it.
      expect(chunks.filter((c) => c.type === "resultset").length).toBe(1);
      expect(rowsOf(chunks).length).toBeGreaterThan(0);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL-PLAN: a 2-statement script emits one plan chunk per statement", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      // Both statements execute a real pipeline (scan/aggregate/sort) so each flushes a profile;
      // metadata-only shortcuts like `count(*)`/`max(id)` would emit no plan.
      const { chunks, status } = await runSql(
        adapter,
        "SELECT id, count(*) AS n FROM docs WHERE id > 1 GROUP BY id; SELECT id * 2 AS d FROM docs ORDER BY id",
        { capturePlan: true },
      );
      expect(status).toBe("ok");
      expect(chunks.filter((c) => c.type === "plan").length).toBe(2);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL-PLAN: capturePlan off emits no plan chunks", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      const { chunks } = await runSql(adapter, "SELECT id FROM docs WHERE id > 5 GROUP BY id");
      expect(chunks.filter((c) => c.type === "plan").length).toBe(0);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL-STATS: captureStats emits a client-statistics message", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      // A metadata-only count (e.g. `count(*)`) executes no pipeline and yields no profile; use a
      // real aggregation so DuckDB profiles an actual scan.
      const { chunks, status } = await runSql(adapter, "SELECT id, count(*) AS n FROM docs GROUP BY id", { captureStats: true });
      expect(status).toBe("ok");
      const msgs = chunks.filter((c) => c.type === "message") as Array<Extract<QueryChunk, { type: "message" }>>;
      const stats = msgs.find((m) => /Client statistics/i.test(m.text));
      expect(stats).toBeDefined();
      expect(stats!.text).toMatch(/latency/i);
      expect(stats!.text).toMatch(/rows returned/i);
      expect(stats!.text).toMatch(/rows scanned/i);
      // No plan chunk when only stats were requested.
      expect(chunks.filter((c) => c.type === "plan").length).toBe(0);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL-STATS: captureStats off emits no client-statistics message", async () => {
    const adapter = new LanceDbAdapter(cfgFor(soloDir), noSecret);
    await adapter.connect();
    try {
      const { chunks } = await runSql(adapter, "SELECT count(*) FROM docs");
      const msgs = chunks.filter((c) => c.type === "message") as Array<Extract<QueryChunk, { type: "message" }>>;
      expect(msgs.some((m) => /Client statistics/i.test(m.text))).toBe(false);
    } finally {
      await adapter.disconnect();
    }
  }, 120_000);

  test("BASED-LANCE-SQL: cloud config execute() errors gracefully without a bridge", async () => {
    const cloud = new LanceDbAdapter({ ...cfgFor(soloDir), authType: "lancedb-cloud", uri: "db://nope" }, noSecret);
    const chunks: QueryChunk[] = [];
    const { status } = await cloud.execute("SELECT 1", (c) => chunks.push(c)).completion;
    expect(status).toBe("error");
    expect((chunks[0] as Extract<QueryChunk, { type: "error" }>).message).toMatch(/Cloud/i);
  });
});
