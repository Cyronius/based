import type { ButtonHTMLAttributes } from "react";

// Project standard for any icon/emoji-only control (close ✕, gear, edit ✎, chevrons…): a square,
// ~28px clickable box with the glyph centered, so the whole button is the hit target — not just the
// glyph. Pass color/hover-color utilities via className (e.g. "text-faint hover:text-err"); the box,
// centering, rounded corners, subtle hover fill, and disabled dimming come baked in.
// Buttons with a visible text label are regular <button>s and don't use this.
export function IconButton({
  className = "",
  size = "md",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { size?: "sm" | "md" | "bar" }) {
  // "bar" matches the text buttons in grid toolbars (see controlH in GridToolbarActions).
  const box =
    size === "sm" ? "h-6 w-6 text-[length:var(--fs-sm)]"
    : size === "bar" ? "h-[calc(var(--fs-md)*1.5_+_10px)] w-[26px] border border-line"
    : "h-7 w-7";
  return (
    <button
      type="button"
      className={`grid place-items-center shrink-0 rounded ${box} hover:bg-ink-800/70 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-brass disabled:opacity-40 disabled:hover:bg-transparent transition ${className}`}
      {...rest}
    />
  );
}
