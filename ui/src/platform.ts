// Traces: BASED-UI-SHORTCUTS — platform-correct accelerators. One definition of "is this the
// shortcut modifier", so handlers and their advertised labels can never disagree per platform.

/** True in the macOS webview (WKWebView) and macOS browsers. */
export const isMac: boolean =
  typeof navigator !== "undefined" && /Mac|iP(hone|ad|od)/.test(navigator.platform || navigator.userAgent);

/** The platform shortcut modifier: ⌘ on macOS, Ctrl elsewhere. Mirrors Monaco's KeyMod.CtrlCmd. */
export function isAccel(e: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey;
}

/**
 * Format an advertised shortcut for the platform: `accel("Shift+S")` → `Ctrl+Shift+S` / `⇧⌘S`.
 * Tooltips must show the platform-correct accelerator (the discoverability rule), so every
 * user-visible shortcut string goes through here — never a hardcoded "Ctrl+…".
 */
export function accel(key: string): string {
  if (!isMac) return `Ctrl+${key}`;
  const shift = key.startsWith("Shift+");
  return `${shift ? "⇧" : ""}⌘${shift ? key.slice(6) : key}`;
}

/** The cancel-query chord: macOS keyboards have no Pause/Break key, so ⌘. (the macOS cancel
 *  convention) stands in. */
export const cancelLabel: string = isMac ? "⌘." : "Ctrl+Break";

export function isCancelChord(e: { key: string; ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac ? e.key === "." && e.metaKey : e.key === "Pause" && e.ctrlKey;
}
