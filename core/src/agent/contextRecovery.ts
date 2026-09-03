// Traces: BASED-AGENT-CONTEXT-RECOVERY
//
// What to do when the provider rejects the request because it doesn't fit the model's context
// window. Before this, that rejection was terminal in the worst possible way: the oversized tool
// result was already written to the tab's thread, so it replayed on every following turn and the
// conversation stayed dead — a one-row follow-up query failed exactly like the query that caused
// it. The only way out was "New chat", which throws the conversation away.
//
// The payload caps in ./toolPayload.ts are the prevention. This is the cure, for the cases they
// can't cover: a long conversation that simply accumulated, a thread poisoned before the caps
// existed, or a model whose real window is smaller than the tool budget assumes.
//
// Mechanism: Mastra's `errorProcessors` hook (processAPIError → { retry }). On an overflow we shed
// the single largest tool result from the message list, replace it with a stub that says what
// happened, and retry. Shedding via `messageList.updateToolInvocation` rather than removing the
// message is deliberate twice over — removing a tool result would orphan its tool call and get the
// request rejected on different grounds, and updateToolInvocation re-persists the message, so the
// oversized payload is replaced in agent.db instead of lying in wait for the next turn.
import type { ErrorProcessor, ProcessAPIErrorArgs, ProcessAPIErrorResult } from "@mastra/core/processors";

/** How many times we will shed-and-retry within one run before giving up and letting the error
 *  surface. Three tool results is enough to clear any realistic single-turn overrun; past that the
 *  problem is the conversation, not one payload. */
export const CONTEXT_RECOVERY_MAX_ATTEMPTS = 3;

/** Don't bother shedding a result smaller than this — retrying without it would just fail again,
 *  and the model would lose context for nothing. */
const MIN_SHEDDABLE_CHARS = 1_000;

export const SHED_TOOL_RESULT_NOTE =
  "[result dropped — it did not fit the model's context window. Re-run this with fewer columns, fewer rows, or the wide columns shortened, or use export_data to write the full data to a file.]";

/** Every provider phrases this differently and none of them use a shared code. LM Studio /
 *  llama.cpp says `exceed_context_size_error`, OpenAI `context_length_exceeded`, Anthropic
 *  "prompt is too long". Matching on text is unlovely but it is the only signal there is. */
const OVERFLOW_PATTERNS = [
  /exceed_context_size_error/i,
  /exceeds the available context size/i,
  /context_length_exceeded/i,
  /maximum context length/i,
  /context window/i,
  /prompt is too long/i,
  /too many tokens/i,
  /reduce the length of the messages/i,
];

/** Pull every string an error might be carrying its reason in. Providers bury it variously in
 *  `message`, a raw `responseBody`, a parsed `data`, or a `cause`. */
export function errorText(err: unknown): string {
  if (err == null) return "";
  if (typeof err === "string") return err;
  const parts: string[] = [];
  const e = err as { message?: unknown; responseBody?: unknown; data?: unknown; cause?: unknown };
  if (typeof e.message === "string") parts.push(e.message);
  if (typeof e.responseBody === "string") parts.push(e.responseBody);
  if (e.data != null) {
    try {
      parts.push(JSON.stringify(e.data));
    } catch {
      // circular / non-serializable — the other fields still carry the reason
    }
  }
  if (e.cause != null && e.cause !== err) parts.push(errorText(e.cause));
  return parts.join(" ");
}

export function isContextOverflowError(err: unknown): boolean {
  const text = errorText(err);
  return text.length > 0 && OVERFLOW_PATTERNS.some((p) => p.test(text));
}

// --- surfacing a provider rejection (BASED-CHAT-UI) ---

/** Cap on the provider body appended to a run error — enough for the reason, not a wall of JSON. */
const MAX_PROVIDER_DETAIL_CHARS = 600;

/**
 * A run error worth showing the user. An AI SDK `APICallError` stringifies to little more than the
 * HTTP status ("AI_APICallError: Bad Request"); the reason the provider actually gave — an
 * unsupported parameter, an unknown model, a rejected tool schema — is in `responseBody`/`data`,
 * which the bare message throws away. This appends that body when it adds something the message
 * doesn't already say. Pure — unit-tested.
 */
export function describeProviderError(err: unknown): string {
  const message = String((err as { message?: unknown } | null)?.message ?? err ?? "").trim();
  const detail = providerDetail(err);
  if (!detail) return message || "The agent request failed for an unknown reason.";
  // Some providers already inline the body in the message; don't print it twice.
  if (message.includes(detail)) return message;
  return message ? `${message} — ${detail}` : detail;
}

