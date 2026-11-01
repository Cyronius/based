// Traces: BASED-QUERY-ERROR-LINE — map engine error lines to lines of the submitted text.

/** DuckDB appends "LINE n:" to many errors; n counts lines of the whole script, not of the statement. */
export function duckErrorLine(message: string): number | null {
  return duckErrorPosition(message)?.line ?? null;
}

/** Line plus the 1-based column of DuckDB's ^ caret; no column when DuckDB cut the line short ("..."). */
export function duckErrorPosition(message: string): { line: number; column: number | null } | null {
  const m = /^(LINE (\d+): )(.*)\n( *)\^/m.exec(message);
  if (!m) {
    const bare = /^LINE (\d+):/m.exec(message);
    return bare ? { line: Number(bare[1]), column: null } : null;
  }
  const column = m[3]!.startsWith("...") ? null : m[4]!.length - m[1]!.length + 1;
  return { line: Number(m[2]), column: column != null && column >= 1 ? column : null };
}

/** First line of each `;`-separated statement; quotes and comments are skipped, empty statements dropped. */
export function statementStartLines(script: string): number[] {
  return statementStarts(script).map((s) => s.line);
}

/** Each statement's first line, and the character offset just after the `;` that ended the one before. */
export function statementStarts(script: string): Array<{ line: number; offset: number }> {
  const starts: Array<{ line: number; offset: number }> = [];
  let line = 1;
  let open = false;
  let afterSemi = 0;
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (c === "\n") {
      line++;
      continue;
    }
    if (c === "-" && script[i + 1] === "-") {
      while (i + 1 < script.length && script[i + 1] !== "\n") i++;
      continue;
    }
    if (c === "/" && script[i + 1] === "*") {
      i += 2;
      while (i < script.length && !(script[i] === "*" && script[i + 1] === "/")) {
        if (script[i] === "\n") line++;
        i++;
      }
      i++;
      continue;
    }
    if (c === ";") {
      open = false;
      afterSemi = i + 1;
      continue;
    }
    if (/\s/.test(c)) continue;
    if (!open) {
      starts.push({ line, offset: afterSemi });
      open = true;
    }
    if (c === "'" || c === '"') {
      i++;
      while (i < script.length && script[i] !== c) {
        if (script[i] === "\n") line++;
        i++;
      }
    }
  }
  return starts;
}
