// Traces: BASED-THEME-FONT-LOAD — only the active theme's families are fetched, not every theme's.
import type { ThemeDef } from "../theme";

/** Google Fonts axis spec per family (the part after the name in a css2 `family=` value). */
export const FONT_SPECS: Record<string, string> = {
  "Alegreya Sans": ":wght@400;500;700",
  "Amiri": ":wght@400;700",
  "Anton": "",
  "Atkinson Hyperlegible": ":wght@400;700",
  "Audiowide": "",
  "Azeret Mono": ":wght@400;500;600;700",
  "Baloo 2": ":wght@400;500;600;700",
  "Bitter": ":wght@400;500;600;700",
  "Caprasimo": "",
  "Cormorant Garamond": ":wght@400;500;600;700",
  "Cousine": ":wght@400;700",
  "DM Serif Display": "",
  "Eczar": ":wght@400;500;600;700",
  "Fira Code": ":wght@400;500;600;700",
  "Fragment Mono": "",
  "Fraunces": ":ital,opsz,wght@0,9..144,300..700;1,9..144,300..700",
  "Hanken Grotesk": ":wght@400;500;600;700",
  "IBM Plex Mono": ":ital,wght@0,400;0,500;0,600;1,400",
  "IBM Plex Sans": ":wght@400;500;600",
  "Inconsolata": ":wght@400;500;600;700",
  "Instrument Sans": ":wght@400;500;600;700",
  "JetBrains Mono": ":wght@400;500;600",
  "Jost": ":wght@400;500;600;700",
  "Karla": ":wght@400;500;600;700",
  "Lora": ":wght@400;500;600;700",
  "M PLUS 1 Code": ":wght@400;500;600;700",
  "Manrope": ":wght@400;500;600;700",
  "Marcellus": "",
  "Mulish": ":wght@400;500;600;700",
  "Newsreader": ":opsz,wght@6..72,400..600",
  "Noto Serif JP": ":wght@400;500;600;700",
  "Orbitron": ":wght@400;500;600;700",
  "Oswald": ":wght@400;500;600;700",
  "Outfit": ":wght@300;400;500;600",
  "Overpass Mono": ":wght@400;500;600;700",
  "PT Mono": "",
  "Playfair Display": ":wght@400;500;600;700",
  "Quicksand": ":wght@400;500;600;700",
  "Rajdhani": ":wght@400;500;600;700",
  "Red Hat Mono": ":wght@400;500;600;700",
  "Righteous": "",
  "Rubik": ":wght@400;500;600;700",
  "Schibsted Grotesk": ":wght@400;500;600;700",
  "Shrikhand": "",
  "Sometype Mono": ":wght@400;500;600;700",
  "Source Sans 3": ":wght@400;500;600;700",
  "Space Grotesk": ":wght@400;500;600;700",
  "Space Mono": ":wght@400;700",
  "Spectral": ":wght@400;500;600",
  "Unbounded": ":wght@400;500;600;700",
  "VT323": "",
  "Varela Round": "",
  "Victor Mono": ":wght@400;500;600;700",
  "Zen Maru Gothic": ":wght@400;500;700",
  "Zilla Slab": ":wght@400;500;600;700",
};

/** Families index.html loads up front: the default theme's, so first paint never waits. */
export const BASE_FAMILIES = ["Fraunces", "IBM Plex Sans", "IBM Plex Mono"];

/** The family a CSS stack starts with, e.g. `'Space Mono', ui-monospace` → `Space Mono`. */
export function stackFamily(stack: string): string {
  return /^'([^']+)'/.exec(stack)?.[1] ?? stack.split(",")[0]!.trim();
}

/** css2 URL for the theme's families not already loaded by index.html; null when nothing is missing. */
export function themeFontUrl(theme: Pick<ThemeDef, "fonts">): string | null {
  const families = [...new Set(theme.fonts.map(stackFamily))].filter((f) => !BASE_FAMILIES.includes(f) && FONT_SPECS[f] != null);
  if (families.length === 0) return null;
  const q = families.map((f) => `family=${f.replace(/ /g, "+")}${FONT_SPECS[f]}`).join("&");
  return `https://fonts.googleapis.com/css2?${q}&display=swap`;
}
