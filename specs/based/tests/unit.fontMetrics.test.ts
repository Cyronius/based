// Traces: BASED-EDITOR-CARET-METRICS (canonical spec: specs/based/spec.md)
// Monaco caches one character width per font and paints the caret at column * charWidth. If the
// webfont is still downloading when it measures, the caret drifts from the text forever. These
// tests pin the scheduling contract that forces a remeasure at every moment the metrics can change.
import { describe, expect, test } from "bun:test";
import { createFontRemeasurer, fontSpec, primaryFamily, type FontFaceSetLike } from "../../../ui/src/fontMetrics";

class FakeFonts implements FontFaceSetLike {
  requested: string[] = [];
  rejectAll = false;
  private listeners = new Set<() => void>();

  load(font: string): Promise<unknown> {
    this.requested.push(font);
    return this.rejectAll ? Promise.reject(new Error("no such family")) : Promise.resolve([]);
  }
  addEventListener(_type: "loadingdone", listener: () => void): void {
    this.listeners.add(listener);
  }
  removeEventListener(_type: "loadingdone", listener: () => void): void {
    this.listeners.delete(listener);
  }
  emitLoadingDone(): void {
    for (const l of [...this.listeners]) l();
  }
  get listenerCount(): number {
    return this.listeners.size;
  }
}

/** Remeasurer plus a manual scheduler, so coalescing is observable instead of timing-dependent. */
function harness() {
  const fonts = new FakeFonts();
  let remeasures = 0;
  const queued: Array<() => void> = [];
  const r = createFontRemeasurer({
    fonts,
    remeasure: () => {
      remeasures += 1;
    },
    schedule: (run) => queued.push(run),
  });
  return {
    fonts,
    r,
    flush: () => {
      const runs = queued.splice(0);
      for (const run of runs) run();
    },
    count: () => remeasures,
  };
}

const MONO = "'Fragment Mono', ui-monospace, monospace";

describe("primaryFamily", () => {
  test("returns the first downloadable family, unquoted", () => {
    expect(primaryFamily(MONO)).toBe("Fragment Mono");
    expect(primaryFamily('"IBM Plex Mono", Consolas, monospace')).toBe("IBM Plex Mono");
    expect(primaryFamily("Consolas, monospace")).toBe("Consolas");
  });

  test("returns null when the stack is only generic families — nothing to download", () => {
    expect(primaryFamily("ui-monospace, monospace")).toBeNull();
    expect(primaryFamily("monospace")).toBeNull();
    expect(primaryFamily("SYSTEM-UI")).toBeNull();
    expect(primaryFamily("")).toBeNull();
    expect(primaryFamily("  , serif")).toBeNull();
  });
});

describe("fontSpec", () => {
  test("builds a FontFaceSet.load() shorthand at the editor's size", () => {
    expect(fontSpec(MONO, 13)).toBe('13px "Fragment Mono"');
    expect(fontSpec(MONO, 19.5)).toBe('19.5px "Fragment Mono"');
  });

  test("falls back to 13px for a nonsense size and null for a generic-only stack", () => {
    expect(fontSpec(MONO, 0)).toBe('13px "Fragment Mono"');
    expect(fontSpec(MONO, Number.NaN)).toBe('13px "Fragment Mono"');
    expect(fontSpec("ui-monospace, monospace", 13)).toBeNull();
  });
});

describe("createFontRemeasurer.ensure", () => {
  test("loads the exact font, then forces one remeasure", async () => {
    const h = harness();
    await h.r.ensure(MONO, 13);
    expect(h.fonts.requested).toEqual(['13px "Fragment Mono"']);
    expect(h.count()).toBe(1);
  });

  test("is idempotent per family+size — a re-render does not re-measure", async () => {
    const h = harness();
    await h.r.ensure(MONO, 13);
    await h.r.ensure(MONO, 13);
    await h.r.ensure(MONO, 13);
    expect(h.count()).toBe(1);
    expect(h.fonts.requested.length).toBe(1);
  });

  test("a theme swap to a different mono font measures again", async () => {
    const h = harness();
    await h.r.ensure("'IBM Plex Mono', ui-monospace, monospace", 13);
    await h.r.ensure(MONO, 13);
    expect(h.count()).toBe(2);
    expect(h.fonts.requested).toEqual(['13px "IBM Plex Mono"', '13px "Fragment Mono"']);
  });

  test("a font-size change measures again at the new size", async () => {
    const h = harness();
    await h.r.ensure(MONO, 13);
    await h.r.ensure(MONO, 19.5);
    expect(h.count()).toBe(2);
  });

  test("a generic-only stack needs no load and no remeasure — the fallback is the final font", async () => {
    const h = harness();
    await h.r.ensure("ui-monospace, monospace", 13);
    expect(h.fonts.requested).toEqual([]);
    expect(h.count()).toBe(0);
  });

  test("a failed load still remeasures instead of throwing", async () => {
    const h = harness();
    h.fonts.rejectAll = true;
    await h.r.ensure(MONO, 13);
    expect(h.count()).toBe(1);
  });

  test("after dispose, a pending ensure does not remeasure", async () => {
    const h = harness();
    const pending = h.r.ensure(MONO, 13);
    h.r.dispose();
    await pending;
    expect(h.count()).toBe(0);
  });
});

describe("createFontRemeasurer loadingdone subscription", () => {
  test("any font finishing on the page triggers a remeasure", () => {
    const h = harness();
    h.fonts.emitLoadingDone();
    h.flush();
    expect(h.count()).toBe(1);
  });

  test("a burst of loadingdone events coalesces into a single remeasure", () => {
    const h = harness();
    h.fonts.emitLoadingDone();
    h.fonts.emitLoadingDone();
    h.fonts.emitLoadingDone();
    h.flush();
    expect(h.count()).toBe(1);

    // ...and the next burst is measured again, not swallowed.
    h.fonts.emitLoadingDone();
    h.flush();
    expect(h.count()).toBe(2);
  });

  test("dispose unsubscribes — no remeasure after the editor is gone", () => {
    const h = harness();
    expect(h.fonts.listenerCount).toBe(1);
    h.r.dispose();
    expect(h.fonts.listenerCount).toBe(0);
    h.fonts.emitLoadingDone();
    h.flush();
    expect(h.count()).toBe(0);
  });
});
