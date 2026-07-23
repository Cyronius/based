// Traces: BASED-AI-PROVIDER, BASED-AGENT-ENDPOINT, BASED-AGENT-MUTATION-GATE, BASED-AGENT-AUDIT,
//         BASED-AGENT-SCHEMA-CTX, BASED-AGENT-SAMPLE, BASED-AGENT-RUNQUERY, BASED-SKILL-LOAD,
//         BASED-AGENT-MULTISTEP
// Server-level auth/gate tests always run; tool + audit tests that need a live DB self-skip like
// the other integration suites.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  startServer,
  openDb,
  AiConfigStore,
  AuditStore,
  DEFAULT_AI_CONFIG,
  buildAgentTools,
  buildAgent,
  agentInstructions,
  GENERIC_CORE,
  MSSQL_PERSONA,
  LANCE_PERSONA,
  skills,
  MssqlAdapter,
  testConnection,
  setAiKey,
  getAiKey,
  deleteAiKey,
} from "@based/core";
import type { ConnectionConfig } from "@based/core";

const dir = mkdtempSync(join(tmpdir(), "based-spec-agent-"));
const TOKEN = "agent-token";
const server = startServer({ token: TOKEN, dbPath: join(dir, "app.db"), agentDbPath: join(dir, "agent.db") });
const base = server.url;

