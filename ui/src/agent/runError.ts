// Traces: BASED-CHAT-UI ("Run errors surface in the rail" — the pre-stream half)
// A run can die before the SSE stream ever opens: the endpoint returns a JSON error (no AI profile,
// session not connected, 500), or the fetch itself fails because the server is gone. Those
// rejections never become RUN_ERROR events, so the chat needs its own wording for them. The
// lm-ag-ui transport attaches `status` and the parsed body as `payload` to the error it throws —
// that body carries the server's actual message ({ error: "..." }), which beats the
// `HTTP 400: {...}` wrapper it is otherwise buried in.
//
// This module also classifies the third way a turn fails to answer, which is neither a rejection
// nor a RUN_ERROR — see classifySettledTurn.

const UNREACHABLE_MESSAGE = "Could not reach the server — it may have stopped. Check the app is still running and try again.";
const MAX_BODY_CHARS = 300;

/** True for a user-initiated Stop (aborted fetch) — never worth reporting as a failure. */
export function isAbortError(err: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && err instanceof DOMException && err.name === "AbortError") ||
    (err instanceof Error && err.name === "AbortError")
  );
}

/** Human-readable reason for a rejected agent run, best server message first. */
export function describeRunError(err: unknown): string {
  const e = err as { message?: unknown; status?: unknown; payload?: unknown } | null;

  const payload = e?.payload;
  if (payload && typeof payload === "object" && typeof (payload as { error?: unknown }).error === "string") {
    return (payload as { error: string }).error;
  }
  if (typeof payload === "string") {
    const body = payload.trim();
    // A short plain-text body is the message; an HTML error page or a wall of text is not.
    if (body.length > 0 && body.length <= MAX_BODY_CHARS && !body.startsWith("<")) {
      return typeof e?.status === "number" ? `${body} (HTTP ${e.status})` : body;
    }
  }

  // fetch() rejects with a TypeError when the server itself is unreachable.
  if (err instanceof TypeError) return UNREACHABLE_MESSAGE;

  if (typeof err === "string" && err.trim()) return err;
  if (typeof e?.message === "string" && e.message.trim()) return e.message;
  return "The agent request failed for an unknown reason.";
}

/** The three ways a settled (non-streaming) turn can end, from the transcript alone. */
export type TurnEnd = "ok" | "tool-calls" | "no-output";

/** The shape classifySettledTurn reads — structural, so both library and test messages satisfy it. */
export interface TurnMessage {
  id: string;
  role: string;
  content?: unknown;
  toolCalls?: unknown[];
}

/**
 * Classify how the last turn ended.
 *
 * `"no-output"` is the failure mode no error path catches: the run completes normally and emits
 * nothing at all — no text, no tool calls, no RUN_ERROR, no rejection. A provider that answers an
 * unknown path with HTTP 200 and a JSON error body does exactly this (LM Studio does; a typo in a
 * profile's base URL is enough), because every layer below reads 200 as success and the response
 * simply carries no choices. Left unhandled it renders as silence plus a duration.
 *
 * `"tool-calls"` is the older, narrower case: the run exhausted its tool-step budget and ended
 * tool-calls-last, so there IS an assistant message, just no final text.
 *
 * Pure — unit-tested. Callers must gate on the run being settled; a mid-stream transcript
 * legitimately has the user's message last.
 */
export function classifySettledTurn(messages: readonly TurnMessage[]): TurnEnd {
  // Tool results are transcript bookkeeping, not the turn's answer.
  const last = [...messages].reverse().find((m) => m.role !== "tool");
  if (!last) return "ok"; // nothing sent yet
  // The turn came back with nothing to show for it: the user's own message is still the last thing.
  if (last.role === "user") return "no-output";
  if (last.role !== "assistant") return "ok";
  if (typeof last.content === "string" && last.content.trim()) return "ok";
  // An assistant message with neither text nor tool calls is as empty as no message at all.
  return last.toolCalls?.length ? "tool-calls" : "no-output";
}
