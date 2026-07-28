// Traces: BASED-AI-PROVIDER, BASED-AGENT-ENDPOINT, BASED-AGENT-MUTATION-GATE, BASED-AGENT-AUDIT,
//         BASED-AGENT-SCHEMA-CTX, BASED-AGENT-SAMPLE, BASED-AGENT-RUNQUERY, BASED-SKILL-LOAD,
//         BASED-AGENT-MULTISTEP
// Server-level auth/gate tests always run; tool + audit tests that need a live DB self-skip like
// the other integration suites.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import {
  startServer,
  openDb,
  AiConfigStore,
  AiProfileStore,
  AgentInstructionsStore,
  AuditStore,
  buildAgentTools,
  buildAgent,
  agentInstructions,
  GENERIC_CORE,
  MSSQL_PERSONA,
  LANCE_PERSONA,
  SNOWFLAKE_PERSONA,
  mssqlBriefing,
  lanceBriefing,
  defaultCapabilitiesFor,
  skills,
  setAiKey,
  getAiKey,
  deleteAiKey,
} from "@based/core";
import { MssqlAdapter } from "@based/core/mssql";
import type { ConnectionConfig } from "@based/core";
import { DEV_DB_AVAILABLE, devConnection, warnDevDbSkip } from "./_devDb";

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
    expect(store.get()).toBeNull(); // no built-in default when unset
    const saved = store.save({ providerId: "p1", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m", hasKey: true });
    expect(JSON.stringify(saved)).not.toContain("secret");
    const reopened = new AiConfigStore(openDb(path));
    expect(reopened.get()?.model).toBe("m");
    expect(reopened.get()?.baseUrl).toBe("http://x/v1");
  });

  test("AI key round-trips through Credential Manager", () => {
    const id = `spec-ai-${Date.now()}`;
    setAiKey(id, "sk-test-123");
    expect(getAiKey(id)).toBe("sk-test-123");
    deleteAiKey(id);
    expect(getAiKey(id)).toBeNull();
  });

});

