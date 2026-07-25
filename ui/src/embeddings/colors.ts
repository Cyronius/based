// Traces: BASED-EMBED-UI
// Theme-derived color system for the embeddings scatter. Reads the live CSS variables (same
// pattern as gridThemeFromCss) so every one of the app's themes tints the galaxy natively;
// recompute whenever the theme id changes.
import { mixHex, readVar } from "../theme";

export type Rgb = [number, number, number];

export interface EmbeddingColors {
  /** Canvas backdrop (bg0 — the deepest surface). */
  background: string;
  /** Cluster swatches, cycled when k exceeds the palette. */
  palette: Rgb[];
  paletteHex: string[];
  /** De-emphasized points (non-neighbours during find-similar, outside a lasso selection). */
  dim: Rgb;
  /** Selection / nearest-neighbour pop. */
  highlight: Rgb;
  accentHex: string;
  textHex: string;
}

function hexToRgb(hex: string): Rgb {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
}

/** Up to 12 distinct swatches from the four semantic hues (accent/info/ok/err), tiered toward the
 *  text and muted ramps so siblings stay distinguishable without leaving the theme's gamut. */
export function embeddingColors(): EmbeddingColors {
  const accent = readVar("--color-brass");
  const info = readVar("--color-info");
  const ok = readVar("--color-ok");
  const err = readVar("--color-err");
  const text = readVar("--color-paper");
  const muted = readVar("--color-muted");
  const bg0 = readVar("--color-ink-950");
  const bg1 = readVar("--color-ink-900");

  const bases = [accent, info, ok, err];
  const paletteHex: string[] = [
    ...bases,
    ...bases.map((b) => mixHex(b, text, 0.38)),
    ...bases.map((b) => mixHex(b, muted, 0.55)),
  ];
  return {
    background: bg0,
    palette: paletteHex.map(hexToRgb),
    paletteHex,
    dim: hexToRgb(mixHex(bg1, text, 0.22)),
    highlight: hexToRgb(accent),
    accentHex: accent,
    textHex: text,
  };
}
