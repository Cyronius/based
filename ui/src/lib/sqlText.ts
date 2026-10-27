// Traces: BASED-UI-READONLY-MIRROR, BASED-TAB-AUTONAME-DERIVE
// SQL text helpers for the webview. The strippers and isReadOnly mirror core/src/db/classify.ts
// (the webview never imports Bun-flavored core modules — see ui/src/api/types.ts).

export function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n\r]*/g, " ");
}

export function stripStringLiterals(sql: string): string {
  return sql.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');
}

export type Tok = { ident: boolean; v: string };

/** Words, [bracketed] identifiers, and the punctuation the walker cares about; everything
 *  else (operators, numbers, leftover quote pairs) is irrelevant to naming and dropped. */
export function tokenize(sql: string): Tok[] {
  const toks: Tok[] = [];
  const re = /\[[^\]]*\]|[A-Za-z_@#$][A-Za-z0-9_@#$]*|[(),;.=]/g;
  for (const m of sql.matchAll(re)) {
    const v = m[0]!;
    toks.push(v.startsWith("[") ? { ident: true, v: v.slice(1, -1) } : { ident: false, v });
  }
  return toks;
}

const MUTATING = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "INTO",
  "DROP", "CREATE", "ALTER", "TRUNCATE", "RENAME",
  "EXEC", "EXECUTE",
  "GRANT", "REVOKE", "DENY",
  "BACKUP", "RESTORE", "BULK", "WRITETEXT", "UPDATETEXT",
];
const MUTATING_RE = new RegExp(`\\b(${MUTATING.join("|")})\\b`, "i");

function firstKeyword(sql: string): string {
  const cleaned = stripStringLiterals(stripSqlComments(sql)).replace(/^[\s(;]+/, "");
  const m = cleaned.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1]!.toUpperCase() : "";
}

/** Same rule as core's classifier: a pure read leads with SELECT/WITH and has no mutating keyword. */
export function isReadOnly(sql: string): boolean {
  const first = firstKeyword(sql);
  if (first !== "SELECT" && first !== "WITH") return false;
  return !MUTATING_RE.test(stripStringLiterals(stripSqlComments(sql)));
}
