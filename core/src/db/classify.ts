// Traces: BASED-AGENT-RUNQUERY
// Pure SQL classifier used to keep the agent's run_query tool read-only. Conservative by design:
// a false "not read-only" only costs the model a rejected tool call; a false "read-only" would let
// the agent mutate the database without the approval gate, so we err toward refusing.

/** Strip -- line comments and /* *\/ block comments. */
export function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n\r]*/g, " ");
}

/** Replace single/double-quoted string literals (with doubled-quote escapes) by empty strings so
 *  keywords appearing inside data ('DROP TABLE') are never mistaken for statements. */
export function stripStringLiterals(sql: string): string {
  return sql
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** Keywords that indicate a statement writes to the database or the server. `INTO` catches
 *  `SELECT ... INTO newtable`, which creates a table. */
const MUTATING = [
  "INSERT", "UPDATE", "DELETE", "MERGE", "UPSERT", "INTO",
  "DROP", "CREATE", "ALTER", "TRUNCATE", "RENAME",
  "EXEC", "EXECUTE",
  "GRANT", "REVOKE", "DENY",
  "BACKUP", "RESTORE", "BULK", "WRITETEXT", "UPDATETEXT",
];
const MUTATING_RE = new RegExp(`\\b(${MUTATING.join("|")})\\b`, "i");

/** First bare keyword of the statement, uppercased (after comments/strings/leading parens removed). */
export function firstKeyword(sql: string): string {
  const cleaned = stripStringLiterals(stripSqlComments(sql)).replace(/^[\s(;]+/, "");
  const m = cleaned.match(/^([A-Za-z_][A-Za-z0-9_]*)/);
  return m ? m[1]!.toUpperCase() : "";
}

/**
 * True only when the text is a pure read: it leads with SELECT or a WITH (CTE), and contains no
 * mutating keyword anywhere (a CTE can precede an INSERT/UPDATE/DELETE/MERGE). Anything else —
 * EXEC, DDL, DML, empty — is treated as not read-only.
 */
export function isReadOnly(sql: string): boolean {
  const first = firstKeyword(sql);
  if (first !== "SELECT" && first !== "WITH") return false;
  const cleaned = stripStringLiterals(stripSqlComments(sql));
  return !MUTATING_RE.test(cleaned);
}