/** The provider's own words for the rejection, from wherever the error stashed them. */
function providerDetail(err: unknown): string {
  const e = err as { responseBody?: unknown; data?: unknown; cause?: unknown } | null;
  if (e == null || typeof e !== "object") return "";
  let raw = "";
  if (typeof e.responseBody === "string" && e.responseBody.trim()) raw = e.responseBody.trim();
  else if (e.data != null) {
    try {
      raw = JSON.stringify(e.data);
    } catch {
      raw = "";
    }
  }
  if (!raw) return e.cause != null && e.cause !== err ? providerDetail(e.cause) : "";
  return truncate(unwrapErrorJson(raw), MAX_PROVIDER_DETAIL_CHARS);
}

/** `{"error":{"message":"..."}}` (or `{"message":"..."}`) is the OpenAI-compatible shape every
 *  provider echoes; reduce it to the sentence rather than showing the envelope. */
function unwrapErrorJson(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const node = (parsed as { error?: unknown })?.error ?? parsed;
    if (typeof node === "string") return node;
    const msg = (node as { message?: unknown })?.message;
    if (typeof msg === "string" && msg.trim()) {
      const param = (node as { param?: unknown })?.param;
      return typeof param === "string" && param && !msg.includes(param) ? `${msg} (param: ${param})` : msg;
    }
  } catch {
    // not JSON — the raw body is the best we have
  }
  return raw;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

// Structural shapes for the bits of a Mastra message we touch. Declared here rather than imported
// because the exported part types are nominally distinct across the packages' own @mastra/core
// copies, and this only needs three fields.
interface ToolInvocationPart {
  type: "tool-invocation";
  toolInvocation: { toolCallId?: string; toolName?: string; state?: string; result?: unknown };
}
interface MessageLike {
  content?: { parts?: unknown[] };
}
interface MessageListLike {
  get: { all: { db: () => MessageLike[] } };
  updateToolInvocation?: (part: unknown) => boolean;
}

function isToolResultPart(part: unknown): part is ToolInvocationPart {
  const p = part as ToolInvocationPart | null;
  return p?.type === "tool-invocation" && p.toolInvocation != null && p.toolInvocation.result !== undefined;
}

function resultSize(part: ToolInvocationPart): number {
  const result = part.toolInvocation.result;
  if (typeof result === "string") return result.length;
  try {
    return JSON.stringify(result)?.length ?? 0;
  } catch {
    return 0;
  }
}

/** Replace the biggest tool result in the thread with a stub. Returns false when there is nothing
 *  worth shedding — the caller must then let the error through rather than retry an identical
 *  request. Exported for unit tests, which drive it with plain message objects. */
export function shedLargestToolResult(messageList: MessageListLike): { shed: boolean; toolName?: string; chars?: number } {
  let biggest: ToolInvocationPart | null = null;
  let biggestSize = 0;
  for (const message of messageList.get.all.db()) {
    for (const part of message.content?.parts ?? []) {
      if (!isToolResultPart(part)) continue;
      if (part.toolInvocation.result === SHED_TOOL_RESULT_NOTE) continue; // already shed
      const size = resultSize(part);
      if (size > biggestSize) {
        biggest = part;
        biggestSize = size;
      }
    }
  }
  if (!biggest || biggestSize < MIN_SHEDDABLE_CHARS) return { shed: false };

  const toolName = biggest.toolInvocation.toolName;
  const shrunk = {
    ...biggest,
    toolInvocation: { ...biggest.toolInvocation, result: SHED_TOOL_RESULT_NOTE },
  };
  // The supported path: rewrites the part by toolCallId and marks the message for re-save, so the
  // stored thread is healed too, not just this attempt. The in-place write after it is the belt to
  // that braces — it covers a list that hands out the part by reference and a list whose update
  // lands only in the persistence layer, and it is what makes the shed unconditional.
  messageList.updateToolInvocation?.(shrunk);
  biggest.toolInvocation.result = SHED_TOOL_RESULT_NOTE;
  return { shed: true, toolName, chars: biggestSize };
}

/** The `errorProcessors` entry. Non-overflow errors are passed straight through untouched — this
 *  must never turn a genuine failure (bad SQL, dead connection, revoked key) into a retry loop. */
export function contextRecoveryProcessor(opts?: {
  maxAttempts?: number;
  /** Called when a result is shed, so the server can log what the run gave up. */
  onShed?: (info: { toolName?: string; chars?: number; attempt: number }) => void;
}): ErrorProcessor {
  const maxAttempts = opts?.maxAttempts ?? CONTEXT_RECOVERY_MAX_ATTEMPTS;
  return {
    id: "based-context-recovery",
    name: "Context overflow recovery",
    processAPIError(args: ProcessAPIErrorArgs): ProcessAPIErrorResult {
      if (!isContextOverflowError(args.error)) return { retry: false };
      if (args.retryCount >= maxAttempts) return { retry: false };
      const { shed, toolName, chars } = shedLargestToolResult(args.messageList as unknown as MessageListLike);
      if (!shed) return { retry: false };
      opts?.onShed?.({ toolName, chars, attempt: args.retryCount + 1 });
      return { retry: true };
    },
  } as ErrorProcessor;
}
