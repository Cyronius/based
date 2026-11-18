// Traces: BASED-AI-MODEL-PICKER
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startServer, deleteAiKey } from "@based/core";

const KEY = "fixture-key";
const fixture = Bun.serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/v1/models" || url.pathname === "/keyed/v1/models") {
      const authed = req.headers.get("authorization") === `Bearer ${KEY}` || req.headers.get("x-api-key") === KEY;
      if (url.pathname.startsWith("/keyed") && !authed) return new Response("unauthorized", { status: 401 });
      if (url.searchParams.get("limit") === "1000" && req.headers.get("anthropic-version") === null) {
        return new Response("missing version", { status: 400 });
      }
      return Response.json({ data: [{ id: "zeta-7b" }, { id: "alpha-1b" }, { id: "zeta-7b" }, {}] });
    }
    return new Response("not found", { status: 404 });
  },
});
const fixtureBase = `http://localhost:${fixture.port}/v1`;

const dir = mkdtempSync(join(tmpdir(), "based-spec-models-"));
const TOKEN = "models-token";
const server = startServer({ token: TOKEN, dbPath: join(dir, "app.db"), agentDbPath: join(dir, "agent.db") });
const created: string[] = [];

afterAll(async () => {
  for (const id of created) deleteAiKey(id);
  await server.stop();
  fixture.stop(true);
});

async function post(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(200);
  return res.json();
}

describe("BASED-AI-MODEL-PICKER: POST /api/ai-profiles/models", () => {
  test("openai-compatible lists ids, sorted and de-duplicated", async () => {
    expect(await post("/api/ai-profiles/models", { kind: "openai-compatible", baseUrl: `${fixtureBase}/` })).toEqual({
      models: ["alpha-1b", "zeta-7b"],
    });
  });

  test("anthropic sends x-api-key and anthropic-version", async () => {
    const r = await post("/api/ai-profiles/models", { kind: "anthropic", baseUrl: fixtureBase, apiKey: KEY });
    expect(r).toEqual({ models: ["alpha-1b", "zeta-7b"] });
  });

  test("azure-openai returns an empty list without a request", async () => {
    expect(await post("/api/ai-profiles/models", { kind: "azure-openai", baseUrl: "http://127.0.0.1:1" })).toEqual({ models: [] });
  });

  test("unreachable base URL → empty list with an error, not a 500", async () => {
    const r = await post("/api/ai-profiles/models", { kind: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1" });
    expect(r.models).toEqual([]);
    expect(typeof r.error).toBe("string");
    expect(r.error.length).toBeGreaterThan(0);
  });

  test("blank apiKey + profileId uses the stored key", async () => {
    const baseUrl = `http://localhost:${fixture.port}/keyed/v1`;
    const profile = await post("/api/ai-profiles", { name: "Keyed", kind: "openai-compatible", baseUrl, model: "", apiKey: KEY });
    created.push(profile.id);
    const without = await post("/api/ai-profiles/models", { kind: "openai-compatible", baseUrl });
    expect(without.error).toContain("401");
    const withStored = await post("/api/ai-profiles/models", { kind: "openai-compatible", baseUrl, apiKey: "", profileId: profile.id });
    expect(withStored).toEqual({ models: ["alpha-1b", "zeta-7b"] });
  });
});
