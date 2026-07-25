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
}: ButtonHTMLAttributes<HTMLButtonElement> & { size?: "sm" | "md" }) {
  const box = size === "sm" ? "h-6 w-6 text-[length:var(--fs-sm)]" : "h-7 w-7";
  return (
    <button
      type="button"
      className={`grid place-items-center shrink-0 rounded ${box} hover:bg-ink-800/70 disabled:opacity-40 disabled:hover:bg-transparent transition ${className}`}
      {...rest}
    />
  );
}
