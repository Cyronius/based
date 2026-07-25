// Traces: BASED-THEME
// Single source of truth for the app's visual themes. Each theme is a token set that is applied by
// writing CSS custom properties onto <html> (so Tailwind v4 utilities like `bg-ink-900` / `text-brass`
// retint at runtime) plus the shadcn-style tokens Streamdown reads. Monaco and the Glide grids read the
// *computed* variables back off the DOM (gridThemeFromCss / syncMonacoTheme) so they always match.
//
// Adding or removing a theme is a data edit here — no CSS duplication.
import type { Theme as GridTheme } from "@glideapps/glide-data-grid";

type Monaco = typeof import("monaco-editor");

export type ThemeMode = "dark" | "light";

export interface ThemeTokens {
  bg0: string; // deepest surface — rails, gutters, footer
  bg1: string; // editor / main panel
  bg2: string; // raised — titlebar, headers
  bg3: string; // hover / selection
  line: string;
  lineSoft: string;
  text: string;
  textDim: string;
  muted: string;
  faint: string;
  accent: string;
  ok: string;
  err: string;
  info: string;
}

export interface ThemeDef {
  id: string;
  label: string;
  mode: ThemeMode;
  /** [display, sans, mono] CSS font stacks. */
  fonts: [string, string, string];
  /** Picker grouping override. "midtone" themes use color-scheme "dark" (mode) but are surfaced
   *  in their own group — backgrounds sit mid-luminance instead of near-black or near-white. */
  tone?: "midtone";
  tokens: ThemeTokens;
}

const SERIF = (f: string) => `'${f}', Georgia, serif`;
const SANS = (f: string) => `'${f}', system-ui, sans-serif`;
const MONO = (f: string) => `'${f}', ui-monospace, monospace`;

