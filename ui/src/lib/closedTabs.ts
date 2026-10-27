// Traces: BASED-TAB-REOPEN
// In-session stack of closed-tab batches. One close action = one batch, so a "Close All Tabs" comes
// back with one Ctrl+Shift+T. Pure and generic so specs can test it without the store.

export const CLOSED_TAB_BATCH_CAP = 20;

export function pushClosed<T>(stack: T[][], batch: T[], cap = CLOSED_TAB_BATCH_CAP): T[][] {
  if (batch.length === 0) return stack;
  const next = [...stack, batch];
  return next.length > cap ? next.slice(next.length - cap) : next;
}

export function popClosed<T>(stack: T[][]): { batch: T[] | null; stack: T[][] } {
  if (stack.length === 0) return { batch: null, stack };
  return { batch: stack[stack.length - 1]!, stack: stack.slice(0, -1) };
}
