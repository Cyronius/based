// Traces: BASED-AGENT-THREADS
// Map Mastra memory's DB messages ({ content: { format: 2, parts } }) to AG-UI messages so the UI
// can restore a tab's chat history after a restart. Defensive by design: part shapes evolve across
// Mastra versions, so unknown parts/roles are skipped, never thrown on. A resolved tool invocation
// yields BOTH the assistant toolCalls entry and a synthetic role:"tool" result message (CapiChat
// pairs them by toolCallId); synthetic ids are prefixed "hist_" so the client's outbound pruning
// (pruneRestored) can keep them off the wire — the server already has them under their real ids.
import type { Message } from "@ag-ui/core";

export interface DbMessageLike {
  id: string;
  role: string;
  createdAt?: string | Date;
  content?: {
    format?: number;
    parts?: unknown[];
    content?: string;
  } | null;
}

interface ToolInvocationLike {
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  state?: string;
  result?: unknown;
}

function textOfParts(parts: unknown[]): string {
  const chunks: string[] = [];
  for (const part of parts) {
    const p = part as { type?: string; text?: unknown };
    if (p?.type === "text" && typeof p.text === "string") chunks.push(p.text);
  }
  return chunks.join("");
}

function toolInvocationsOf(parts: unknown[]): ToolInvocationLike[] {
  const out: ToolInvocationLike[] = [];
  for (const part of parts) {
    const p = part as { type?: string; toolInvocation?: ToolInvocationLike };
    if (p?.type === "tool-invocation" && p.toolInvocation && typeof p.toolInvocation.toolCallId === "string") {
      out.push(p.toolInvocation);
    }
  }
  return out;
}

/** Convert a thread's stored messages (chronological) into renderable AG-UI messages. */
export function mapDbMessagesToAgui(messages: DbMessageLike[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const parts = Array.isArray(m.content?.parts) ? m.content!.parts! : [];
    const text = textOfParts(parts) || (typeof m.content?.content === "string" ? m.content.content : "");
    if (m.role === "user") {
      if (text) out.push({ id: m.id, role: "user", content: text });
      continue;
    }
    if (m.role !== "assistant") continue; // system/other roles are not part of the visible thread
    const invocations = toolInvocationsOf(parts);
    const assistant: Message = {
      id: m.id,
      role: "assistant",
      content: text || undefined,
      ...(invocations.length > 0
        ? {
            toolCalls: invocations.map((inv) => ({
              id: inv.toolCallId!,
              type: "function" as const,
              function: {
                name: inv.toolName ?? "tool",
                arguments: safeStringify(inv.args),
              },
            })),
          }
        : {}),
    };
    if (assistant.content || invocations.length > 0) out.push(assistant);
    for (const inv of invocations) {
      if (inv.state !== "result" || inv.result === undefined) continue;
      out.push({
        id: `hist_${inv.toolCallId}`,
        role: "tool",
        toolCallId: inv.toolCallId!,
        content: safeStringify(inv.result),
      });
    }
  }
  return out;
}

function safeStringify(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v ?? {});
  } catch {
    return String(v);
  }
}
