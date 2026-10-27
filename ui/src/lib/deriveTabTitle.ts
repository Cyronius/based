// Traces: BASED-TAB-AUTONAME-DERIVE
// Derives a query-tab title ("verb object", e.g. "select Customers") from SQL text by
// tokenizing, not parsing: T-SQL AST parsers reject too much valid input (APPLY, hints,
// temp tables) to be the primary path, and a fallback heuristic would be needed anyway.
import { stripSqlComments, stripStringLiterals, tokenize, type Tok } from "./sqlText";

function isName(t: Tok | undefined): boolean {
  return !!t && (t.ident || /^[A-Za-z_@#$]/.test(t.v));
}

function kw(t: Tok | undefined): string {
  return t && !t.ident ? t.v.toUpperCase() : "";
}

/** Index just past the ")" matching the "(" at i (or end of input if unbalanced). */
function skipParens(toks: Tok[], i: number): number {
  let depth = 0;
  do {
    if (toks[i]!.v === "(") depth++;
    else if (toks[i]!.v === ")") depth--;
    i++;
  } while (i < toks.length && depth > 0);
  return i;
}

/** Reads a (possibly dotted, possibly bracketed) name chain and returns its last segment. */
function readName(toks: Tok[], i: number): string | null {
  if (!isName(toks[i])) return null;
  let last = toks[i]!.v;
  i++;
  while (toks[i]?.v === ".") {
    i++;
    while (toks[i]?.v === ".") i++; // db..table shorthand
    if (isName(toks[i])) {
      last = toks[i]!.v;
      i++;
    }
  }
  return last || null;
}

/** First depth-0 occurrence of keyword `word` at or after i; -1 if none. */
function findAtDepth0(toks: Tok[], i: number, word: string): number {
  let depth = 0;
  for (; i < toks.length; i++) {
    const v = toks[i]!.v;
    if (v === "(") depth++;
    else if (v === ")") depth--;
    else if (depth === 0 && kw(toks[i]) === word) return i;
  }
  return -1;
}

/** Noise between a DDL verb and the object it targets. */
const OBJECT_TYPE_WORDS = new Set([
  "TABLE", "VIEW", "PROC", "PROCEDURE", "FUNCTION", "INDEX", "TRIGGER", "SEQUENCE",
  "SYNONYM", "TYPE", "SCHEMA", "DATABASE", "LOG", "ROLE", "USER", "LOGIN",
  "UNIQUE", "CLUSTERED", "NONCLUSTERED", "COLUMNSTORE", "MATERIALIZED", "EXTERNAL",
  "PARTITION", "FULLTEXT", "XML", "SPATIAL", "STATISTICS", "OR", "IF", "EXISTS",
]);

/**
 * Deterministic tab title for the first statement in `sql`: "{verb} {object}" (verb
 * lowercased, object as written minus schema/brackets), "{verb}" when no object can be
 * found, or null when the text has no leading keyword (empty / comments only).
 */
export function deriveTabTitle(sql: string): string | null {
  let toks = tokenize(stripStringLiterals(stripSqlComments(sql)));

  // Leading statement separators / grouping parens don't start a statement.
  let start = 0;
  while (start < toks.length && (toks[start]!.v === ";" || toks[start]!.v === "(")) start++;
  toks = toks.slice(start);

  // First statement only: cut at a depth-0 ";" or GO batch separator.
  let depth = 0;
  for (let i = 0; i < toks.length; i++) {
    const v = toks[i]!.v;
    if (v === "(") depth++;
    else if (v === ")") depth--;
    else if (depth === 0 && (v === ";" || kw(toks[i]) === "GO")) {
      toks = toks.slice(0, i);
      break;
    }
  }

  let verb = kw(toks[0]);
  if (!verb) return null;
  let i = 1;

  if (verb === "WITH") {
    // Skip the CTE list: name [(cols)] AS (body) [, ...] — then the real verb follows.
    while (i < toks.length) {
      if (isName(toks[i])) i++; // cte name
      if (toks[i]?.v === "(") i = skipParens(toks, i); // optional column list
      if (kw(toks[i]) === "AS") i++;
      if (toks[i]?.v === "(") i = skipParens(toks, i); // cte body
      if (toks[i]?.v === ",") { i++; continue; }
      break;
    }
    verb = kw(toks[i]);
    if (!verb) return "with";
    i++;
  }

  let object: string | null = null;
  switch (verb) {
    case "SELECT":
    case "DELETE": {
      const from = findAtDepth0(toks, i, "FROM");
      if (from >= 0) object = readName(toks, from + 1);
      break;
    }
    case "INSERT":
    case "MERGE": {
      if (kw(toks[i]) === "INTO") i++;
      if (kw(toks[i]) === "TOP" && toks[i + 1]?.v === "(") i = skipParens(toks, i + 1);
      object = readName(toks, i);
      break;
    }
    case "UPDATE": {
      if (kw(toks[i]) === "TOP" && toks[i + 1]?.v === "(") i = skipParens(toks, i + 1);
      object = readName(toks, i);
      break;
    }
    case "EXEC":
    case "EXECUTE": {
      if (toks[i]?.v.startsWith("@") && toks[i + 1]?.v === "=") i += 2; // @ret = proc
      object = readName(toks, i);
      break;
    }
    case "CREATE":
    case "ALTER":
    case "DROP":
    case "TRUNCATE":
    case "BACKUP":
    case "RESTORE": {
      while (OBJECT_TYPE_WORDS.has(kw(toks[i]))) i++;
      object = readName(toks, i);
      break;
    }
  }

  return object ? `${verb.toLowerCase()} ${object}` : verb.toLowerCase();
}
