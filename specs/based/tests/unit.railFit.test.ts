// Traces: BASED-UI-NARROW-LAYOUT
import { describe, expect, test } from "bun:test";
import { railFit } from "../../../ui/src/lib/railFit";

const base = { left: 280, leftCollapsed: false, right: 384, rightOpen: true };

describe("BASED-UI-NARROW-LAYOUT railFit", () => {
  test("a wide window keeps both saved widths", () => {
    expect(railFit({ ...base, window: 1440 })).toEqual({ left: 280, leftCollapsed: false, right: 384, rightCollapsed: false });
  });

  test("at 1250px Capi shrinks to its minimum, then the explorer shrinks, so the work column keeps 520px", () => {
    expect(railFit({ ...base, left: 460, window: 1250 })).toEqual({ left: 450, leftCollapsed: false, right: 280, rightCollapsed: false });
  });

  test("below 1200px an open Capi collapses the explorer and keeps its own width", () => {
    expect(railFit({ ...base, window: 1024 })).toEqual({ left: 36, leftCollapsed: true, right: 384, rightCollapsed: false });
  });

  test("an explorer the user expanded after opening Capi stays open below 1200px", () => {
    expect(railFit({ ...base, window: 1100, keep: "left" })).toEqual({ left: 280, leftCollapsed: false, right: 300, rightCollapsed: false });
  });

  test("when the explorer would go below its minimum it collapses and Capi takes the room back", () => {
    expect(railFit({ ...base, window: 900 })).toEqual({ left: 36, leftCollapsed: true, right: 344, rightCollapsed: false });
  });

  test("when even that does not fit, Capi collapses last", () => {
    expect(railFit({ ...base, window: 760 })).toEqual({ left: 36, leftCollapsed: true, right: 36, rightCollapsed: true });
  });

  test("with Capi closed at 1024px the explorer keeps its width", () => {
    expect(railFit({ ...base, rightOpen: false, window: 1024 })).toEqual({ left: 280, leftCollapsed: false, right: 36, rightCollapsed: true });
  });

  test("an explorer the user expanded while narrow wins over Capi", () => {
    expect(railFit({ ...base, window: 900, keep: "left" })).toEqual({ left: 280, leftCollapsed: false, right: 36, rightCollapsed: true });
  });

  test("Capi the user expanded while narrow stays open even below 520px of work room", () => {
    expect(railFit({ ...base, window: 760, keep: "right" })).toEqual({ left: 36, leftCollapsed: true, right: 280, rightCollapsed: false });
  });

  test("a hand-collapsed explorer stays collapsed on a wide window", () => {
    expect(railFit({ ...base, leftCollapsed: true, window: 1440 }).leftCollapsed).toBe(true);
  });
});
