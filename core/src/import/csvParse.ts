// Traces: BASED-IMPORT-CSV-PARSE
// Hand-rolled streaming RFC-4180 parser — no dependency, mirroring the hand-rolled export side
// (export/csv.ts). push(chunk) yields completed rows; finish() flushes the last unterminated row.
// Quoted fields, "" escapes, embedded commas/newlines, CRLF/LF, and fields/rows spanning chunk
// boundaries (including mid-quote splits) are all handled; ragged rows are returned as-is (the
// import runner validates width).

export class CsvParser {
  private field = "";
  private row: string[] = [];
  private inQuotes = false;
  /** The previous char was a quote inside a quoted field — might be `""` or the closing quote. */
  private pendingQuote = false;
  /** Anything (even an empty field) has been seen for the current row. */
  private started = false;
  /** The previous char was \r outside quotes (swallow a following \n). */
  private pendingCr = false;

  push(chunk: string): string[][] {
    const rows: string[][] = [];
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;

      if (this.pendingCr) {
        this.pendingCr = false;
        if (ch === "\n") continue; // the \n of a CRLF — already handled at the \r
      }

      if (this.inQuotes) {
        if (this.pendingQuote) {
          this.pendingQuote = false;
          if (ch === '"') {
            this.field += '"'; // escaped quote
            continue;
          }
          this.inQuotes = false; // the quote closed the field — reprocess ch below
        } else if (ch === '"') {
          this.pendingQuote = true;
          continue;
        } else {
          this.field += ch;
          continue;
        }
      }

      if (ch === '"' && this.field === "") {
        // a quote at field start opens a quoted field
        this.inQuotes = true;
        this.started = true;
        continue;
      }
      if (ch === ",") {
        this.row.push(this.field);
        this.field = "";
        this.started = true;
        continue;
      }
      if (ch === "\n" || ch === "\r") {
        if (ch === "\r") this.pendingCr = true;
        if (this.started || this.field !== "" || this.row.length > 0) {
          this.row.push(this.field);
          rows.push(this.row);
        }
        this.field = "";
        this.row = [];
        this.started = false;
        continue;
      }
      this.field += ch;
      this.started = true;
    }
    return rows;
  }

  finish(): string[][] {
    // A dangling pendingQuote means the final quoted field ended at EOF — close it.
    if (this.pendingQuote) {
      this.inQuotes = false;
      this.pendingQuote = false;
    }
    if (this.started || this.field !== "" || this.row.length > 0) {
      this.row.push(this.field);
      const rows = [this.row];
      this.field = "";
      this.row = [];
      this.started = false;
      return rows;
    }
    return [];
  }
}

/** Convenience: parse a whole string at once. */
export function parseCsv(text: string): string[][] {
  const p = new CsvParser();
  return [...p.push(text), ...p.finish()];
}
