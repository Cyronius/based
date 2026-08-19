// Traces: BASED-AGENT-THREADS, BASED-CHAT-HISTORY-PICKER
// Per-window chat threads: the in-session message cache that makes thread switches instant,
// server history restore, and the history-picker list fetch. The pure id minting lives in
// ./threadIds.ts (re-exported here) so specs can unit-test it without this module's window-bound
// api client.
import type { Message } from "@ag-ui/client";
import { api } from "../api/client";

export { newChatThreadId } from "./threadIds";

/** In-session cache: threadId → rendered messages, so switching back to a conversation is
 *  instant and needs no server round-trip. Module-level like the store's connectionCache. */
export const threadMessageCache = new Map<string, Message[]>();

/** Ids of messages restored from server history (synthetic `hist_*` tool results and their turn's
 *  originals). Restored messages must never re-ship on the wire — the server already has them under
 *  their real ids, and re-sending synthetic tool results would duplicate them in memory. */
const restoredIds = new Set<string>();

/** Drop restored-history messages from an outbound send (used as `pruneOutboundMessages`).
 *  Deliberately filters whole messages rather than only editing content: safe under
 *  sendFullHistory:false, where each send is [context?, latest] or new tool results only. */
export function pruneRestored(messages: Message[]): Message[] {
  return messages.filter((m) => !restoredIds.has(m.id));
}

export async function fetchThreadHistory(threadId: string, connectionId: string): Promise<Message[]> {
  try {
    const messages = await api<Message[]>(
      `/api/agent/threads/${encodeURIComponent(threadId)}/messages?resourceId=${encodeURIComponent(connectionId)}`,
    );
    for (const m of messages) restoredIds.add(m.id);
    threadMessageCache.set(threadId, messages);
    return messages;
  } catch {
    return [];
  }
}

/** One row in the history picker (BASED-CHAT-HISTORY-PICKER). */
export interface ChatThreadSummary {
  id: string;
  title: string;
  updatedAt: string;
}

/** The connection's newest conversations for the history picker, server-titled. */
export async function fetchThreadList(connectionId: string, limit = 15): Promise<ChatThreadSummary[]> {
  try {
    return await api<ChatThreadSummary[]>(
      `/api/agent/threads?resourceId=${encodeURIComponent(connectionId)}&limit=${limit}`,
    );
  } catch {
    return [];
  }
}
