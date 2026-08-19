// Traces: BASED-AGENT-THREADS, BASED-AGENT-TAB-TOOLS
// Per-window chat threads: the in-session message cache that makes connection switches instant,
// server history restore, and deletion. The pure id derivation lives in ./threadIds.ts
// (re-exported here) so specs can unit-test it without this module's window-bound api client.
import type { Message } from "@ag-ui/client";
import { api } from "../api/client";
import { beginHistoryFetch, historyIsStale, markThreadReset } from "./threadReset";

export { windowThreadId } from "./threadIds";

/** In-session cache: threadId → rendered messages, so switching back to a connection's thread is
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
  const fetchToken = beginHistoryFetch(threadId);
  try {
    const messages = await api<Message[]>(
      `/api/agent/threads/${encodeURIComponent(threadId)}/messages?resourceId=${encodeURIComponent(connectionId)}`,
    );
    // "New chat" landed while this was in flight: the user discarded this conversation, and the
    // DELETE races the GET server-side — never resurrect it into the view or back into the cache.
    if (historyIsStale(fetchToken)) return [];
    for (const m of messages) restoredIds.add(m.id);
    threadMessageCache.set(threadId, messages);
    return messages;
  } catch {
    return [];
  }
}

/** Fire-and-forget server-side thread deletion ("New chat"). */
export function deleteThread(threadId: string): void {
  markThreadReset(threadId);
  threadMessageCache.delete(threadId);
  void api(`/api/agent/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" }).catch(() => {});
}
