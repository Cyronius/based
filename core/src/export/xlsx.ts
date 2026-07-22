// Traces: BASED-EXPORT-XLSX
import ExcelJS from "exceljs";
import type { ColumnInfo, WireValue } from "../db/types";
import { cellText } from "./csv";

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
        if (typeof v === "object") return cellText(v);
        return v;
      }),
    );
  }
  await wb.xlsx.writeFile(path);
}