describe("BASED-AI-PROVIDER-PROFILES: profile CRUD + migration", () => {
  test("GET /api/ai-profiles returns an empty list on a fresh install — no built-in default is seeded", async () => {
    const profiles = (await (await api("/api/ai-profiles")).json()) as Array<{ name: string }>;
    expect(profiles).toEqual([]);
  });

  test("a real legacy ai_config row migrates into a Default profile on first use", async () => {
    const dir = mkdtempSync(join(tmpdir(), "based-aimigrate-"));
    const dbPath = join(dir, "app.db");
    new AiConfigStore(openDb(dbPath)).save({
      providerId: "legacy",
      kind: "openai-compatible",
      baseUrl: "http://legacy-host/v1",
      model: "legacy-model",
      hasKey: false,
    });
    const migrateServer = startServer({ token: "migrate-token", dbPath, agentDbPath: join(dir, "agent.db") });
    try {
      const res = await fetch(`${migrateServer.url}/api/ai-profiles`, {
        headers: { authorization: "Bearer migrate-token" },
      });
      const profiles = (await res.json()) as Array<{ name: string; kind: string; baseUrl: string; model: string }>;
      expect(profiles.length).toBe(1);
      expect(profiles[0]).toMatchObject({ name: "Default", kind: "openai-compatible", baseUrl: "http://legacy-host/v1", model: "legacy-model" });
    } finally {
      await migrateServer.stop();
    }
  });

  test("invoking the agent with zero profiles configured returns a clear 400, not a raw error", async () => {
    const res = await api("/api/session/label-clusters?sid=default", {
      method: "POST",
      body: JSON.stringify({ clusters: [{ id: 0, samples: ["x"] }] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/no agent profile configured/i);
  });

  test("POST /api/ai-profiles creates a profile; DELETE removes it", async () => {
    const created = (await (
      await api("/api/ai-profiles", {
        method: "POST",
        body: JSON.stringify({ name: "Test profile", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" }),
      })
    ).json()) as { id: string; name: string };
    expect(created.name).toBe("Test profile");
    const del = await api(`/api/ai-profiles/${created.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const profiles = (await (await api("/api/ai-profiles")).json()) as Array<{ id: string }>;
    expect(profiles.some((p) => p.id === created.id)).toBe(false);
  });

  test("a profile created via the API with no instructionSetId links to the default instruction set", async () => {
    const created = (await (
      await api("/api/ai-profiles", {
        method: "POST",
        body: JSON.stringify({ name: "No-instructions profile", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" }),
      })
    ).json()) as { id: string; instructionSetId: string };
    expect(created.instructionSetId).toBe("default");
    await api(`/api/ai-profiles/${created.id}`, { method: "DELETE" });
  });

  test("a profile's instructionSetId persists and round-trips", async () => {
    const created = (await (
      await api("/api/ai-profiles", {
        method: "POST",
        body: JSON.stringify({ name: "Linked profile", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m", instructionSetId: "some-set-id" }),
      })
    ).json()) as { id: string; instructionSetId: string };
    expect(created.instructionSetId).toBe("some-set-id");
    const profiles = (await (await api("/api/ai-profiles")).json()) as Array<{ id: string; instructionSetId: string }>;
    expect(profiles.find((p) => p.id === created.id)?.instructionSetId).toBe("some-set-id");
    await api(`/api/ai-profiles/${created.id}`, { method: "DELETE" });
  });

  test("a profile with no instructionSetId defaults to 'default'", async () => {
    const store = new AiProfileStore(openDb(join(mkdtempSync(join(tmpdir(), "based-aiprof-")), "app.db")));
    const saved = store.save({ name: "Legacy", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" });
    expect(saved.instructionSetId).toBe("default");
  });

  // Traces: BASED-AI-PROFILE-PARAMS
  test("a profile's params JSON persists and round-trips through the API", async () => {
    const params = { temperature: 0.2, reasoning_effort: "low" };
    const created = (await (
      await api("/api/ai-profiles", {
        method: "POST",
        body: JSON.stringify({ name: "Params profile", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m", params }),
      })
    ).json()) as { id: string; params?: Record<string, unknown> };
    expect(created.params).toEqual(params);
    const profiles = (await (await api("/api/ai-profiles")).json()) as Array<{ id: string; params?: Record<string, unknown> }>;
    expect(profiles.find((p) => p.id === created.id)?.params).toEqual(params);
    // Re-saving without params clears them (the form always posts the full current value).
    const updated = (await (
      await api("/api/ai-profiles", {
        method: "POST",
        body: JSON.stringify({ id: created.id, name: "Params profile", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" }),
      })
    ).json()) as { params?: Record<string, unknown> };
    expect(updated.params).toBeUndefined();
    await api(`/api/ai-profiles/${created.id}`, { method: "DELETE" });
  });

  // Traces: BASED-AI-PROFILE-TIMEOUT
  test("a profile's timeoutSeconds persists, round-trips, and clears when re-saved without it", async () => {
    const created = (await (
      await api("/api/ai-profiles", {
        method: "POST",
        body: JSON.stringify({ name: "Timeout profile", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m", timeoutSeconds: 1800 }),
      })
    ).json()) as { id: string; timeoutSeconds?: number };
    expect(created.timeoutSeconds).toBe(1800);
    const profiles = (await (await api("/api/ai-profiles")).json()) as Array<{ id: string; timeoutSeconds?: number }>;
    expect(profiles.find((p) => p.id === created.id)?.timeoutSeconds).toBe(1800);
    const updated = (await (
      await api("/api/ai-profiles", {
        method: "POST",
        body: JSON.stringify({ id: created.id, name: "Timeout profile", kind: "openai-compatible", baseUrl: "http://x/v1", model: "m" }),
      })
    ).json()) as { timeoutSeconds?: number };
    expect(updated.timeoutSeconds).toBeUndefined();
    await api(`/api/ai-profiles/${created.id}`, { method: "DELETE" });
  });

  // Traces: BASED-AI-PROFILE-PARAMS — store-level persistence across reopen
  test("params survive a store reopen", () => {
    const dir = mkdtempSync(join(tmpdir(), "based-aiprof-params-"));
    const store = new AiProfileStore(openDb(join(dir, "app.db")));
    const saved = store.save({ name: "P", kind: "anthropic", baseUrl: "", model: "m", params: { topP: 0.9, thinking: { type: "enabled" } } });
    const reopened = new AiProfileStore(openDb(join(dir, "app.db")));
    expect(reopened.get(saved.id)?.params).toEqual({ topP: 0.9, thinking: { type: "enabled" } });
  });
});

describe("BASED-AGENT-INSTRUCTIONS: instructions resolve from the profile's linked set", () => {
  const store = new AgentInstructionsStore(openDb(join(mkdtempSync(join(tmpdir(), "based-instr-")), "app.db")));

  test("resolveById returns the linked set's core + engine-appropriate persona", () => {
    const { sets } = store.saveSet({
      name: "Analyst",
      core: "CORE-A",
      personas: { mssql: "SQL-A", lancedb: "LANCE-A" },
    });
    const custom = sets.find((s) => s.name === "Analyst")!;
    expect(store.resolveById(custom.id, "mssql")).toEqual({ core: "CORE-A", persona: "SQL-A" });
    expect(store.resolveById(custom.id, "lancedb")).toEqual({ core: "CORE-A", persona: "LANCE-A" });
  });

  // Traces: BASED-ENGINE-REGISTRY — this set predates snowflake and has no persona for it. It must
  // fall back to SNOWFLAKE_PERSONA, never to another engine's: the old shape was
  // `engine === "mssql" ? mssqlPersona : lancePersona`, which silently handed every engine added
  // after LanceDB the LanceDB persona.
  test("a set with no persona for an engine falls back to that engine's own, not another's", () => {
    const { sets } = store.saveSet({ name: "Partial", core: "CORE-P", personas: { mssql: "SQL-P" } });
    const custom = sets.find((s) => s.name === "Partial")!;
    expect(store.resolveById(custom.id, "snowflake")).toEqual({ core: "CORE-P", persona: SNOWFLAKE_PERSONA });
    expect(store.resolveById(custom.id, "lancedb")).toEqual({ core: "CORE-P", persona: LANCE_PERSONA });
  });

  test("resolveById falls back to the default set when the id no longer resolves", () => {
    expect(store.resolveById("deleted-set-id", "mssql")).toEqual(store.resolveById("default", "mssql"));
    // The default set resolves to persona: null — "no override", so the live connection's
    // generated, variant-correct persona is used (BASED-AGENT-SURFACE-VARIANT). Only a custom set
    // pins a fixed string, because a fixed string cannot be regenerated per variant.
    // Both halves are plain strings again: a persona carries no connection-specific claims, so it
    // needs no per-variant regeneration. The capability briefing that does is generated by
    // agentSurfaceFor and never lives in a set (BASED-AGENT-INSTRUCTIONS).
    expect(store.resolveById("default", "mssql")).toEqual({ core: GENERIC_CORE, persona: MSSQL_PERSONA });
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
    const mssqlCaps = defaultCapabilitiesFor("mssql");
    const mssqlAgent = buildAgent({ model: {} as never, memory: {} as never, capabilities: mssqlCaps, toolDeps: noopToolDeps() });
    expect(await mssqlAgent.getInstructions()).toBe(
      agentInstructions(GENERIC_CORE, MSSQL_PERSONA, undefined, mssqlBriefing(mssqlCaps)),
    );

    const lanceCaps = defaultCapabilitiesFor("lancedb");
    const lanceAgent = buildAgent({ model: {} as never, memory: {} as never, capabilities: lanceCaps, toolDeps: noopToolDeps() });
    expect(await lanceAgent.getInstructions()).toBe(
      agentInstructions(GENERIC_CORE, LANCE_PERSONA, ["lancedb"], lanceBriefing(lanceCaps)),
    );
  });

  test("core/persona overrides replace the built-in defaults", async () => {
    const agent = buildAgent({
      model: {} as never,
      memory: {} as never,
      capabilities: defaultCapabilitiesFor("lancedb"),
      toolDeps: noopToolDeps(),
      core: "CUSTOM CORE TEXT",
      persona: "CUSTOM LANCE PERSONA TEXT",
    });
    const text = await agent.getInstructions();
    expect(text).toContain("CUSTOM CORE TEXT");
    expect(text).toContain("CUSTOM LANCE PERSONA TEXT");
    expect(text).not.toContain(GENERIC_CORE);
    expect(text).not.toContain(LANCE_PERSONA);
    // …but the capability briefing is NOT overridable, so it survives a fully custom persona.
    expect(text).toContain(lanceBriefing(defaultCapabilitiesFor("lancedb")));
  });
});

describe("BASED-AGENT-MULTISTEP: default step budget", () => {
  test("buildAgent sets defaultOptions.maxSteps to 30 (overrides Mastra's implicit 5)", async () => {
    const agent = buildAgent({
      model: {} as never,
      memory: {} as never,
      capabilities: defaultCapabilitiesFor("mssql"),
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
const devCfg: ConnectionConfig = devConnection("spec-agent-dev");
const d = DEV_DB_AVAILABLE ? describe : describe.skip;
if (!DEV_DB_AVAILABLE) warnDevDbSkip("integration.agent", "tool/audit tests");

d("agent tools over the live adapter", () => {
  test("list_objects, describe_table, read_table, run_query, refusal, and read audit", async () => {
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
    const objs = (await tools.list_objects.execute!({}, {} as never)) as { objects: unknown[] };
    expect(Array.isArray(objs.objects)).toBe(true);
    expect(objs.objects.length).toBeGreaterThan(0);
    const first = objs.objects[0] as { schema: string; name: string; type: string };

    // columns for a real table
    const cols = (await tools.describe_table.execute!({ table: first.name, schema: first.schema }, {} as never)) as {
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

    // BASED-AGENT-READ-ROWS: a bogus table name fails as an adapter error, not a silent read
    const bad = (await tools.read_table.execute!({ table: "x; DROP TABLE y" }, {} as never)) as { error?: string };
    expect(bad.error).toBeTruthy();

    // BASED-AGENT-AUDIT: the read is recorded (mutation refusal is not — it never ran)
    const rows = audit.list(devCfg.id);
    expect(rows.some((r) => r.kind === "read" && r.status === "ok")).toBe(true);
    expect(rows.some((r) => r.sql.startsWith("UPDATE"))).toBe(false);

    await adapter.disconnect();
  }, 120_000);

  // Traces: BASED-SCRIPT-OBJECT, BASED-AGENT-READ-ROWS
  test("describe_table scripts a table's CREATE and a view's definition; read_table pages with sort", async () => {
    const adapter = new MssqlAdapter(devCfg, () => null);
    await adapter.connect();
    const audit = new AuditStore(openDb(join(mkdtempSync(join(tmpdir(), "based-audit-script-")), "app.db")));
    const tools = buildAgentTools({
      getAdapter: () => adapter,
      connectionId: () => devCfg.id,
      database: () => devCfg.database,
      audit,
    });
    try {
      const objs = (await tools.list_objects.execute!({}, {} as never)) as {
        objects: Array<{ schema: string; name: string; type: string }>;
      };
      const table = objs.objects.find((o) => o.type === "table")!;
      const scripted = (await tools.describe_table.execute!({ table: table.name, schema: table.schema, format: "ddl" }, {} as never)) as {
        sql?: string;
        type?: string;
      };
      expect(scripted.type).toBe("table");
      expect(scripted.sql).toContain("CREATE TABLE");
      expect(scripted.sql).toContain(table.name);

      // alter on a table → error object, no throw (SSMS parity, surfaced as a tool error)
      const bad = (await tools.describe_table.execute!({ table: table.name, schema: table.schema, format: "alter" }, {} as never)) as {
        error?: string;
      };
      expect(bad.error).toMatch(/not valid for tables/);

      const view = objs.objects.find((o) => o.type === "view");
      if (view) {
        const v = (await tools.describe_table.execute!({ table: view.name, schema: view.schema, format: "ddl" }, {} as never)) as { sql?: string };
        expect(v.sql ?? "").toMatch(/CREATE\s+VIEW/i);
      }

      const unknown = (await tools.describe_table.execute!({ table: "definitely_not_a_real_object_xyz", format: "ddl" }, {} as never)) as {
        error?: string;
        validNames?: string[];
      };
      expect(unknown.error).toBeTruthy();
      expect(unknown.validNames!.length).toBeGreaterThan(0);

      // read_table: a first page in stable order, hasMore heuristic and audit row
      const page = (await tools.read_table.execute!({ table: table.name, schema: table.schema, limit: 5 }, {} as never)) as {
        rows?: unknown[][];
        orderBy?: string[];
        hasMore?: boolean;
        error?: string;
      };
      expect(page.error).toBeUndefined();
      expect(Array.isArray(page.rows)).toBe(true);
      expect(page.orderBy!.length).toBeGreaterThan(0);
      expect(audit.list(devCfg.id).some((r) => r.sql.includes("read_table("))).toBe(true);
    } finally {
      await adapter.disconnect();
    }
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

// Traces: BASED-AGENT-THREADS — per-tab thread history restore + deletion endpoints. Memory-only:
// no DB connection is required. Seeds the server's own agent.db through a second Memory client
// (same LibSQL file; sequential access).
describe("BASED-AGENT-THREADS: thread history GET/DELETE", () => {
  const threadId = "tab:conn-1:tab-abc";
  const resourceId = "conn-1";

  test("seeded thread round-trips as AG-UI messages; DELETE empties it; unknown thread → []", async () => {
    const { createAgentMemory } = await import("@based/core");
    const memory = createAgentMemory(join(dir, "agent.db"));
    const now = new Date();
    await memory.saveThread({ thread: { id: threadId, resourceId, title: "t", createdAt: now, updatedAt: now } });
    await memory.saveMessages({
      messages: [
        {
          id: "m-user-1",
          role: "user",
          createdAt: now,
          threadId,
          resourceId,
          content: { format: 2, parts: [{ type: "text", text: "hello" }] },
        },
        {
          id: "m-asst-1",
          role: "assistant",
          createdAt: new Date(now.getTime() + 1),
          threadId,
          resourceId,
          content: {
            format: 2,
            parts: [
              { type: "text", text: "hi there" },
              {
                type: "tool-invocation",
                toolInvocation: { toolCallId: "call_9", toolName: "get_schema", args: {}, state: "result", result: { objects: [] } },
              },
            ],
          },
        },
      ] as never,
    });

    const got = (await (await api(`/api/agent/threads/${encodeURIComponent(threadId)}/messages?resourceId=${resourceId}`)).json()) as Array<{
      id: string;
      role: string;
      toolCallId?: string;
    }>;
    expect(got.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    expect(got[0]!.id).toBe("m-user-1");
    expect(got[2]!.id).toBe("hist_call_9");
    expect(got[2]!.toolCallId).toBe("call_9");

    const unknown = (await (await api(`/api/agent/threads/nope-thread/messages?resourceId=${resourceId}`)).json()) as unknown[];
    expect(unknown).toEqual([]);

    const del = await api(`/api/agent/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const after = (await (await api(`/api/agent/threads/${encodeURIComponent(threadId)}/messages?resourceId=${resourceId}`)).json()) as unknown[];
    expect(after).toEqual([]);
  }, 60_000);
});

// Traces: BASED-AGENT-DELEGATE-ISOLATION — the load-bearing claim behind delegation is that a
// child's work never lands in the conversation the parent is protecting. That is enforced by
// building the child without memory, so this test runs a real delegated turn against a real
// LibSQL-backed thread and shows the thread is byte-for-byte what it was before.
describe("BASED-AGENT-DELEGATE-ISOLATION: a delegated run leaves the parent thread alone", () => {
  const threadId = "tab:conn-delegate:tab-1";
  const resourceId = "conn-delegate";

  test("thread history is unchanged across a delegated run, and the child's SQL is tagged", async () => {
    const { createAgentMemory, createSubagentRunner, defaultCapabilitiesFor: caps, AuditStore: Audit, openDb: open } =
      await import("@based/core");
    const { MockLanguageModelV4 } = await import("ai/test");

    const memory = createAgentMemory(join(dir, "agent.db"));
    const now = new Date();
    await memory.saveThread({ thread: { id: threadId, resourceId, title: "t", createdAt: now, updatedAt: now } });
    await memory.saveMessages({
      messages: [
        {
          id: "d-user-1",
          role: "user",
          createdAt: now,
          threadId,
          resourceId,
          content: { format: 2, parts: [{ type: "text", text: "which tables feed invoicing?" }] },
        },
      ] as never,
    });

    const url = `/api/agent/threads/${encodeURIComponent(threadId)}/messages?resourceId=${resourceId}`;
    const before = (await (await api(url)).json()) as unknown[];
    expect(before).toHaveLength(1);

    const audit = new Audit(open(join(mkdtempSync(join(tmpdir(), "based-delegate-int-")), "app.db")));
    const runner = createSubagentRunner({
      model: new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [
            {
              type: "tool-call",
              toolCallId: "rc1",
              toolName: "report_findings",
              input: JSON.stringify({ summary: "Invoice, InvoiceLine, and Customer." }),
            },
          ],
          finishReason: "tool-calls",
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          warnings: [],
        }),
      }) as never,
      capabilities: caps("mssql"),
      toolDeps: {
        getAdapter: () => {
          throw new Error("isolation test must not touch the adapter");
        },
        connectionId: () => resourceId,
        database: () => "db",
        audit,
      },
      timeoutMs: 30_000,
      concurrency: 1,
    });

    const [result] = await runner("answer the invoicing question", [
      { name: "invoice tables", instructions: "list the tables that feed invoicing" },
    ]);
    expect(result!.status).toBe("ok");
    expect(result!.summary).toBe("Invoice, InvoiceLine, and Customer.");

    // The child ran, reported, and wrote nothing to the thread the user is looking at.
    const afterDelegation = (await (await api(url)).json()) as unknown[];
    expect(afterDelegation).toEqual(before);

    // The fan-out is still accounted for, under the parent's connection.
    const rows = audit.list(resourceId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.sql).toBe("delegate(answer the invoicing question, 1 task(s))");
    expect(rows[0]!.status).toBe("ok");
  }, 60_000);
});

// Traces: BASED-EMBED-LABELS-AI — endpoint validation always runs; the live-model naming test
// self-skips when the active AI profile's server is unreachable (same spirit as the dev-DB gate).
describe("BASED-EMBED-LABELS-AI: label-clusters endpoint", () => {
  test("rejects an empty/missing cluster list with 400", async () => {
    const res = await api("/api/session/label-clusters?sid=default", {
      method: "POST",
      body: JSON.stringify({ clusters: [] }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toMatch(/cluster/i);
  });

  test("requires auth", async () => {
    const res = await fetch(`${base}/api/session/label-clusters`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clusters: [{ id: 0, samples: ["x"] }] }),
    });
    expect(res.status).toBe(401);
  });
});

// Live naming: probe a local LM Studio's /models with a short timeout; skip when down. This probe
// is read-only and safe to run at module-load time; creating/activating a profile is NOT — it must
// wait for beforeAll (module-load-time code runs before any test in the file, which would corrupt
// the earlier "starts with zero profiles" tests above if it mutated the shared server here).
const aiBase = "http://localhost:1234/v1";
const aiModelId = await (async () => {
  try {
    const res = await fetch(`${aiBase}/models`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Array<{ id: string }> };
    return body.data?.[0]?.id ?? null;
  } catch {
    return null;
  }
})();
const aiUp = aiModelId != null;
const dAi = aiUp ? describe : describe.skip;
if (!aiUp) console.warn("[integration.agent] AI server unreachable, skipping live cluster-labeling test");

dAi("BASED-EMBED-LABELS-AI: live naming via the active profile", () => {
  // There is no built-in default profile anymore, so this suite creates and activates its own —
  // deferred to beforeAll so it runs during test execution, after the earlier zero-profile tests.
  beforeAll(async () => {
    const created = (await (
      await api("/api/ai-profiles", {
        method: "POST",
        body: JSON.stringify({ name: "Live test profile", kind: "openai-compatible", baseUrl: aiBase, model: aiModelId }),
      })
    ).json()) as { id: string };
    await api("/api/ai-profiles/active", { method: "POST", body: JSON.stringify({ id: created.id }) });
  });

  test("returns a short label per cluster id", async () => {
    const res = await api("/api/session/label-clusters?sid=default", {
      method: "POST",
      body: JSON.stringify({
        clusters: [
          { id: 0, hint: "invoice, payment", samples: ["Invoice overdue for order 12", "Payment failed on retry"] },
          { id: 1, hint: "shipping, parcel", samples: ["Parcel stuck in customs", "Shipping delayed again"] },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { labels: Array<{ id: number; label: string }>; model: string };
    expect(body.labels.length).toBe(2);
    expect(body.labels.map((l) => l.id).sort()).toEqual([0, 1]);
    for (const l of body.labels) expect(l.label.length).toBeGreaterThan(0);
  }, 90_000);
});
