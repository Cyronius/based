// Shared content-aware column sizing for DataGrid (ResultGrid + TableDataGrid). Samples currently
// loaded rows via the grid's own getCellContent and measures the rendered text with the same canvas
// primitive glide-data-grid uses internally, so widths track what's actually drawn.
import { measureTextCached, type GridCell, type Item } from "@glideapps/glide-data-grid";

/** Auto-fit default only — never a hard cap on manual resize. Anything still cut off past this is
 *  covered by the hover tooltip. */
export const GRID_COL_MIN_WIDTH = 72;
export const GRID_COL_MAX_WIDTH = 400;

const AUTOFIT_SAMPLE_ROWS = 500;

let sharedCtx: CanvasRenderingContext2D | null = null;

/** A single canvas context reused across every grid instance/recompute — measureTextCached itself
 *  caches by (text, font), so this just avoids allocating a canvas per call. */
export function measureCtx(): CanvasRenderingContext2D {
  if (!sharedCtx) {
    sharedCtx = document.createElement("canvas").getContext("2d")!;
  }
  return sharedCtx;
}

export interface AutoFitColumn {
  id: string;
  title: string;
}

export interface AutoFitOptions {
  /** Max rows to sample per column (default 500) — result/page sizes are already capped near this. */
  sampleRows?: number;
  headerFont: string;
  bodyFont: string;
  /** theme.cellHorizontalPadding — applied on both sides of the measured text. */
  horizontalPadding: number;
  min?: number;
  max?: number;
  /** Columns the caller already has a manual width for — skipped, not measured. */
  skipIds?: ReadonlySet<string>;
}

function displayText(cell: GridCell): string {
  return "displayData" in cell && typeof cell.displayData === "string" ? cell.displayData : "";
}

/** Content-aware default widths for `columns`, keyed by column id. */
export function computeAutoFitWidths(
  columns: readonly AutoFitColumn[],
  rowCount: number,
  getCellContent: (item: Item) => GridCell,
  opts: AutoFitOptions,
): Record<string, number> {
  const ctx = measureCtx();
  const sampleRows = Math.min(rowCount, opts.sampleRows ?? AUTOFIT_SAMPLE_ROWS);
  const min = opts.min ?? GRID_COL_MIN_WIDTH;
  const max = opts.max ?? GRID_COL_MAX_WIDTH;
  const padding = opts.horizontalPadding * 2;
  const widths: Record<string, number> = {};

  columns.forEach((col, colIndex) => {
    if (opts.skipIds?.has(col.id)) return;
    let widest = measureTextCached(col.title, ctx, opts.headerFont).width;
    for (let row = 0; row < sampleRows; row++) {
      const text = displayText(getCellContent([colIndex, row]));
      if (!text) continue;
      const w = measureTextCached(text, ctx, opts.bodyFont).width;
      if (w > widest) widest = w;
    }
    widths[col.id] = Math.min(max, Math.max(min, Math.ceil(widest + padding)));
  });

  return widths;
}
