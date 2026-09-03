// Traces: BASED-AI-PROVIDER-WIRED, BASED-AI-PROFILE-PARAMS, BASED-AI-PROFILE-TIMEOUT
// resolveModel must construct a real AI SDK model for every ProviderKind (openai / azure-openai /
// anthropic natively, not just the openai-compatible gateway), resolveExecutionDefaults must
// split a profile's params JSON into modelSettings + namespaced providerOptions, and
// resolveAiTimeouts must turn a profile's timeoutSeconds into the idle + whole-run windows.
import { describe, expect, test } from "bun:test";
import {
  resolveModel,
  resolveExecutionDefaults,
  resolveAiTimeouts,
  sanitizeRequestBody,
  DEFAULT_AI_TIMEOUT_SECONDS,
  AI_RUN_TIMEOUT_MULTIPLIER,
} from "@based/core";

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

  test("openai-compatible with a blank model still resolves (single-model local server)", () => {
    const m = resolveModel({ ...base, kind: "openai-compatible", baseUrl: "http://localhost:1234/v1", model: "" }, null);
    expect(m).toBeDefined();
    expect((m as { modelId: string }).modelId).toBe("");
  });

  test("an empty model key is stripped from the request body", () => {
    const body = JSON.stringify({ model: "", messages: [{ role: "user", content: "hi" }], stream: true });
    expect(JSON.parse(sanitizeRequestBody(body))).toEqual({ messages: [{ role: "user", content: "hi" }], stream: true });
  });

  test("a whitespace-only model key is stripped too", () => {
    expect(JSON.parse(sanitizeRequestBody(JSON.stringify({ model: "  ", stream: false })))).toEqual({ stream: false });
  });

  test("a non-empty model key is left untouched", () => {
    const body = JSON.stringify({ model: "local-model", messages: [] });
    expect(sanitizeRequestBody(body)).toBe(body);
  });

  test("a non-JSON body passes through verbatim", () => {
    expect(sanitizeRequestBody("not json")).toBe("not json");
    expect(sanitizeRequestBody("[1,2,3]")).toBe("[1,2,3]");
  });

  // The bug: turn 1 of a Cerebras conversation succeeded and turn 2 died with HTTP 400
  // "property 'messages.2.assistant.reasoning_content' is unsupported". A reasoning model returns
  // its thinking as `reasoning_content`, the SDK keeps it, and then sends it straight back.
  test("reasoning_content is stripped from assistant messages, leaving everything else intact", () => {
    const body = JSON.stringify({
      model: "qwen-3-32b",
      messages: [
        { role: "system", content: "you are based" },
        { role: "user", content: "how many rows?" },
        { role: "assistant", content: "12", reasoning_content: "the user wants a count…", tool_calls: [{ id: "t1" }] },
        { role: "user", content: "and columns?" },
      ],
      stream: true,
    });
    expect(JSON.parse(sanitizeRequestBody(body))).toEqual({
      model: "qwen-3-32b",
      messages: [
        { role: "system", content: "you are based" },
        { role: "user", content: "how many rows?" },
        { role: "assistant", content: "12", tool_calls: [{ id: "t1" }] },
        { role: "user", content: "and columns?" },
      ],
      stream: true,
    });
  });

  test("reasoning_content on a non-assistant message is left alone, and a clean body is byte-identical", () => {
    // Only the assistant slot is rejected; nothing else is ours to rewrite.
    const userReasoning = JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi", reasoning_content: "x" }] });
    expect(sanitizeRequestBody(userReasoning)).toBe(userReasoning);

    const clean = JSON.stringify({ model: "m", messages: [{ role: "assistant", content: "hi" }] });
    expect(sanitizeRequestBody(clean)).toBe(clean);
  });

  test("a blank model and reasoning_content are both fixed in one pass", () => {
    const body = JSON.stringify({ model: " ", messages: [{ role: "assistant", content: "hi", reasoning_content: "…" }] });
    expect(JSON.parse(sanitizeRequestBody(body))).toEqual({ messages: [{ role: "assistant", content: "hi" }] });
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

describe("BASED-AI-PROFILE-TIMEOUT: resolveAiTimeouts", () => {
  test("a configured value drives the idle window and the whole-run cap", () => {
    expect(resolveAiTimeouts(1800)).toEqual({ idleMs: 1_800_000, runMs: 1_800_000 * AI_RUN_TIMEOUT_MULTIPLIER });
  });

  test("an absent value falls back to the default", () => {
    const expected = { idleMs: DEFAULT_AI_TIMEOUT_SECONDS * 1000, runMs: DEFAULT_AI_TIMEOUT_SECONDS * 1000 * AI_RUN_TIMEOUT_MULTIPLIER };
    expect(resolveAiTimeouts(undefined)).toEqual(expected);
    expect(resolveAiTimeouts(null)).toEqual(expected);
  });

  test.each([0, -30, Number.NaN, Number.POSITIVE_INFINITY])("a non-positive/non-finite value (%p) falls back to the default", (v) => {
    expect(resolveAiTimeouts(v).idleMs).toBe(DEFAULT_AI_TIMEOUT_SECONDS * 1000);
  });

  test("fractional seconds floor to whole seconds", () => {
    expect(resolveAiTimeouts(90.7).idleMs).toBe(90_000);
  });

  test("defaults: 2 min silence window, ×15 whole-run/subagent cap", () => {
    // The idle window now drives an ask-to-keep-waiting prompt (not a kill), so it can be short;
    // the multiplier sizes the subagent wall-clock cap (120 s × 15 = 30 min per child task).
    expect(DEFAULT_AI_TIMEOUT_SECONDS).toBe(120);
    expect(AI_RUN_TIMEOUT_MULTIPLIER).toBe(15);
  });
});
