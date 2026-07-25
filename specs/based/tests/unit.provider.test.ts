// Traces: BASED-AI-PROVIDER-WIRED, BASED-AI-PROFILE-PARAMS
// resolveModel must construct a real AI SDK model for every ProviderKind (openai / azure-openai /
// anthropic natively, not just the openai-compatible gateway), and resolveExecutionDefaults must
// split a profile's params JSON into modelSettings + namespaced providerOptions.
import { describe, expect, test } from "bun:test";
import { resolveModel, resolveExecutionDefaults } from "@based/core";

const base = { id: "p1", baseUrl: "", model: "m", deployment: undefined as string | undefined };

describe("BASED-AI-PROVIDER-WIRED: resolveModel branches", () => {
  test("openai-compatible resolves without a key (LM Studio path unchanged)", () => {
    const m = resolveModel({ ...base, kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "local-model" }, null);
    expect(m).toBeDefined();
    expect((m as { modelId: string }).modelId).toBe("local-model");
  });

  test("openai-compatible provider namespace is the stable name, not the profile id", () => {
    const m = resolveModel({ ...base, kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "x" }, null);
    expect((m as { provider: string }).provider.startsWith("openai-compatible")).toBe(true);
  });

  test("openai with a key returns a model with the profile's model id", () => {
    const m = resolveModel({ ...base, kind: "openai", model: "gpt-5.4" }, "sk-test");
    expect((m as { modelId: string }).modelId).toBe("gpt-5.4");
  });

  test("anthropic with a key returns a model with the profile's model id", () => {
    const m = resolveModel({ ...base, kind: "anthropic", model: "claude-sonnet-5" }, "sk-ant-test");
    expect((m as { modelId: string }).modelId).toBe("claude-sonnet-5");
  });

  test("azure-openai runs the deployment as the model id", () => {
    const m = resolveModel(
      { ...base, kind: "azure-openai", baseUrl: "https://res.openai.azure.com", model: "gpt-5.4", deployment: "my-deploy" },
      "azure-key",
    );
    expect((m as { modelId: string }).modelId).toBe("my-deploy");
  });

  test("azure-openai without a deployment throws mentioning deployment", () => {
    expect(() =>
      resolveModel({ ...base, kind: "azure-openai", baseUrl: "https://res.openai.azure.com" }, "azure-key"),
    ).toThrow(/deployment/i);
  });

  test.each(["openai", "azure-openai", "anthropic"] as const)("%s without a key throws naming the provider", (kind) => {
    expect(() => resolveModel({ ...base, kind, baseUrl: "https://x", deployment: "d" }, null)).toThrow(new RegExp(kind, "i"));
  });
});

describe("BASED-AI-PROFILE-PARAMS: resolveExecutionDefaults split", () => {
  test("known call-settings keys go to modelSettings; the rest to the kind's namespace", () => {
    const r = resolveExecutionDefaults("openai-compatible", { temperature: 0.2, reasoning_effort: "low" });
    expect(r.modelSettings).toEqual({ temperature: 0.2 });
    expect(r.providerOptions).toEqual({ "openai-compatible": { reasoning_effort: "low" } });
  });

  test("azure-openai namespaces under openai (azure rides the openai models)", () => {
    const r = resolveExecutionDefaults("azure-openai", { reasoning_effort: "high" });
    expect(r.providerOptions).toEqual({ openai: { reasoning_effort: "high" } });
  });

  test("anthropic namespace", () => {
    const r = resolveExecutionDefaults("anthropic", { thinking: { type: "enabled", budgetTokens: 4096 } });
    expect(r.providerOptions).toEqual({ anthropic: { thinking: { type: "enabled", budgetTokens: 4096 } } });
  });

  test("explicit providerOptions passes through and merges with implicit keys", () => {
    const r = resolveExecutionDefaults("openai", { providerOptions: { openai: { a: 1 } }, reasoning_effort: "low" });
    expect(r.providerOptions).toEqual({ openai: { a: 1, reasoning_effort: "low" } });
  });

  test("explicit providerOptions for a different namespace survives untouched", () => {
    const r = resolveExecutionDefaults("openai", { providerOptions: { other: { b: 2 } }, temperature: 1 });
    expect(r.providerOptions).toEqual({ other: { b: 2 } });
    expect(r.modelSettings).toEqual({ temperature: 1 });
  });

  test("all recognized call-settings keys are routed to modelSettings", () => {
    const params = {
      temperature: 0.5,
      topP: 0.9,
      topK: 40,
      maxOutputTokens: 2048,
      presencePenalty: 0.1,
      frequencyPenalty: 0.2,
      stopSequences: ["END"],
      seed: 7,
      maxRetries: 1,
    };
    const r = resolveExecutionDefaults("anthropic", params);
    expect(r.modelSettings).toEqual(params);
    expect(r.providerOptions).toBeUndefined();
  });

  test("empty or absent params yield no settings at all", () => {
    expect(resolveExecutionDefaults("openai", undefined)).toEqual({});
    expect(resolveExecutionDefaults("openai", {})).toEqual({});
  });
});
