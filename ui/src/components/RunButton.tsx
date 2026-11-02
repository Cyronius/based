// One Run control for SQL, vector search, and Capi's chat SQL: green outline, play glyph.
import type { ButtonHTMLAttributes } from "react";

export function RunButton({
  className = "",
  size = "md",
  children = "Run",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { size?: "sm" | "md" }) {
  const box = size === "sm" ? "px-1.5 text-[length:var(--fs-sm)] leading-[1.6]" : "px-2.5 py-1 text-[length:var(--fs-base)]";
  return (
    <button
      type="button"
      className={`shrink-0 whitespace-nowrap rounded border border-ok/40 text-ok hover:bg-ok/10 disabled:opacity-35 disabled:hover:bg-transparent ${box} ${className}`}
      {...rest}
    >
      ▶ {children}
    </button>
  );
}
