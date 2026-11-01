// Traces: BASED-UI-NARROW-LAYOUT — saved rail widths plus the window width, shared so both rails fit together.
import { create } from "zustand";
import { useStore } from "./store";
import { railFit, type RailFit } from "./lib/railFit";

const LEFT_KEY = "based:leftRailWidth";
const RIGHT_KEY = "based:rightRailWidth";
const COLLAPSED_KEY = "based:explorerCollapsed";

export const LEFT_RANGE = { min: 220, max: 560, def: 288 };
export const RIGHT_RANGE = { min: 280, max: 720, def: 384 };

function load(key: string, r: { min: number; max: number; def: number }): number {
  const stored = Number(localStorage.getItem(key));
  return Number.isFinite(stored) && stored >= r.min && stored <= r.max ? stored : r.def;
}

interface RailLayout {
  left: number;
  right: number;
  explorerCollapsed: boolean;
  keep: "left" | "right" | undefined;
  windowWidth: number;
  setLeft(w: number): void;
  setRight(w: number): void;
  setExplorerCollapsed(c: boolean): void;
  setKeep(k: "left" | "right" | undefined): void;
}

export const useRailLayout = create<RailLayout>((set) => ({
  left: load(LEFT_KEY, LEFT_RANGE),
  right: load(RIGHT_KEY, RIGHT_RANGE),
  explorerCollapsed: localStorage.getItem(COLLAPSED_KEY) === "1",
  keep: undefined,
  windowWidth: window.innerWidth,
  setLeft(w) {
    localStorage.setItem(LEFT_KEY, String(w));
    set({ left: w });
  },
  setRight(w) {
    localStorage.setItem(RIGHT_KEY, String(w));
    set({ right: w });
  },
  setExplorerCollapsed(c) {
    localStorage.setItem(COLLAPSED_KEY, c ? "1" : "0");
    set({ explorerCollapsed: c });
  },
  setKeep(keep) {
    set({ keep });
  },
}));

window.addEventListener("resize", () => useRailLayout.setState({ windowWidth: window.innerWidth }));

function fitOf(l: RailLayout, rightOpen: boolean): RailFit {
  return railFit({ window: l.windowWidth, left: l.left, leftCollapsed: l.explorerCollapsed, right: l.right, rightOpen, keep: l.keep });
}

export function useRailFit(): RailFit {
  const l = useRailLayout();
  const rightOpen = useStore((s) => s.rightRailOpen);
  return fitOf(l, rightOpen);
}

/** Ctrl+J and the rail's own buttons: an open-by-choice rail squeezed shut is expanded, not closed. */
export function toggleCapi(): void {
  const store = useStore.getState();
  const layout = useRailLayout.getState();
  const shown = !fitOf(layout, store.rightRailOpen).rightCollapsed;
  if (store.rightRailOpen && shown) {
    store.toggleRightRail();
    return;
  }
  layout.setKeep("right");
  if (!store.rightRailOpen) store.toggleRightRail();
}
