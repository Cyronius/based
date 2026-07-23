// Traces: BASED-CHAT-SQL-LABELS
// Pure parsing of ```sql fences in assistant markdown into the labeled Insert/Run blocks CapiChat
// renders. Kept free of React/streamdown imports so specs can unit-test it directly.

export interface SqlBlock {
  /** Full fence content, leading comment included — what Insert/Run receive. */
  sql: string;
  /** Text of the leading `-- ...` purpose comment (persona asks the model to emit one), or null. */
  label: string | null;
  /** First non-empty, non-`--`-comment line; falls back to the raw first line if none exists. */
  firstLine: string;
}

export function parseSqlBlocks(md: string): SqlBlock[] {
  const out: SqlBlock[] = [];
  const re = /```sql\s*\r?\n([\s\S]*?)```/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md))) {
    const sql = m[1]!.trim();
    if (!sql) continue;
    const lines = sql.split(/\r?\n/);
    const first = lines[0]!.trim();
    const label = first.startsWith("--") ? first.replace(/^--\s*/, "").trim() || null : null;
    const firstSql = lines.map((l) => l.trim()).find((l) => l && !l.startsWith("--"));
    out.push({ sql, label, firstLine: firstSql ?? first });
  }
  return out;
}
