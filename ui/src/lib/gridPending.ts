// Traces: BASED-TABLE-EDIT-RETAIN
// Count of pending Data-grid changes: edited rows not also deleted, non-empty new rows, and deletions.

type PendingParts = {
  edits?: Record<number, Record<string, unknown>>;
  newRows?: Array<Record<string, unknown>>;
  deleted?: Set<number>;
};

export function gridPendingCount(g: PendingParts | undefined): number {
  if (!g) return 0;
  const deleted = g.deleted ?? new Set<number>();
  const updates = Object.entries(g.edits ?? {}).filter(([i, changed]) => !deleted.has(Number(i)) && Object.keys(changed).length > 0).length;
  const inserts = (g.newRows ?? []).filter((r) => Object.keys(r).length > 0).length;
  return updates + inserts + deleted.size;
}
