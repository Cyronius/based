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
  AiProfileStore,
  AgentInstructionsStore,
  AuditStore,
  DEFAULT_AI_CONFIG,
  buildAgentTools,
  buildAgent,
  agentInstructions,
  GENERIC_CORE,
  MSSQL_PERSONA,
  LANCE_PERSONA,
  skills,
  testConnection,
  setAiKey,
  getAiKey,
  deleteAiKey,
} from "@based/core";
import { MssqlAdapter } from "@based/core/mssql";
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

});

describe("BASED-AI-PROVIDER-PROFILES: profile CRUD + migration", () => {
  test("GET /api/ai-profiles migrates the legacy default config into a profile on first use", async () => {
    const profiles = (await (await api("/api/ai-profiles")).json()) as Array<{ name: string; kind: string; hasKey: boolean }>;
    expect(profiles.length).toBeGreaterThan(0);
    expect(profiles.some((p) => p.name === "Default" && p.kind === "openai-compatible")).toBe(true);
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

  test("the migrated Default profile links to the default instruction set", async () => {
    const profiles = (await (await api("/api/ai-profiles")).json()) as Array<{ name: string; instructionSetId: string }>;
    expect(profiles.find((p) => p.name === "Default")?.instructionSetId).toBe("default");
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
    const { sets } = store.saveSet({ name: "Analyst", core: "CORE-A", mssqlPersona: "SQL-A", lancePersona: "LANCE-A" });
    const custom = sets.find((s) => s.name === "Analyst")!;
    expect(store.resolveById(custom.id, "mssql")).toEqual({ core: "CORE-A", persona: "SQL-A" });
    expect(store.resolveById(custom.id, "lance")).toEqual({ core: "CORE-A", persona: "LANCE-A" });
  });

  test("resolveById falls back to the default set when the id no longer resolves", () => {
    expect(store.resolveById("deleted-set-id", "mssql")).toEqual(store.resolveById("default", "mssql"));
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

  // Traces: BASED-SCRIPT-OBJECT, BASED-AGENT-READ-ROWS
  test("script_object scripts a table's CREATE and a view's definition; read_rows pages with sort", async () => {
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
      const objs = (await tools.get_schema.execute!({}, {} as never)) as {
        objects: Array<{ schema: string; name: string; type: string }>;
      };
      const table = objs.objects.find((o) => o.type === "table")!;
      const scripted = (await tools.script_object.execute!({ name: table.name, schema: table.schema }, {} as never)) as {
        sql?: string;
        type?: string;
      };
      expect(scripted.type).toBe("table");
      expect(scripted.sql).toContain("CREATE TABLE");
      expect(scripted.sql).toContain(table.name);

      // alter on a table → error object, no throw (SSMS parity, surfaced as a tool error)
      const bad = (await tools.script_object.execute!({ name: table.name, schema: table.schema, action: "alter" }, {} as never)) as {
        error?: string;
      };
      expect(bad.error).toMatch(/not valid for tables/);

      const view = objs.objects.find((o) => o.type === "view");
      if (view) {
        const v = (await tools.script_object.execute!({ name: view.name, schema: view.schema }, {} as never)) as { sql?: string };
        expect(v.sql ?? "").toMatch(/CREATE\s+VIEW/i);
      }

      const unknown = (await tools.script_object.execute!({ name: "definitely_not_a_real_object_xyz" }, {} as never)) as {
        error?: string;
        validNames?: string[];
      };
      expect(unknown.error).toBeTruthy();
      expect(unknown.validNames!.length).toBeGreaterThan(0);

      // read_rows: a first page in stable order, hasMore heuristic and audit row
      const page = (await tools.read_rows.execute!({ table: table.name, schema: table.schema, limit: 5 }, {} as never)) as {
        rows?: unknown[][];
        orderBy?: string[];
        hasMore?: boolean;
        error?: string;
      };
      expect(page.error).toBeUndefined();
      expect(Array.isArray(page.rows)).toBe(true);
      expect(page.orderBy!.length).toBeGreaterThan(0);
      expect(audit.list(devCfg.id).some((r) => r.sql.includes("read_rows("))).toBe(true);
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

// Live naming: probe the active profile's /models with a short timeout; skip when down.
const aiBase = (() => {
  try {
    return DEFAULT_AI_CONFIG.baseUrl;
  } catch {
    return null;
  }
})();
const aiUp = await (async () => {
  if (!aiBase) return false;
  try {
    const res = await fetch(`${aiBase}/models`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false;
  }
})();
const dAi = aiUp ? describe : describe.skip;
if (!aiUp) console.warn("[integration.agent] AI server unreachable, skipping live cluster-labeling test");

dAi("BASED-EMBED-LABELS-AI: live naming via the active profile", () => {
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
