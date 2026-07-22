// Traces: BASED-AGENT-INSTRUCTIONS (canonical spec: specs/based/spec.md)
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startServer, openDb, AgentInstructionsStore, GENERIC_CORE, MSSQL_PERSONA, LANCE_PERSONA } from "@based/core";

const TOKEN = "spec-instructions-token";
const dbPath = join(mkdtempSync(join(tmpdir(), "based-spec-instructions-")), "app.db");
const server = startServer({ token: TOKEN, dbPath });
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

interface WireSet {
  id: string;
  name: string;
  core: string;
  mssqlPersona: string;
  lancePersona: string;
  editable: boolean;
}
interface WireConfig {
  activeId: string;
  sets: WireSet[];
}

describe("BASED-AGENT-INSTRUCTIONS: store + endpoints", () => {
  test("fresh store: GET returns only the locked Default set, mirroring the built-in constants", async () => {
    const cfg = (await (await api("/api/agent/instructions")).json()) as WireConfig;
    expect(cfg.activeId).toBe("default");
    expect(cfg.sets).toHaveLength(1);
    expect(cfg.sets[0]).toEqual({
      id: "default",
      name: "Default",
      core: GENERIC_CORE,
      mssqlPersona: MSSQL_PERSONA,
      lancePersona: LANCE_PERSONA,
      editable: false,
    });
  });

  test("POST creates a custom set and a later GET (reopened store) still returns it", async () => {
    const created = (await (
      await api("/api/agent/instructions", {
        method: "POST",
        body: JSON.stringify({ name: "Terse", core: "Be terse.", mssqlPersona: "SQL terse.", lancePersona: "Lance terse." }),
      })
    ).json()) as WireConfig;
    const custom = created.sets.find((s) => s.name === "Terse")!;
    expect(custom.editable).toBe(true);
    expect(custom.id).not.toBe("default");

    const again = (await (await api("/api/agent/instructions")).json()) as WireConfig;
    expect(again.sets.some((s) => s.id === custom.id && s.core === "Be terse.")).toBe(true);

    // Reopen the underlying db independently — durable, not just in-memory.
    const db = openDb(dbPath);
    const reopened = new AgentInstructionsStore(db).list();
    expect(reopened.sets.some((s) => s.id === custom.id)).toBe(true);
    db.close();
  });

  test("editing an existing custom set updates it in place rather than duplicating", async () => {
    const created = (await (
      await api("/api/agent/instructions", {
        method: "POST",
        body: JSON.stringify({ name: "V1", core: "v1 core", mssqlPersona: "v1 mssql", lancePersona: "v1 lance" }),
      })
    ).json()) as WireConfig;
    const id = created.sets.find((s) => s.name === "V1")!.id;

    const updated = (await (
      await api("/api/agent/instructions", {
        method: "POST",
        body: JSON.stringify({ id, name: "V2", core: "v2 core", mssqlPersona: "v2 mssql", lancePersona: "v2 lance" }),
      })
    ).json()) as WireConfig;
    const matches = updated.sets.filter((s) => s.id === id);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.name).toBe("V2");
    expect(matches[0]!.core).toBe("v2 core");
  });

  test("POST/DELETE targeting id \"default\" are rejected", async () => {
    const post = await api("/api/agent/instructions", {
      method: "POST",
      body: JSON.stringify({ id: "default", name: "x", core: "x", mssqlPersona: "x", lancePersona: "x" }),
    });
    expect(post.status).toBe(400);

    const del = await api("/api/agent/instructions/default", { method: "DELETE" });
    expect(del.status).toBe(400);
  });

  test("switching the active set persists, and deleting the active custom set falls back to default", async () => {
    const created = (await (
      await api("/api/agent/instructions", {
        method: "POST",
        body: JSON.stringify({ name: "Switchable", core: "c", mssqlPersona: "m", lancePersona: "l" }),
      })
    ).json()) as WireConfig;
    const id = created.sets.find((s) => s.name === "Switchable")!.id;

    const activated = (await (
      await api("/api/agent/instructions/active", { method: "POST", body: JSON.stringify({ id }) })
    ).json()) as WireConfig;
    expect(activated.activeId).toBe(id);

    const stillActive = (await (await api("/api/agent/instructions")).json()) as WireConfig;
    expect(stillActive.activeId).toBe(id);

    const afterDelete = (await (await api(`/api/agent/instructions/${id}`, { method: "DELETE" })).json()) as WireConfig;
    expect(afterDelete.activeId).toBe("default");
    expect(afterDelete.sets.some((s) => s.id === id)).toBe(false);
  });

  test("activating an unknown id is rejected", async () => {
    const r = await api("/api/agent/instructions/active", { method: "POST", body: JSON.stringify({ id: "does-not-exist" }) });
    expect(r.status).toBe(400);
  });
});
