// Traces: BASED-BATCH-GO
const GO_LINE = /^\s*go\s*(?:--.*)?$/i;

/** Split SQL text into batches on SSMS-style GO separator lines. Empty batches dropped. */
export function splitBatches(sql: string): string[] {
  return splitBatchesWithLines(sql).map((b) => b.text);
}

/** Same split, plus the 1-based line of the submitted text where each trimmed batch starts, so a
 *  server's batch-relative error line can be mapped back onto the editor (BASED-UI-QUERY-ERROR). */
export function splitBatchesWithLines(sql: string): Array<{ text: string; startLine: number }> {
  const batches: Array<{ text: string; startLine: number }> = [];
  let current: string[] = [];
  let currentStart = 1;
  const flush = () => {
    const text = current.join("\n").trim();
    if (text) batches.push({ text, startLine: currentStart + current.findIndex((l) => l.trim() !== "") });
  };
  sql.split(/\r?\n/).forEach((line, i) => {
    if (GO_LINE.test(line)) {
      flush();
      current = [];
      currentStart = i + 2;
    } else {
      current.push(line);
    }
  });
  flush();
  return batches;
}
