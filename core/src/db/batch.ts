// Traces: BASED-BATCH-GO
const GO_LINE = /^\s*go\s*(?:--.*)?$/i;

/** Split SQL text into batches on SSMS-style GO separator lines. Empty batches dropped. */
export function splitBatches(sql: string): string[] {
  const batches: string[] = [];
  let current: string[] = [];
  for (const line of sql.split(/\r?\n/)) {
    if (GO_LINE.test(line)) {
      const text = current.join("\n").trim();
      if (text) batches.push(text);
      current = [];
    } else {
      current.push(line);
    }
  }
  const last = current.join("\n").trim();
  if (last) batches.push(last);
  return batches;
}
