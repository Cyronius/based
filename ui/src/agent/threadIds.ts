// Traces: BASED-AGENT-THREADS, BASED-CHAT-HISTORY-PICKER
// Pure thread-id minting, kept free of window-bound runtime imports so specs can unit-test it
// without a DOM; the effectful pieces (cache, fetch, active-pointer) live in ./threads.ts.

/** Mint the id for a new conversation. Conversations are durable per-connection records — the
 *  `resourceId` (connection id) scopes them, and the id itself carries no window or tab identity,
 *  so the history picker can reactivate one anywhere. Threads persisted under this format are
 *  live; the format is not safe to change. (Legacy `tab:`/`conn:` threads from the per-tab era
 *  remain in agent.db, deliberately unreferenced — no migration.) */
export function newChatThreadId(): string {
  return `chat:${crypto.randomUUID()}`;
}
