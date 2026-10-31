// Traces: BASED-THEME-CONTRAST
// Secondary text (muted, faint) sits at 10–12px all over the app, so it needs WCAG AA body contrast
// (4.5:1) on every surface it is drawn on. A theme edit that drops below is otherwise silent.
import { describe, expect, test } from "bun:test";
import { THEMES } from "../../../ui/src/theme";

function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("BASED-THEME-CONTRAST: muted and faint text reach 4.5:1", () => {
  for (const theme of THEMES) {
    test(theme.id, () => {
      const t = theme.tokens;
      for (const surface of ["bg0", "bg1", "bg2"] as const) {
        expect(contrast(t.faint, t[surface])).toBeGreaterThanOrEqual(4.5);
        expect(contrast(t.muted, t[surface])).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

// Traces: BASED-FOCUS-VISIBLE — the focus ring is drawn in the accent color; WCAG non-text contrast is 3:1.
describe("BASED-FOCUS-VISIBLE: the focus ring reaches 3:1", () => {
  for (const theme of THEMES) {
    test(theme.id, () => {
      const t = theme.tokens;
      for (const surface of ["bg0", "bg1", "bg2"] as const) {
        expect(contrast(t.accent, t[surface])).toBeGreaterThanOrEqual(3);
      }
    });
  }
});
