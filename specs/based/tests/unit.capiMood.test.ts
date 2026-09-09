// Traces: BASED-CAPI-MOOD
//
// The avatar's mood is a pure function of chat signals the rail already has. This pins the
// precedence (an error outranks everything; a pending approval outranks a generic tool step;
// streaming text outranks the "thinking" placeholder) and the idle/sleepy thresholds, so the
// component stays a thin wiring layer and the avatar can't drift back to random expressions.
import { describe, expect, test } from "bun:test";
import { deriveMood, SLEEPY_AFTER_MS, type MoodSignals } from "../../../ui/src/agent/capiMood";

const base: MoodSignals = {
  isStreaming: false,
  streamingText: false,
  lastStepKind: null,
  lastStepTool: null,
  hasError: false,
  stalled: false,
  needsContinue: false,
  justAnswered: false,
  inputFocused: false,
  inputText: "",
  idleMs: 0,
};

const s = (over: Partial<MoodSignals>): MoodSignals => ({ ...base, ...over });

describe("BASED-CAPI-MOOD: deriveMood", () => {
  test("nothing happening → idle", () => {
    expect(deriveMood(base)).toBe("idle");
  });

  test("streaming with a thinking step and no text → thinking", () => {
    expect(deriveMood(s({ isStreaming: true, lastStepKind: "thinking" }))).toBe("thinking");
  });

  test("streaming with no step yet → thinking", () => {
    expect(deriveMood(s({ isStreaming: true }))).toBe("thinking");
  });

  test("streaming with a tool step → working", () => {
    expect(deriveMood(s({ isStreaming: true, lastStepKind: "tool", lastStepTool: "list_tabs" }))).toBe("working");
  });

  test("run_mutation step (approval card up) → waiting, over working", () => {
    expect(deriveMood(s({ isStreaming: true, lastStepKind: "tool", lastStepTool: "run_mutation" }))).toBe("waiting");
  });

  test("text streaming → talking, over thinking", () => {
    expect(deriveMood(s({ isStreaming: true, streamingText: true, lastStepKind: "thinking" }))).toBe("talking");
  });

  test("text streaming after a tool step → talking, over working", () => {
    expect(deriveMood(s({ isStreaming: true, streamingText: true, lastStepKind: "tool", lastStepTool: "get_tab" }))).toBe("talking");
  });

  test("error outranks streaming", () => {
    expect(deriveMood(s({ isStreaming: true, streamingText: true, hasError: true }))).toBe("concerned");
  });

  test("stall prompt → concerned", () => {
    expect(deriveMood(s({ isStreaming: true, stalled: true, lastStepKind: "tool", lastStepTool: "run_mutation" }))).toBe("concerned");
  });

  test("continue prompt → concerned", () => {
    expect(deriveMood(s({ needsContinue: true, justAnswered: true }))).toBe("concerned");
  });

  test("turn just settled → happy", () => {
    expect(deriveMood(s({ justAnswered: true }))).toBe("happy");
  });

  test("happy outranks listening", () => {
    expect(deriveMood(s({ justAnswered: true, inputFocused: true, inputText: "next q" }))).toBe("happy");
  });

  test("focused with text → listening", () => {
    expect(deriveMood(s({ inputFocused: true, inputText: "what tables" }))).toBe("listening");
  });

  test("focused with only whitespace → idle", () => {
    expect(deriveMood(s({ inputFocused: true, inputText: "   " }))).toBe("idle");
  });

  test("text but not focused → idle", () => {
    expect(deriveMood(s({ inputFocused: false, inputText: "draft" }))).toBe("idle");
  });

  test("idle past the threshold → sleepy", () => {
    expect(deriveMood(s({ idleMs: SLEEPY_AFTER_MS }))).toBe("sleepy");
    expect(deriveMood(s({ idleMs: SLEEPY_AFTER_MS - 1 }))).toBe("idle");
  });

  test("input focus blocks sleepy", () => {
    expect(deriveMood(s({ idleMs: SLEEPY_AFTER_MS * 2, inputFocused: true }))).toBe("idle");
  });

  test("streaming blocks sleepy", () => {
    expect(deriveMood(s({ idleMs: SLEEPY_AFTER_MS * 2, isStreaming: true }))).toBe("thinking");
  });

  test("threshold is three minutes", () => {
    expect(SLEEPY_AFTER_MS).toBe(180_000);
  });
});
