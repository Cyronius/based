// Traces: BASED-QUERY-ERROR-LINE — map engine error lines to lines of the submitted text.

/** DuckDB appends "LINE n:" to many errors; n counts lines of the whole script, not of the statement. */
export function duckErrorLine(message: string): number | null {
  const m = /^LINE (\d+):/m.exec(message);
  return m ? Number(m[1]) : null;
}

/** First line of each `;`-separated statement; quotes and comments are skipped, empty statements dropped. */
export function statementStartLines(script: string): number[] {
  const starts: number[] = [];
  let line = 1;
  let open = false;
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
      continue;
    }
    if (/\s/.test(c)) continue;
    if (!open) {
      starts.push(line);
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
