// Traces: BASED-AGENT-THREADS
// Pure thread-id derivation, kept free of runtime imports so specs can unit-test it without a
// DOM; the effectful pieces (cache, fetch/delete) live in ./threads.ts.

/** The chat thread a window shows for a connection: ONE conversation per (window, connection), so
 *  switching tabs never changes the chat. `sid` is the shell's per-window session id, which window
 *  restore reuses across app restarts (BASED-WINDOW-RESTORE) — a restored window keeps its
 *  conversation. Threads persisted under this format are live, so the format is not safe to
 *  change. (Legacy `tab:`/`conn:` threads from the per-tab era remain in agent.db, deliberately
 *  unreferenced — no migration.) */
export function windowThreadId(sid: string, connectionId: string): string {
  return `win:${sid}:${connectionId}`;
}
