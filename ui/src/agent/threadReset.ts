// Traces: BASED-AGENT-THREADS
// Reset generations for chat threads. "New chat" (and tab-close deletion) discards a conversation,
// but a history fetch issued moments earlier is still in flight — when it lands it would restore
// and re-cache exactly what the user just cleared, making the button look broken. Every fetch
// carries the generation it started in; a reset bumps the generation and the late result is dropped.
// Kept free of runtime imports (no api client, no DOM) so specs can unit-test the rule directly.

const generations = new Map<string, number>();

/** Captured before a history fetch; hand back to `historyIsStale` when it resolves. */
export interface HistoryFetchToken {
  threadId: string;
  generation: number;
}

export function beginHistoryFetch(threadId: string): HistoryFetchToken {
  return { threadId, generation: generations.get(threadId) ?? 0 };
}

/** True when the thread was reset after this fetch began — discard the result. */
export function historyIsStale(token: HistoryFetchToken): boolean {
  return (generations.get(token.threadId) ?? 0) !== token.generation;
}

/** Called when a thread's conversation is discarded (New chat / tab close). */
export function markThreadReset(threadId: string): void {
  generations.set(threadId, (generations.get(threadId) ?? 0) + 1);
}