afterAll(async () => {
  await server.stop();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("BASED-AI-PROVIDER: config store + key secrets", () => {
  test("config persists secret-free and reopens", () => {
    const path = join(mkdtempSync(join(tmpdir(), "based-aicfg-")), "app.db");
    const store = new AiConfigStore(openDb(path));
    expect(store.get()).toEqual(DEFAULT_AI_CONFIG); // default when unset
    const saved = store.save({ providerId: "p1", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m", hasKey: true });
    expect(JSON.stringify(saved)).not.toContain("secret");
    const reopened = new AiConfigStore(openDb(path));
    expect(reopened.get().model).toBe("m");
    expect(reopened.get().baseUrl).toBe("http://x/v1");
  });

  test("AI key round-trips through Credential Manager", () => {
    const id = `spec-ai-${Date.now()}`;
    setAiKey(id, "sk-test-123");
    expect(getAiKey(id)).toBe("sk-test-123");
    deleteAiKey(id);
    expect(getAiKey(id)).toBeNull();
  });

  test("GET /api/ai/config returns the default", async () => {
    const cfg = (await (await api("/api/ai/config")).json()) as { kind: string; hasKey: boolean };
    expect(cfg.kind).toBe("openai-compatible");
    expect(cfg.hasKey).toBe(false);
  });
});

describe("BASED-AGENT-ENDPOINT: auth + session guard", () => {
  test("POST /api/agent/capi without token → 401", async () => {
    const r = await fetch(`${base}/api/agent/capi`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(r.status).toBe(401);
  });

  test("POST /api/agent/capi with token but no connection → 409", async () => {
    const r = await api("/api/agent/capi", { method: "POST", body: JSON.stringify({ threadId: "t", runId: "r", messages: [], tools: [], state: {}, context: [] }) });
    expect(r.status).toBe(409);
  });
});

describe("BASED-SKILL-LOAD: load_skill tool + prompt catalog", () => {
  // The load_skill tool touches no adapter, so this needs no live DB.
  const tools = buildAgentTools({
    getAdapter: () => {
      throw new Error("load_skill must not touch the adapter");
    },
    connectionId: () => "c",
    database: () => "d",
    audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-skill-")), "app.db"))),
  });

  test("load_skill({ name: 'diagrams' }) returns the diagrams body", async () => {
    const out = (await tools.load_skill.execute!({ name: "diagrams" }, {} as never)) as { name?: string; body?: string };
    expect(out.name).toBe("diagrams");
    expect(out.body).toBe(skills.get("diagrams")!.body);
  });

  test("an unknown name returns the list of valid names, not an error throw", async () => {
    const out = (await tools.load_skill.execute!({ name: "nope" }, {} as never)) as { validNames?: string[] };
    expect(Array.isArray(out.validNames)).toBe(true);
    expect(out.validNames).toContain("diagrams");
  });

  test("the built agent's instructions include the skill catalog + load_skill protocol", () => {
    const text = agentInstructions(GENERIC_CORE, "SQL Server persona fragment");
    for (const s of skills.catalog()) {
      expect(text).toContain(s.name);
      expect(text).toContain(s.description);
    }
    expect(text).toContain("load_skill");
  });
});

describe("BASED-AGENT-INSTRUCTIONS-COMPOSE: buildAgent core/persona overrides", () => {
  function noopToolDeps() {
    return {
      getAdapter: (): never => {
        throw new Error("must not touch the adapter");
      },
      connectionId: () => "c",
      database: () => "d",
      audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-compose-")), "app.db"))),
    };
  }

  test("no override reproduces today's hardcoded per-engine output", async () => {
    const mssqlAgent = buildAgent({ model: {} as never, memory: {} as never, engine: "mssql", toolDeps: noopToolDeps() });
    expect(await mssqlAgent.getInstructions()).toBe(agentInstructions(GENERIC_CORE, MSSQL_PERSONA));

    const lanceAgent = buildAgent({ model: {} as never, memory: {} as never, engine: "lancedb", toolDeps: noopToolDeps() });
    expect(await lanceAgent.getInstructions()).toBe(agentInstructions(GENERIC_CORE, LANCE_PERSONA, ["lancedb"]));
  });

  test("core/persona overrides replace the built-in defaults", async () => {
    const agent = buildAgent({
      model: {} as never,
      memory: {} as never,
      engine: "lancedb",
      toolDeps: noopToolDeps(),
      core: "CUSTOM CORE TEXT",
      persona: "CUSTOM LANCE PERSONA TEXT",
    });
    const text = await agent.getInstructions();
    expect(text).toContain("CUSTOM CORE TEXT");
    expect(text).toContain("CUSTOM LANCE PERSONA TEXT");
    expect(text).not.toContain(GENERIC_CORE);
    expect(text).not.toContain(LANCE_PERSONA);
  });
});

describe("BASED-AGENT-MULTISTEP: default step budget", () => {
  test("buildAgent sets defaultOptions.maxSteps to 30 (overrides Mastra's implicit 5)", async () => {
    const agent = buildAgent({
      model: {} as never,
      memory: {} as never,
      engine: "mssql",
      toolDeps: {
        getAdapter: (): never => {
          throw new Error("must not touch the adapter");
        },
        connectionId: () => "c",
        database: () => "d",
        audit: new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-multistep-")), "app.db"))),
      },
    });
    const opts = await agent.getDefaultOptions();
    expect(opts.maxSteps).toBe(30);
  });
});

describe("BASED-AGENT-MUTATION-GATE: approval flag required", () => {
  test("mutation without approved → 400 and does no work", async () => {
    const r = await api("/api/agent/mutation", { method: "POST", body: JSON.stringify({ sql: "UPDATE t SET a = 1" }) });
    expect(r.status).toBe(400);
    const audit = (await (await api("/api/agent/audit?connectionId=any")).json()) as unknown[];
    expect(audit.length).toBe(0);
  });
});

// --- live-DB tool + audit tests ---
const devCfg: ConnectionConfig = {
  id: "spec-agent-dev",
  name: "spec-agent-dev",
  server: process.env.BASED_TEST_SERVER ?? "zl5qolt7t8.database.windows.net",
  database: process.env.BASED_TEST_DB ?? "learnermobile_db_ci",
  authType: "azure-cli",
  encrypt: true,
  trustServerCertificate: false,
  createdAt: "",
  updatedAt: "",
};
const probe = await testConnection(devCfg, () => null);
const d = probe.ok ? describe : describe.skip;
if (!probe.ok) console.warn(`[integration.agent] dev DB unavailable, skipping tool/audit tests: ${probe.error}`);

d("agent tools over the live adapter", () => {
  test("get_schema, sample_rows, run_query, refusal, and read audit", async () => {
    const adapter = new MssqlAdapter(devCfg, () => null);
    await adapter.connect();
    const audit = new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-audit-")), "app.db")));
    const tools = buildAgentTools({
      getAdapter: () => adapter,
      connectionId: () => devCfg.id,
      database: () => devCfg.database,
      audit,
    });

    // BASED-AGENT-SCHEMA-CTX: object list, no rows
    const objs = (await tools.get_schema.execute!({}, {} as never)) as { objects: unknown[] };
    expect(Array.isArray(objs.objects)).toBe(true);
    expect(objs.objects.length).toBeGreaterThan(0);
    const first = objs.objects[0] as { schema: string; name: string; type: string };

    // columns for a real table
    const cols = (await tools.get_schema.execute!({ table: first.name, schema: first.schema }, {} as never)) as {
      columns: unknown[];
    };
    expect(Array.isArray(cols.columns)).toBe(true);

    // BASED-AGENT-RUNQUERY: read-only runs and is audited
    const q = (await tools.run_query.execute!({ sql: "SELECT 1 AS a, 2 AS b" }, {} as never)) as {
      resultSets: Array<{ columns: string[]; rowCount: number }>;
    };
    expect(q.resultSets[0]!.columns).toEqual(["a", "b"]);
    expect(q.resultSets[0]!.rowCount).toBe(1);

    // BASED-AGENT-RUNQUERY: mutation is refused without touching the DB
    const refused = (await tools.run_query.execute!({ sql: "UPDATE dbo.Nope SET a = 1" }, {} as never)) as { refused?: boolean };
    expect(refused.refused).toBe(true);

    // BASED-AGENT-SAMPLE: bad identifier rejected
    const bad = (await tools.sample_rows.execute!({ table: "x; DROP TABLE y" }, {} as never)) as { error?: string };
    expect(bad.error).toBeTruthy();

    // BASED-AGENT-AUDIT: the read is recorded (mutation refusal is not — it never ran)
    const rows = audit.list(devCfg.id);
    expect(rows.some((r) => r.kind === "read" && r.status === "ok")).toBe(true);
    expect(rows.some((r) => r.sql.startsWith("UPDATE"))).toBe(false);

    await adapter.disconnect();
  }, 120_000);

  test("BASED-AGENT-MUTATION-GATE + AUDIT: approved mutation runs via the endpoint and is audited", async () => {
    const { id: _i, createdAt: _c, updatedAt: _u, ...input } = devCfg;
    const created = (await (await api("/api/connections", { method: "POST", body: JSON.stringify(input) })).json()) as ConnectionConfig;
    const conn = await api("/api/session/connect", { method: "POST", body: JSON.stringify({ connectionId: created.id }) });
    expect(conn.status).toBe(200);

    // The endpoint is SQL-agnostic; the gate is the approval flag. Use a harmless statement so the
    // test does not depend on write permissions — it is still recorded as a "mutation" kind.
    const r = await api("/api/agent/mutation", { method: "POST", body: JSON.stringify({ sql: "SELECT 1 AS ok", approved: true }) });
    expect(r.status).toBe(200);
    const out = (await r.json()) as { status: string };
    expect(out.status).toBe("ok");

    const audit = (await (await api(`/api/agent/audit?connectionId=${created.id}`)).json()) as Array<{
      kind: string;
      approved: boolean;
    }>;
    expect(audit.some((a) => a.kind === "mutation" && a.approved === true)).toBe(true);

    await api("/api/session/disconnect", { method: "POST" });
  }, 120_000);
});
