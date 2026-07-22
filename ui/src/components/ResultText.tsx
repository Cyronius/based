import { useMemo } from "react";
import type { ResultSetData } from "../store";
import { cellText } from "../api/types";

const MAX_TEXT_ROWS = 2000;
const MAX_COL_WIDTH = 60;

export function ResultText({ rs, version }: { rs: ResultSetData; version: number }) {
  const text = useMemo(() => {
    const shown = rs.rows.slice(0, MAX_TEXT_ROWS);
    const cells = shown.map((row) => row.map((v) => (v === null ? "NULL" : typeof v === "object" ? cellText(v) : String(v))));
    const widths = rs.columns.map((c, i) =>
      Math.min(MAX_COL_WIDTH, Math.max(c.name.length, ...cells.map((r) => (r[i] ?? "").length), 4)),
    );
    const clip = (s: string, w: number) => (s.length > w ? s.slice(0, w - 1) + "…" : s.padEnd(w));
    const lines = [
      rs.columns.map((c, i) => clip(c.name, widths[i]!)).join("  "),
      widths.map((w) => "-".repeat(w)).join("  "),
      ...cells.map((r) => r.map((s, i) => clip(s, widths[i]!)).join("  ")),
    ];
    if (rs.rows.length > MAX_TEXT_ROWS) lines.push("", `… text view capped at ${MAX_TEXT_ROWS} rows (grid view shows all fetched rows)`);
    return lines.join("\n");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rs, version]);

  return (
    <pre className="h-full w-full overflow-auto px-3 py-2 font-mono text-[11.5px] leading-[1.5] text-paper-dim whitespace-pre">
      {text}
    </pre>
  );
}
