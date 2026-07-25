// Traces: BASED-AGENT-THREADS
// Pure thread-id derivation + the owns-and-unaliased close rule. Kept free of runtime imports
// (only erased type imports) so specs can unit-test the rules without a DOM; the effectful pieces
// (cache, fetch/delete) live in ./threads.ts.
import type { QueryTabState, TabState } from "../store";

/** The thread a tab OWNS. The connectionId prefix guarantees global uniqueness — deterministic tab
 *  ids like `table:dbo.Users` repeat across connections and threadId is the memory store's key. */
export function agentThreadId(connectionId: string, tabId: string | null): string {
  return tabId ? `tab:${connectionId}:${tabId}` : `conn:${connectionId}`;
}

/** The thread a tab SHOWS: its alias (`originThreadId`, set when the agent opened the tab from an
 *  existing conversation) or its own derived thread. */
export function resolveThreadId(connectionId: string, tabs: TabState[], tabId: string | null): string {
  if (!tabId) return agentThreadId(connectionId, null);
  const tab = tabs.find((t) => t.id === tabId);
  const alias = tab?.kind === "query" ? (tab as QueryTabState).originThreadId : undefined;
  return alias ?? agentThreadId(connectionId, tabId);
}

/** Which threads may actually be deleted when `closingIds` close: a closing tab's OWNED thread,
 *  and only when no surviving open tab aliases it. Aliased tabs never delete their target. */
export function threadsToDeleteOnClose(connectionId: string, tabs: TabState[], closingIds: string[]): string[] {
  const closing = new Set(closingIds);
  const survivors = tabs.filter((t) => !closing.has(t.id));
  const aliasedBySurvivors = new Set(
    survivors.map((t) => (t.kind === "query" ? (t as QueryTabState).originThreadId : undefined)).filter(Boolean),
  );
  const out: string[] = [];
  for (const id of closingIds) {
    const owned = agentThreadId(connectionId, id);
    if (!aliasedBySurvivors.has(owned)) out.push(owned);
  }
  return out;
}
