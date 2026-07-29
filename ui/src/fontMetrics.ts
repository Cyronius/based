// Traces: BASED-EDITOR-CARET-METRICS
// Monaco measures one fixed character width for its `fontFamily` and paints the caret at
// `column * charWidth`. That measurement is taken synchronously — at editor creation and again on
// `updateOptions({ fontFamily })` — so if the webfont hasn't downloaded yet, Monaco measures the
// *fallback* and never corrects itself once the real font swaps in. The caret then sits a fraction
// of a character off per column: text appears to land after the caret, and End/Home can't fix it
// because the model position was right all along — only the painting is wrong.
//
// The cure is `monaco.editor.remeasureFonts()`, fired at every moment the metrics can change:
//   1. explicitly, whenever the editor is pointed at a font stack (creation, theme swap, font-size
//      change) — we await that exact font's load first;
//   2. defensively, whenever *any* font finishes loading on the page (`loadingdone`), which covers
//      fonts pulled in by something other than the editor.
//
// This module holds no DOM or Monaco references so the scheduling logic is unit-testable; the
// FontFaceSet and the remeasure callback are injected.

/** The slice of `document.fonts` (FontFaceSet) this module needs. */
export interface FontFaceSetLike {
  load(font: string): Promise<unknown>;
  addEventListener(type: "loadingdone", listener: () => void): void;
  removeEventListener(type: "loadingdone", listener: () => void): void;
}

export interface FontRemeasurerDeps {
  fonts: FontFaceSetLike;
  /** Called when Monaco's cached character metrics may be stale. */
  remeasure: () => void;
  /** Coalescing hook for the `loadingdone` burst (a theme picker rendering 40 previews fires it
   *  many times over). Defaults to a microtask. */
  schedule?: (run: () => void) => void;
}

export interface FontRemeasurer {
  /** Load the first real family in `stack` at `sizePx`, then force one remeasure. Idempotent per
   *  (family, size): repeat calls after the first successful one are no-ops. */
  ensure(stack: string, sizePx: number): Promise<void>;
  dispose(): void;
}

/** CSS generic families — never downloaded, so there is nothing to wait for. */
const GENERIC_FAMILIES = new Set([
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "ui-rounded",
  "math",
  "emoji",
  "fangsong",
  "inherit",
  "initial",
  "revert",
  "unset",
]);

/** The first *downloadable* family in a CSS font stack, or null when the stack is all generics.
 *  `"'Fragment Mono', ui-monospace, monospace"` → `Fragment Mono`. */
export function primaryFamily(stack: string): string | null {
  const first = stack.split(",")[0]?.trim() ?? "";
  const unquoted = first.replace(/^['"]|['"]$/g, "").trim();
  if (!unquoted) return null;
  return GENERIC_FAMILIES.has(unquoted.toLowerCase()) ? null : unquoted;
}

/** A `FontFaceSet.load()` shorthand for the stack's primary family, or null when there is no
 *  downloadable family (nothing to await). */
export function fontSpec(stack: string, sizePx: number): string | null {
  const family = primaryFamily(stack);
  if (!family) return null;
  const size = Number.isFinite(sizePx) && sizePx > 0 ? sizePx : 13;
  return `${size}px "${family.replace(/["\\]/g, "\\$&")}"`;
}

export function createFontRemeasurer(deps: FontRemeasurerDeps): FontRemeasurer {
  const schedule = deps.schedule ?? ((run: () => void) => void Promise.resolve().then(run));
  const measured = new Set<string>();
  let disposed = false;
  let pending = false;

  const onLoadingDone = () => {
    if (disposed || pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      if (!disposed) deps.remeasure();
    });
  };
  deps.fonts.addEventListener("loadingdone", onLoadingDone);

  return {
    async ensure(stack, sizePx) {
      const spec = fontSpec(stack, sizePx);
      // All-generic stack: the fallback Monaco measured *is* the final font. Nothing to correct.
      if (!spec || disposed || measured.has(spec)) return;
      try {
        await deps.fonts.load(spec);
      } catch {
        // Unknown/unparseable family — remeasure anyway; the fallback in use may itself have
        // settled since Monaco measured.
      }
      if (disposed) return;
      measured.add(spec);
      deps.remeasure();
    },
    dispose() {
      disposed = true;
      deps.fonts.removeEventListener("loadingdone", onLoadingDone);
    },
  };
}
