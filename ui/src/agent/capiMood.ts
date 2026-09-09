// Traces: BASED-CAPI-MOOD
// The avatar's mood is derived from signals the chat already tracks — never picked at random.
// Kept free of React so the precedence is unit-testable and CapiChat stays a wiring layer.

export type Mood =
  | "idle"
  | "sleepy"
  | "listening"
  | "thinking"
  | "working"
  | "waiting"
  | "talking"
  | "happy"
  | "concerned";

export interface MoodSignals {
  isStreaming: boolean;
  /** `currentMessage` is non-empty — the answer is on screen and arriving. */
  streamingText: boolean;
  lastStepKind: "thinking" | "tool" | null;
  lastStepTool: string | null;
  /** The last non-tool message is an `error_` block. */
  hasError: boolean;
  stalled: boolean;
  /** The Keep going / Try again prompt is showing. */
  needsContinue: boolean;
  /** A turn settled with an answer within the last few seconds. */
  justAnswered: boolean;
  inputFocused: boolean;
  inputText: string;
  /** Time since the last pointer/keyboard activity in the rail or mood-relevant change. */
  idleMs: number;
}

export const SLEEPY_AFTER_MS = 180_000;
/** How long the post-answer hop/smile lasts before decaying to idle. */
export const HAPPY_WINDOW_MS = 4_000;

// First match wins. Trouble outranks busy, busy outranks pleased, pleased outranks attentive.
export function deriveMood(s: MoodSignals): Mood {
  if (s.hasError || s.stalled || s.needsContinue) return "concerned";
  if (s.isStreaming) {
    if (s.streamingText) return "talking";
    if (s.lastStepKind === "tool") return s.lastStepTool === "run_mutation" ? "waiting" : "working";
    return "thinking";
  }
  if (s.justAnswered) return "happy";
  if (s.inputFocused && s.inputText.trim().length > 0) return "listening";
  if (!s.inputFocused && s.idleMs >= SLEEPY_AFTER_MS) return "sleepy";
  return "idle";
}