export const THEMES: ThemeDef[] = [
  // ── dark ──
  { id: "ledger", label: "Ledger", mode: "dark", fonts: [SERIF("Fraunces"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#101216", bg1: "#15181d", bg2: "#1a1e24", bg3: "#20252c", line: "#272d36", lineSoft: "#1f242c", text: "#e9e6de", textDim: "#c9c6bd", muted: "#8e939d", faint: "#6e7582", accent: "#d2a24c", ok: "#6fb47c", err: "#e0705f", info: "#7fa8c9" } },
  { id: "blueprint", label: "Blueprint", mode: "dark", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#0a0f1a", bg1: "#0e1524", bg2: "#131c30", bg3: "#1a2740", line: "#24314d", lineSoft: "#18223a", text: "#dce6f5", textDim: "#aebfdb", muted: "#7c8fae", faint: "#65789f", accent: "#4fd0e0", ok: "#6fcf97", err: "#e06f7a", info: "#7fa8f0" } },
  { id: "phosphor", label: "Phosphor", mode: "dark", fonts: [MONO("Space Mono"), MONO("IBM Plex Mono"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#060a08", bg1: "#0a0f0c", bg2: "#0f1712", bg3: "#16211a", line: "#1e2b22", lineSoft: "#14201a", text: "#d6ead9", textDim: "#a5c7ac", muted: "#6f9078", faint: "#577761", accent: "#3bd16f", ok: "#63d68a", err: "#e2685f", info: "#5fb0a0" } },
  { id: "frost", label: "Frost", mode: "dark", fonts: [SANS("Hanken Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#1b2029", bg1: "#232a35", bg2: "#2b3341", bg3: "#353f4f", line: "#3b4557", lineSoft: "#2f3947", text: "#e5ecf4", textDim: "#c2ccd8", muted: "#a2abb7", faint: "#8791a1", accent: "#88c0d0", ok: "#a3be8c", err: "#bf616a", info: "#81a1c1" } },
  { id: "noir-violet", label: "Noir Violet", mode: "dark", fonts: [SERIF("Spectral"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#16131f", bg1: "#1d1929", bg2: "#262035", bg3: "#322a47", line: "#3a3152", lineSoft: "#2a2440", text: "#ece7f5", textDim: "#cbc2e0", muted: "#9b92b2", faint: "#83799d", accent: "#c792ea", ok: "#8fd48a", err: "#e57b8d", info: "#82aaff" } },
  { id: "solarized-dark", label: "Solarized Dark", mode: "dark", fonts: [SERIF("Newsreader"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#00252e", bg1: "#002b36", bg2: "#073642", bg3: "#0d4a5a", line: "#0f4b5a", lineSoft: "#073642", text: "#eee8d5", textDim: "#93a1a1", muted: "#a7b3b4", faint: "#839ba2", accent: "#b58900", ok: "#859900", err: "#dc322f", info: "#268bd2" } },
  { id: "oxblood", label: "Oxblood", mode: "dark", fonts: [SERIF("Fraunces"), SERIF("Spectral"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#17100f", bg1: "#1e1615", bg2: "#281c1b", bg3: "#342423", line: "#3d2b29", lineSoft: "#2a1e1d", text: "#efe4df", textDim: "#d3bfb8", muted: "#a18b85", faint: "#8d716b", accent: "#c85a4e", ok: "#9bb06a", err: "#d95c4e", info: "#c99a6a" } },
  { id: "copper-slate", label: "Copper Slate", mode: "dark", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#16181a", bg1: "#1c1f22", bg2: "#23272b", bg3: "#2c3237", line: "#333a40", lineSoft: "#262b30", text: "#e6e8ea", textDim: "#c3c7cb", muted: "#93999f", faint: "#7a838b", accent: "#d08a5a", ok: "#7fb389", err: "#db6f64", info: "#7fa6c4" } },
  { id: "carbon", label: "Carbon", mode: "dark", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("Space Mono")],
    tokens: { bg0: "#0e0e0f", bg1: "#151517", bg2: "#1c1c1f", bg3: "#252529", line: "#2e2e33", lineSoft: "#202024", text: "#ededf0", textDim: "#c6c6cb", muted: "#8b8b92", faint: "#75757e", accent: "#ffb020", ok: "#57c07a", err: "#e5645a", info: "#6aa9e0" } },
  { id: "deep-sea", label: "Deep Sea", mode: "dark", fonts: [SERIF("Spectral"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#071016", bg1: "#0b171f", bg2: "#102028", bg3: "#172d38", line: "#1d3744", lineSoft: "#132833", text: "#d8ebf0", textDim: "#aecdd6", muted: "#7596a1", faint: "#5c7f8c", accent: "#33c4c8", ok: "#74cf9a", err: "#f0705c", info: "#6db4e0" } },
  { id: "chillwave", label: "Chillwave", mode: "dark", fonts: [SANS("Audiowide"), SANS("Outfit"), MONO("JetBrains Mono")],
    tokens: { bg0: "#140823", bg1: "#1a0b2e", bg2: "#241041", bg3: "#2f1553", line: "#3d2352", lineSoft: "#251142", text: "#f3e6ff", textDim: "#cbb6e6", muted: "#9e86c1", faint: "#816aa7", accent: "#ff6ec7", ok: "#4fe0c0", err: "#ff5c8a", info: "#00f0ff" } },
  // ── midtone ── (between light and dark: mid-luminance backgrounds, tinted not neutral, high
  // foreground contrast — comfortable in both bright and dim rooms)
  { id: "slate-noon", label: "Slate Noon", mode: "dark", tone: "midtone", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#363b42", bg1: "#40464e", bg2: "#4b525b", bg3: "#575e68", line: "#626a74", lineSoft: "#4b525b", text: "#f2f4f6", textDim: "#c7ccd2", muted: "#d4d7db", faint: "#b4b9bd", accent: "#5fb0e8", ok: "#7fc98a", err: "#e2776a", info: "#7fb0e0" } },
  { id: "terracotta-dusk", label: "Terracotta Dusk", mode: "dark", tone: "midtone", fonts: [SERIF("Fraunces"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#423731", bg1: "#4d4139", bg2: "#594c42", bg3: "#66584c", line: "#6b5b4d", lineSoft: "#524438", text: "#f7ede2", textDim: "#d9c2ac", muted: "#dad1c8", faint: "#c0b2a5", accent: "#e2793f", ok: "#8fbf6a", err: "#e2705f", info: "#7fa8c9" } },
  { id: "moss-fog", label: "Moss Fog", mode: "dark", tone: "midtone", fonts: [SERIF("Newsreader"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#363f34", bg1: "#414a3e", bg2: "#4c5648", bg3: "#576352", line: "#576352", lineSoft: "#46503f", text: "#eef2e8", textDim: "#c4cfba", muted: "#d6dbd1", faint: "#b7beaf", accent: "#7bc25c", ok: "#7bc25c", err: "#d97a63", info: "#7fa8c9" } },
  { id: "graphite-ember", label: "Graphite Ember", mode: "dark", tone: "midtone", fonts: [SERIF("Spectral"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#332d28", bg1: "#3d3630", bg2: "#47403a", bg3: "#524a42", line: "#5c5045", lineSoft: "#453c34", text: "#f5efe6", textDim: "#d3c3ae", muted: "#c6b9ac", faint: "#b09e8c", accent: "#e8a33d", ok: "#8fbf6a", err: "#d97361", info: "#7fa0c4" } },
  { id: "concrete-violet", label: "Concrete Violet", mode: "dark", tone: "midtone", fonts: [SANS("Space Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#3a3742", bg1: "#45414d", bg2: "#504c59", bg3: "#5c5765", line: "#665f74", lineSoft: "#4d495a", text: "#f1eff6", textDim: "#cbc6d6", muted: "#d2cfd9", faint: "#b4b1be", accent: "#a97fe0", ok: "#7fc98a", err: "#e2776a", info: "#8ea3f0" } },
  { id: "sandstone-teal", label: "Sandstone Teal", mode: "dark", tone: "midtone", fonts: [SANS("Hanken Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#423b2e", bg1: "#4d4536", bg2: "#584f3f", bg3: "#635948", line: "#6b5e48", lineSoft: "#524836", text: "#f6efe1", textDim: "#d6c7a9", muted: "#d9d1c4", faint: "#bfb3a0", accent: "#35b0a4", ok: "#8fbf6a", err: "#d9704f", info: "#6fa8c0" } },
  { id: "blue-hour", label: "Blue Hour", mode: "dark", tone: "midtone", fonts: [SERIF("Fraunces"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#2f3648", bg1: "#394153", bg2: "#434c5f", bg3: "#4e576b", line: "#576285", lineSoft: "#414b68", text: "#eef1fa", textDim: "#c3cbe0", muted: "#c7ccdb", faint: "#a9afc4", accent: "#8ea3f0", ok: "#7fc9a0", err: "#e07f7f", info: "#8ea3f0" } },
  { id: "clay-ash", label: "Clay Ash", mode: "dark", tone: "midtone", fonts: [SERIF("Newsreader"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#3e3230", bg1: "#493c39", bg2: "#544642", bg3: "#60504b", line: "#6b5651", lineSoft: "#52423e", text: "#f5e9e5", textDim: "#d6bcb5", muted: "#d2c4c1", faint: "#bba7a3", accent: "#7ba36b", ok: "#7ba36b", err: "#d9705a", info: "#7fa0c4" } },
  { id: "rosewood", label: "Rosewood", mode: "dark", tone: "midtone", fonts: [SERIF("Fraunces"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#3d3034", bg1: "#483a3e", bg2: "#544349", bg3: "#604c53", line: "#6b535a", lineSoft: "#4f4046", text: "#f5e9ec", textDim: "#d6bcc2", muted: "#cec0c3", faint: "#b7a4a8", accent: "#c25a75", ok: "#8fbf6a", err: "#d9705f", info: "#7fa0c4" } },
  { id: "coastal-slate", label: "Coastal Slate", mode: "dark", tone: "midtone", fonts: [SERIF("Zilla Slab"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#2e3a3c", bg1: "#384547", bg2: "#425052", bg3: "#4d5c5e", line: "#576769", lineSoft: "#414f51", text: "#e9f2f2", textDim: "#c0d0d0", muted: "#c8d2d2", faint: "#a7b6b7", accent: "#4fb0a0", ok: "#4fb0a0", err: "#e2776a", info: "#7fa0c4" } },
  { id: "radium-bloom", label: "Radium Bloom", mode: "dark", tone: "midtone", fonts: [SANS("Audiowide"), SANS("Outfit"), MONO("JetBrains Mono")],
    tokens: { bg0: "#3d1046", bg1: "#4f1659", bg2: "#631d6e", bg3: "#7a2686", line: "#9236a0", lineSoft: "#6e2079", text: "#fdf0ff", textDim: "#e3b8f0", muted: "#d3b0dd", faint: "#b597bf", accent: "#ccff00", ok: "#00e6a0", err: "#ff2d6b", info: "#00e5ff" } },
  // ── light ──
  { id: "porcelain", label: "Porcelain", mode: "light", fonts: [SANS("Hanken Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#eef0f3", bg1: "#f8f9fb", bg2: "#eaedf1", bg3: "#dfe3e9", line: "#d3d8e0", lineSoft: "#e5e8ee", text: "#1e242c", textDim: "#3d4652", muted: "#5e6671", faint: "#6f7b8b", accent: "#3a6ea5", ok: "#3f8a5a", err: "#c0503f", info: "#4f7fb0" } },
  { id: "solarized-light", label: "Solarized Light", mode: "light", fonts: [SERIF("Newsreader"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#eee8d5", bg1: "#fdf6e3", bg2: "#e7e0cc", bg3: "#dcd4bd", line: "#cfc8ad", lineSoft: "#e0d9c2", text: "#073642", textDim: "#586e75", muted: "#4e5f65", faint: "#647373", accent: "#b58900", ok: "#859900", err: "#dc322f", info: "#268bd2" } },
  { id: "mint-ledger", label: "Mint Ledger", mode: "light", fonts: [SANS("Hanken Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#e6ede8", bg1: "#f2f7f3", bg2: "#dfe9e2", bg3: "#d1ded5", line: "#c3d3c8", lineSoft: "#dbe6df", text: "#1f2a24", textDim: "#3b4a41", muted: "#54635a", faint: "#667a6c", accent: "#2f8f5f", ok: "#3f9a5f", err: "#c0503f", info: "#3d7f96" } },
  { id: "blush-slate", label: "Blush Slate", mode: "light", fonts: [SERIF("Fraunces"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#ece7e7", bg1: "#f6f1f1", bg2: "#e6dfdf", bg3: "#dbd2d2", line: "#cec3c3", lineSoft: "#e0d8d8", text: "#2a2426", textDim: "#4a4144", muted: "#62585b", faint: "#7a6b72", accent: "#b05a72", ok: "#5c8a5c", err: "#bf5040", info: "#6a7fa5" } },
  { id: "newsprint", label: "Newsprint", mode: "light", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("Space Mono")],
    tokens: { bg0: "#e8e8e6", bg1: "#f7f7f5", bg2: "#ebebe8", bg3: "#dededa", line: "#cfcfc9", lineSoft: "#e2e2dd", text: "#141414", textDim: "#33332f", muted: "#62625b", faint: "#78786e", accent: "#d21f22", ok: "#2f7d3f", err: "#d21f22", info: "#1f5fa1" } },
  { id: "cozy", label: "Cozy Reading Room", mode: "light", fonts: [SERIF("Fraunces"), SERIF("Newsreader"), MONO("JetBrains Mono")],
    tokens: { bg0: "#ece2d0", bg1: "#f6efe3", bg2: "#fdf6ea", bg3: "#ecdcc7", line: "#e3d6c0", lineSoft: "#ede2cf", text: "#2a1f17", textDim: "#4a3a2c", muted: "#735d4d", faint: "#86755d", accent: "#b8553a", ok: "#5f7d3a", err: "#b5482f", info: "#3d6f96" } },
  { id: "tater", label: "Tater Dog", mode: "light", fonts: [SANS("Quicksand"), SANS("Quicksand"), MONO("JetBrains Mono")],
    tokens: { bg0: "#bce0c8", bg1: "#ffffff", bg2: "#d6ecdd", bg3: "#e0c89a", line: "#2a2620", lineSoft: "#cfe0d4", text: "#1a1714", textDim: "#3f342a", muted: "#594531", faint: "#756854", accent: "#7a4424", ok: "#3f7d4a", err: "#c0432b", info: "#3a6b8f" } },
  { id: "marigold", label: "Marigold", mode: "light", fonts: [SANS("Manrope"), SANS("Manrope"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#f2e9c8", bg1: "#fbf6e2", bg2: "#eee0ad", bg3: "#e3d18e", line: "#d3bb6c", lineSoft: "#e8d9a2", text: "#2b2308", textDim: "#4a3d14", muted: "#6a582a", faint: "#7e6d43", accent: "#d9821f", ok: "#4f8a4f", err: "#c04a3a", info: "#3d7f96" } },
  { id: "coral-reef", label: "Coral Reef", mode: "light", fonts: [SANS("Hanken Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#dcece8", bg1: "#eefaf6", bg2: "#d2e7e1", bg3: "#bfdad2", line: "#a6c9be", lineSoft: "#cbe2da", text: "#16241f", textDim: "#33453d", muted: "#4b6058", faint: "#5a776a", accent: "#d9634a", ok: "#3f9a6f", err: "#d9634a", info: "#2f9aa0" } },
  { id: "wheatfield", label: "Wheatfield", mode: "light", fonts: [SERIF("Zilla Slab"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#e9dfc4", bg1: "#f7efd9", bg2: "#e0d1a4", bg3: "#d4bf85", line: "#c2a862", lineSoft: "#dccb96", text: "#26200f", textDim: "#473c1f", muted: "#594e2e", faint: "#6f6241", accent: "#a3701f", ok: "#4f8a4f", err: "#bf503f", info: "#3d7f96" } },
  { id: "lilac-frost", label: "Lilac Frost", mode: "light", fonts: [SERIF("Fraunces"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#e9e4ee", bg1: "#f8f5fb", bg2: "#e1dbec", bg3: "#d3c9e3", line: "#c0b0d6", lineSoft: "#ddd3ea", text: "#211c2b", textDim: "#423a4e", muted: "#5b536c", faint: "#75658b", accent: "#7a4fb0", ok: "#4f8a5f", err: "#bf5060", info: "#4f6fb0" } },
];

export const THEME_IDS = THEMES.map((t) => t.id);
export const DEFAULT_THEME_ID = "ledger";
const byId = new Map(THEMES.map((t) => [t.id, t]));

export function themeDef(id: string): ThemeDef {
  return byId.get(id) ?? byId.get(DEFAULT_THEME_ID)!;
}

/** The token → CSS custom property mapping consumed by Tailwind utilities. */
function writeVars(el: HTMLElement, t: ThemeDef): void {
  const k = t.tokens;
  const s = el.style;
  s.setProperty("--color-ink-950", k.bg0);
  s.setProperty("--color-ink-900", k.bg1);
  s.setProperty("--color-ink-850", k.bg2);
  s.setProperty("--color-ink-800", k.bg3);
  s.setProperty("--color-line", k.line);
  s.setProperty("--color-line-soft", k.lineSoft);
  s.setProperty("--color-paper", k.text);
  s.setProperty("--color-paper-dim", k.textDim);
  s.setProperty("--color-muted", k.muted);
  s.setProperty("--color-faint", k.faint);
  s.setProperty("--color-brass", k.accent);
  s.setProperty("--color-brass-soft", `color-mix(in srgb, ${k.accent} 74%, #000)`);
  s.setProperty("--color-ok", k.ok);
  s.setProperty("--color-err", k.err);
  s.setProperty("--color-info", k.info);

  s.setProperty("--font-display", t.fonts[0]);
  s.setProperty("--font-sans", t.fonts[1]);
  s.setProperty("--font-mono", t.fonts[2]);

  // shadcn-style tokens (Streamdown markdown components read these).
  s.setProperty("--background", k.bg1);
  s.setProperty("--foreground", k.text);
  s.setProperty("--card", k.bg2);
  s.setProperty("--card-foreground", k.text);
  s.setProperty("--popover", k.bg2);
  s.setProperty("--popover-foreground", k.text);
  s.setProperty("--muted", k.bg3);
  s.setProperty("--muted-foreground", k.muted);
  s.setProperty("--secondary", k.bg3);
  s.setProperty("--secondary-foreground", k.text);
  s.setProperty("--accent", k.bg3);
  s.setProperty("--accent-foreground", k.text);
  s.setProperty("--border", k.line);
  s.setProperty("--input", k.line);
  s.setProperty("--ring", k.accent);
  s.setProperty("--primary", k.accent);
  s.setProperty("--primary-foreground", k.bg0);

  s.setProperty("color-scheme", t.mode);
  el.dataset.theme = t.id;
}

const THEME_HINT_KEY = "based.theme";
let currentId = DEFAULT_THEME_ID;

/** Apply a theme by writing its tokens onto <html>. Also caches the id in localStorage as a
 *  first-paint hint so the next launch renders correctly before the server value loads. */
export function applyTheme(id: string): void {
  const t = themeDef(id);
  currentId = t.id;
  writeVars(document.documentElement, t);
  try {
    localStorage.setItem(THEME_HINT_KEY, t.id);
  } catch {
    // private mode / storage disabled — server persistence still holds
  }
}

/** The cached first-paint hint (used by main.tsx before React mounts). */
export function themeHint(): string {
  try {
    return localStorage.getItem(THEME_HINT_KEY) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

const FONT_SCALE_HINT_KEY = "based.fontScale";
export const DEFAULT_FONT_SCALE = 1;

/** Apply the app-wide font-size multiplier by writing --font-scale onto <html>. Also caches it in
 *  localStorage as a first-paint hint, mirroring applyTheme/themeHint. */
export function applyFontScale(scale: number): void {
  document.documentElement.style.setProperty("--font-scale", String(scale));
  try {
    localStorage.setItem(FONT_SCALE_HINT_KEY, String(scale));
  } catch {
    // private mode / storage disabled — server persistence still holds
  }
}

/** The cached first-paint hint (used by main.tsx before React mounts). */
export function fontScaleHint(): number {
  try {
    const raw = localStorage.getItem(FONT_SCALE_HINT_KEY);
    const n = raw == null ? NaN : Number(raw);
    return Number.isFinite(n) ? n : DEFAULT_FONT_SCALE;
  } catch {
    return DEFAULT_FONT_SCALE;
  }
}

export function currentThemeMode(): ThemeMode {
  return themeDef(currentId).mode;
}

// --- consumers that read the live variables back off the DOM ---

export function readVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Build a Glide grid theme from the current CSS variables. Recompute whenever the theme changes. */
export function gridThemeFromCss(): Partial<GridTheme> {
  const accent = readVar("--color-brass");
  return {
    accentColor: accent,
    accentLight: `${accent}22`,
    bgCell: readVar("--color-ink-900"),
    bgCellMedium: readVar("--color-ink-850"),
    bgHeader: readVar("--color-ink-850"),
    bgHeaderHasFocus: readVar("--color-ink-800"),
    bgHeaderHovered: readVar("--color-ink-800"),
    textDark: readVar("--color-paper"),
    textMedium: readVar("--color-muted"),
    textLight: readVar("--color-faint"),
    textHeader: readVar("--color-muted"),
    borderColor: readVar("--color-line"),
    horizontalBorderColor: readVar("--color-line-soft"),
    drilldownBorder: readVar("--color-line"),
    linkColor: readVar("--color-info"),
    cellHorizontalPadding: 8,
    cellVerticalPadding: 3,
    headerFontStyle: "600 11px",
    baseFontStyle: "12px",
    fontFamily: readVar("--font-mono"),
  };
}

/** Mix two #rrggbb colors: `t` is the weight of `b` (0 → all a, 1 → all b). Returns concrete hex so
 *  the Glide canvas never has to parse color-mix() itself. */
export function mixHex(a: string, b: string, t: number): string {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [ar, ag, ab] = p(a);
  const [br, bg, bb] = p(b);
  const c = (x: number, y: number) => Math.round(x + (y - x) * t).toString(16).padStart(2, "0");
  return `#${c(ar!, br!)}${c(ag!, bg!)}${c(ab!, bb!)}`;
}

/** Per-cell overrides for the editable data grid (dirty / new / null), derived from the theme. */
export function gridCellOverrides(): {
  dirty: Partial<GridTheme>;
  fresh: Partial<GridTheme>;
  nullText: string;
} {
  const cell = readVar("--color-ink-900");
  const accent = readVar("--color-brass");
  const ok = readVar("--color-ok");
  return {
    dirty: { bgCell: mixHex(cell, accent, 0.14), textDark: accent },
    fresh: { bgCell: mixHex(cell, ok, 0.14), textDark: ok },
    nullText: readVar("--color-faint"),
  };
}

/** Define/refresh the Monaco "based" theme from the current CSS variables and make it active. */
export function syncMonacoTheme(m: Monaco): void {
  const hex = (name: string) => readVar(name).replace("#", "");
  const withHash = (name: string) => readVar(name);
  const accent = hex("--color-brass");
  m.editor.defineTheme("based", {
    base: currentThemeMode() === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [
      { token: "keyword.sql", foreground: accent },
      { token: "keyword", foreground: accent },
      { token: "string.sql", foreground: hex("--color-ok") },
      { token: "string", foreground: hex("--color-ok") },
      { token: "number", foreground: hex("--color-info") },
      { token: "comment", foreground: hex("--color-faint"), fontStyle: "italic" },
      { token: "operator.sql", foreground: hex("--color-paper-dim") },
      { token: "predefined.sql", foreground: hex("--color-info") },
    ],
    colors: {
      "editor.background": withHash("--color-ink-900"),
      "editor.foreground": withHash("--color-paper"),
      "editor.lineHighlightBackground": withHash("--color-ink-850"),
      "editorLineNumber.foreground": withHash("--color-faint"),
      "editorLineNumber.activeForeground": withHash("--color-muted"),
      "editorCursor.foreground": withHash("--color-brass"),
      "editor.selectionBackground": `${withHash("--color-brass")}33`,
      "editorIndentGuide.background1": withHash("--color-ink-800"),
      "editorWidget.background": withHash("--color-ink-850"),
      "editorWidget.border": withHash("--color-line"),
      "input.background": withHash("--color-ink-950"),
      "scrollbarSlider.background": `${withHash("--color-ink-800")}80`,
      "scrollbarSlider.hoverBackground": withHash("--color-line"),
    },
  });
  m.editor.setTheme("based");
}

/** The current mono font stack (for editor fontFamily updates). */
export function monoFont(): string {
  return readVar("--font-mono");
}
