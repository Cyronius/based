// Traces: BASED-THEME-FONT-LOAD
import { describe, expect, test } from "bun:test";
import { THEMES, themeDef } from "../../../ui/src/theme";
import { BASE_FAMILIES, FONT_SPECS, stackFamily, themeFontUrl } from "../../../ui/src/lib/themeFonts";

describe("BASED-THEME-FONT-LOAD themeFontUrl", () => {
  test("every theme family has a Google Fonts spec, so no theme silently falls back", () => {
    const missing = THEMES.flatMap((t) => t.fonts.map(stackFamily)).filter((f) => !BASE_FAMILIES.includes(f) && FONT_SPECS[f] == null);
    expect(missing).toEqual([]);
  });

  test("the default theme needs no extra stylesheet", () => {
    expect(themeFontUrl(themeDef("ledger"))).toBeNull();
  });

  test("a theme asks only for its own non-base families, once each", () => {
    const url = themeFontUrl({ fonts: ["'Space Grotesk', system-ui, sans-serif", "'IBM Plex Sans', system-ui, sans-serif", "'JetBrains Mono', ui-monospace, monospace"] });
    expect(url).toBe("https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap");
  });
});
