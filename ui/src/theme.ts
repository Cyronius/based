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
  /** Provenance note shown in the picker (e.g. "blabberstack"). */
  from?: string;
  tokens: ThemeTokens;
}

const SERIF = (f: string) => `'${f}', Georgia, serif`;
const SANS = (f: string) => `'${f}', system-ui, sans-serif`;
const MONO = (f: string) => `'${f}', ui-monospace, monospace`;

export const THEMES: ThemeDef[] = [
  // ── dark ──
  { id: "ledger", label: "Ledger", mode: "dark", fonts: [SERIF("Fraunces"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#101216", bg1: "#15181d", bg2: "#1a1e24", bg3: "#20252c", line: "#272d36", lineSoft: "#1f242c", text: "#e9e6de", textDim: "#c9c6bd", muted: "#8d929c", faint: "#5a606a", accent: "#d2a24c", ok: "#6fb47c", err: "#e0705f", info: "#7fa8c9" } },
  { id: "blueprint", label: "Blueprint", mode: "dark", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#0a0f1a", bg1: "#0e1524", bg2: "#131c30", bg3: "#1a2740", line: "#24314d", lineSoft: "#18223a", text: "#dce6f5", textDim: "#aebfdb", muted: "#7286a8", faint: "#45526e", accent: "#4fd0e0", ok: "#6fcf97", err: "#e06f7a", info: "#7fa8f0" } },
  { id: "phosphor", label: "Phosphor", mode: "dark", fonts: [MONO("Space Mono"), MONO("IBM Plex Mono"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#060a08", bg1: "#0a0f0c", bg2: "#0f1712", bg3: "#16211a", line: "#1e2b22", lineSoft: "#14201a", text: "#d6ead9", textDim: "#a5c7ac", muted: "#6f8f78", faint: "#46604e", accent: "#3bd16f", ok: "#63d68a", err: "#e2685f", info: "#5fb0a0" } },
  { id: "frost", label: "Frost", mode: "dark", fonts: [SANS("Hanken Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#1b2029", bg1: "#232a35", bg2: "#2b3341", bg3: "#353f4f", line: "#3b4557", lineSoft: "#2f3947", text: "#e5ecf4", textDim: "#c2ccd8", muted: "#8b96a5", faint: "#5c6675", accent: "#88c0d0", ok: "#a3be8c", err: "#bf616a", info: "#81a1c1" } },
  { id: "noir-violet", label: "Noir Violet", mode: "dark", fonts: [SERIF("Spectral"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#16131f", bg1: "#1d1929", bg2: "#262035", bg3: "#322a47", line: "#3a3152", lineSoft: "#2a2440", text: "#ece7f5", textDim: "#cbc2e0", muted: "#948aad", faint: "#605777", accent: "#c792ea", ok: "#8fd48a", err: "#e57b8d", info: "#82aaff" } },
  { id: "solarized-dark", label: "Solarized Dark", mode: "dark", fonts: [SERIF("Newsreader"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#00252e", bg1: "#002b36", bg2: "#073642", bg3: "#0d4a5a", line: "#0f4b5a", lineSoft: "#073642", text: "#eee8d5", textDim: "#93a1a1", muted: "#839496", faint: "#586e75", accent: "#b58900", ok: "#859900", err: "#dc322f", info: "#268bd2" } },
  { id: "oxblood", label: "Oxblood", mode: "dark", fonts: [SERIF("Fraunces"), SERIF("Spectral"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#17100f", bg1: "#1e1615", bg2: "#281c1b", bg3: "#342423", line: "#3d2b29", lineSoft: "#2a1e1d", text: "#efe4df", textDim: "#d3bfb8", muted: "#a08a84", faint: "#6b5651", accent: "#c85a4e", ok: "#9bb06a", err: "#d95c4e", info: "#c99a6a" } },
  { id: "copper-slate", label: "Copper Slate", mode: "dark", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#16181a", bg1: "#1c1f22", bg2: "#23272b", bg3: "#2c3237", line: "#333a40", lineSoft: "#262b30", text: "#e6e8ea", textDim: "#c3c7cb", muted: "#8b9298", faint: "#596066", accent: "#d08a5a", ok: "#7fb389", err: "#db6f64", info: "#7fa6c4" } },
  { id: "carbon", label: "Carbon", mode: "dark", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("Space Mono")],
    tokens: { bg0: "#0e0e0f", bg1: "#151517", bg2: "#1c1c1f", bg3: "#252529", line: "#2e2e33", lineSoft: "#202024", text: "#ededf0", textDim: "#c6c6cb", muted: "#8b8b92", faint: "#5a5a61", accent: "#ffb020", ok: "#57c07a", err: "#e5645a", info: "#6aa9e0" } },
  { id: "deep-sea", label: "Deep Sea", mode: "dark", fonts: [SERIF("Spectral"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#071016", bg1: "#0b171f", bg2: "#102028", bg3: "#172d38", line: "#1d3744", lineSoft: "#132833", text: "#d8ebf0", textDim: "#aecdd6", muted: "#71939e", faint: "#445e68", accent: "#33c4c8", ok: "#74cf9a", err: "#f0705c", info: "#6db4e0" } },
  { id: "chillwave", label: "Chillwave", mode: "dark", from: "blabberstack", fonts: [SANS("Audiowide"), SANS("Outfit"), MONO("JetBrains Mono")],
    tokens: { bg0: "#140823", bg1: "#1a0b2e", bg2: "#241041", bg3: "#2f1553", line: "#3d2352", lineSoft: "#251142", text: "#f3e6ff", textDim: "#cbb6e6", muted: "#9d84c0", faint: "#6b5590", accent: "#ff6ec7", ok: "#4fe0c0", err: "#ff5c8a", info: "#00f0ff" } },
  // ── light ──
  { id: "porcelain", label: "Porcelain", mode: "light", fonts: [SANS("Hanken Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#eef0f3", bg1: "#f8f9fb", bg2: "#eaedf1", bg3: "#dfe3e9", line: "#d3d8e0", lineSoft: "#e5e8ee", text: "#1e242c", textDim: "#3d4652", muted: "#6a7480", faint: "#98a1ad", accent: "#3a6ea5", ok: "#3f8a5a", err: "#c0503f", info: "#4f7fb0" } },
  { id: "solarized-light", label: "Solarized Light", mode: "light", fonts: [SERIF("Newsreader"), SANS("IBM Plex Sans"), MONO("IBM Plex Mono")],
    tokens: { bg0: "#eee8d5", bg1: "#fdf6e3", bg2: "#e7e0cc", bg3: "#dcd4bd", line: "#cfc8ad", lineSoft: "#e0d9c2", text: "#073642", textDim: "#586e75", muted: "#657b83", faint: "#93a1a1", accent: "#b58900", ok: "#859900", err: "#dc322f", info: "#268bd2" } },
  { id: "mint-ledger", label: "Mint Ledger", mode: "light", fonts: [SANS("Hanken Grotesk"), SANS("Hanken Grotesk"), MONO("JetBrains Mono")],
    tokens: { bg0: "#e6ede8", bg1: "#f2f7f3", bg2: "#dfe9e2", bg3: "#d1ded5", line: "#c3d3c8", lineSoft: "#dbe6df", text: "#1f2a24", textDim: "#3b4a41", muted: "#63756a", faint: "#93a598", accent: "#2f8f5f", ok: "#3f9a5f", err: "#c0503f", info: "#3d7f96" } },
  { id: "blush-slate", label: "Blush Slate", mode: "light", fonts: [SERIF("Fraunces"), SANS("IBM Plex Sans"), MONO("JetBrains Mono")],
    tokens: { bg0: "#ece7e7", bg1: "#f6f1f1", bg2: "#e6dfdf", bg3: "#dbd2d2", line: "#cec3c3", lineSoft: "#e0d8d8", text: "#2a2426", textDim: "#4a4144", muted: "#756a6d", faint: "#a1949a", accent: "#b05a72", ok: "#5c8a5c", err: "#bf5040", info: "#6a7fa5" } },
  { id: "newsprint", label: "Newsprint", mode: "light", fonts: [SANS("Space Grotesk"), SANS("IBM Plex Sans"), MONO("Space Mono")],
    tokens: { bg0: "#e8e8e6", bg1: "#f7f7f5", bg2: "#ebebe8", bg3: "#dededa", line: "#cfcfc9", lineSoft: "#e2e2dd", text: "#141414", textDim: "#33332f", muted: "#66665f", faint: "#98988f", accent: "#d21f22", ok: "#2f7d3f", err: "#d21f22", info: "#1f5fa1" } },
  { id: "cozy", label: "Cozy Reading Room", mode: "light", from: "blabberstack", fonts: [SERIF("Fraunces"), SERIF("Newsreader"), MONO("JetBrains Mono")],
    tokens: { bg0: "#ece2d0", bg1: "#f6efe3", bg2: "#fdf6ea", bg3: "#ecdcc7", line: "#e3d6c0", lineSoft: "#ede2cf", text: "#2a1f17", textDim: "#4a3a2c", muted: "#7c6553", faint: "#a89882", accent: "#b8553a", ok: "#5f7d3a", err: "#b5482f", info: "#3d6f96" } },
  { id: "tater", label: "Tater Dog", mode: "light", from: "blabberstack", fonts: [SANS("Quicksand"), SANS("Quicksand"), MONO("JetBrains Mono")],
    tokens: { bg0: "#bce0c8", bg1: "#ffffff", bg2: "#d6ecdd", bg3: "#e0c89a", line: "#2a2620", lineSoft: "#cfe0d4", text: "#1a1714", textDim: "#3f342a", muted: "#5a4632", faint: "#94836a", accent: "#7a4424", ok: "#3f7d4a", err: "#c0432b", info: "#3a6b8f" } },
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

export function currentThemeMode(): ThemeMode {
  return themeDef(currentId).mode;
}

// --- consumers that read the live variables back off the DOM ---

function readVar(name: string): string {
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
function mixHex(a: string, b: string, t: number): string {
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
