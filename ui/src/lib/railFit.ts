// Traces: BASED-UI-NARROW-LAYOUT — rails give way so the work column keeps WORK_MIN; saved widths never change.
export const WORK_MIN = 520;
export const STRIP = 36;
export const LEFT_MIN = 220;
export const RIGHT_MIN = 280;
export const CAPI_ROOM = 1200;

export interface RailInput {
  window: number;
  left: number;
  leftCollapsed: boolean;
  right: number;
  rightOpen: boolean;
  /** The rail the user expanded while the window was narrow; it collapses last. */
  keep?: "left" | "right";
}

export interface RailFit {
  left: number;
  leftCollapsed: boolean;
  right: number;
  rightCollapsed: boolean;
}

export function railFit(i: RailInput): RailFit {
  const room = i.window - WORK_MIN;
  const out: RailFit = {
    left: i.leftCollapsed ? STRIP : i.left,
    leftCollapsed: i.leftCollapsed,
    right: i.rightOpen ? i.right : STRIP,
    rightCollapsed: !i.rightOpen,
  };
  // Below CAPI_ROOM an open Capi steps the explorer aside, unless the user brought the explorer back.
  if (!out.rightCollapsed && !out.leftCollapsed && i.window < CAPI_ROOM && i.keep !== "left") {
    out.left = STRIP;
    out.leftCollapsed = true;
  }
  const fits = () => out.left + out.right <= room;
  if (fits()) return out;
  if (!out.rightCollapsed) out.right = Math.max(RIGHT_MIN, room - out.left);
  if (fits()) return out;
  if (!out.leftCollapsed) out.left = Math.max(LEFT_MIN, room - out.right);
  if (fits()) return out;

  const collapseRight = () => {
    out.right = STRIP;
    out.rightCollapsed = true;
    if (i.leftCollapsed) return;
    const left = Math.min(i.left, room - STRIP);
    out.leftCollapsed = left < LEFT_MIN;
    out.left = out.leftCollapsed ? STRIP : left;
  };
  if (i.keep === "left") {
    if (!out.rightCollapsed) collapseRight();
    return out;
  }
  if (!out.leftCollapsed) {
    out.left = STRIP;
    out.leftCollapsed = true;
    if (!out.rightCollapsed) out.right = Math.min(i.right, Math.max(RIGHT_MIN, room - STRIP));
  }
  if (fits() || i.keep === "right" || out.rightCollapsed) return out;
  collapseRight();
  return out;
}
