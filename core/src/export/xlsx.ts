// Traces: BASED-EXPORT-XLSX
import ExcelJS from "exceljs";
import type { ColumnInfo, WireValue } from "../db/types";
import { cellText } from "./csv";

// Strip characters XML 1.0 forbids so they never reach sharedStrings.xml — otherwise Excel
// reports "Repaired Records: String properties from /xl/sharedStrings.xml part". ExcelJS already
// drops C0 controls, but writes lone surrogates and U+FFFE/FFFF raw, which corrupt the file.
// Tab/LF/CR are legal and preserved; valid surrogate pairs (emoji, CJK ext) are kept intact.
function xmlSafe(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) continue; // C0 controls but keep tab/LF/CR
    if (c === 0xfffe || c === 0xffff) continue; // noncharacters
    if (c >= 0xd800 && c <= 0xdbff) {
      // high surrogate: keep only when a low surrogate follows (a valid pair)
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i]! + s[i + 1]!;
        i++;
      }
      continue; // drop lone high surrogate
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue; // lone low surrogate
    out += s[i];
  }
  return out;
}

export async function writeXlsx(path: string, columns: ColumnInfo[], rows: WireValue[][]): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Results");
  const header = ws.addRow(columns.map((c) => c.name));
  header.font = { bold: true };
  for (const row of rows) {
    ws.addRow(
      row.map((v) => {
        if (v === null) return null;
        if (typeof v === "number" || typeof v === "boolean") return v;
        if (typeof v === "object") return xmlSafe(cellText(v));
        return xmlSafe(v);
      }),
    );
  }
  await wb.xlsx.writeFile(path);
}
