// Traces: BASED-UI-READONLY-MIRROR, BASED-TAB-AUTONAME-DERIVE, BASED-RUN-SCOPE
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

const GO_LINE = /^[ \t]*go[ \t]*(?:--[^\n\r]*)?$/i;
const NOT_BLOCK_AFTER_BEGIN = new Set(["TRAN", "TRANSACTION", "DISTRIBUTED", "DIALOG", "CONVERSATION"]);

/** BASED-RUN-SCOPE: character spans of each statement, split at depth-0 `;` and at GO
 *  lines. Strings, [identifiers], and comments are skipped; BEGIN/CASE…END count as depth so a
 *  `;` inside a procedure body does not split it. Each span ends just past its `;`. */
function statementSpans(sql: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  let start = 0;
  let paren = 0;
  let block = 0;
  let i = 0;
  let lineStart = true;
  const n = sql.length;
  while (i < n) {
    if (lineStart) {
      const eol = sql.slice(i).search(/\r?\n|$/);
      const line = sql.slice(i, i + eol);
      if (GO_LINE.test(line)) {
        spans.push({ start, end: i });
        i += eol;
        start = i;
        paren = 0;
        block = 0;
        continue;
      }
      lineStart = false;
    }
    const c = sql[i]!;
    const next = sql[i + 1];
    if (c === "\n") {
      lineStart = true;
      i++;
    } else if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close < 0 ? n : close + 2;
    } else if (c === "'" || c === '"' || c === "[") {
      const closeCh = c === "[" ? "]" : c;
      i++;
      while (i < n) {
        if (sql[i] === closeCh) {
          if (sql[i + 1] === closeCh) i += 2;
          else break;
        } else i++;
      }
      i++;
    } else if (c === "(") {
      paren++;
      i++;
    } else if (c === ")") {
      paren = Math.max(0, paren - 1);
      i++;
    } else if (c === ";") {
      i++;
      if (paren === 0 && block === 0) {
        spans.push({ start, end: i });
        start = i;
      }
    } else if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_@#$]*/.exec(sql.slice(i, i + 128))!;
      const word = m[0].toUpperCase();
      i += m[0].length;
      if (word === "CASE") block++;
      else if (word === "END") block = Math.max(0, block - 1);
      else if (word === "BEGIN") {
        const after = /^\s*([A-Za-z_]+)/.exec(sql.slice(i, i + 64))?.[1]?.toUpperCase() ?? "";
        if (!NOT_BLOCK_AFTER_BEGIN.has(after)) block++;
      }
    } else i++;
  }
  spans.push({ start, end: n });
  return spans;
}

function isBlank(text: string): boolean {
  return stripSqlComments(text).trim() === "";
}

/** The statement the cursor at `offset` belongs to, trimmed of surrounding whitespace, or null when
 *  the text has no statement. A cursor just past a `;` belongs to that statement; a cursor in a
 *  blank stretch belongs to the next statement, or to the previous one at the end of the text. */
export function statementAt(sql: string, offset: number): { start: number; end: number } | null {
  const spans = statementSpans(sql);
  let idx = spans.findIndex((s) => offset >= s.start && offset <= s.end);
  if (idx < 0) idx = spans.length - 1;
  // Trailing spaces after a `;` on the same line still belong to that statement.
  if (idx > 0 && /^[ \t]*$/.test(sql.slice(spans[idx]!.start, offset))) idx--;
  const pick = (k: number) => (k >= 0 && k < spans.length && !isBlank(sql.slice(spans[k]!.start, spans[k]!.end)) ? k : -1);
  let chosen = pick(idx);
  for (let k = idx + 1; chosen < 0 && k < spans.length; k++) chosen = pick(k);
  for (let k = idx - 1; chosen < 0 && k >= 0; k--) chosen = pick(k);
  if (chosen < 0) return null;
  const span = spans[chosen]!;
  const text = sql.slice(span.start, span.end);
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  return { start: span.start + lead, end: span.end - trail };
}
