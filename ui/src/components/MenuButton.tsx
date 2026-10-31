// A button that opens a small action menu (role="menu"): arrows move, Enter runs, Esc closes and
// returns focus. The list is fixed-positioned so a scrolling toolbar never clips it.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface MenuAction {
  label: string;
  icon?: ReactNode;
  run: () => void;
  separatorBefore?: boolean;
  /** Shown but not runnable; arrow keys skip it. */
  disabled?: boolean;
  /** Second line under the label, e.g. why the item is disabled. */
  hint?: string;
}

const MENU_WIDTH = 200;
const ENABLED = '[role="menuitem"]:not([aria-disabled="true"])';

export function MenuButton({
  items,
  children,
  className = "",
  title,
  label,
}: {
  items: MenuAction[];
  children: ReactNode;
  className?: string;
  title?: string;
  /** Accessible name when the button shows only a glyph. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    setPos({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8)) });
    menuRef.current?.querySelector<HTMLElement>(ENABLED)?.focus();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !btnRef.current?.contains(t)) setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    const els = [...(menuRef.current?.querySelectorAll<HTMLElement>(ENABLED) ?? [])];
    const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close(true);
    } else if (e.key === "Tab") close(false);
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      els[(i + (e.key === "ArrowDown" ? 1 : els.length - 1)) % els.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      els[e.key === "Home" ? 0 : els.length - 1]?.focus();
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={className}
        title={title}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {children}
      </button>
      {open && (
        <div
          ref={menuRef}
          role="menu"
          className="fixed z-40 rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up py-1"
          style={{ top: pos.top, left: pos.left, width: MENU_WIDTH }}
          onKeyDown={onMenuKey}
        >
          {items.map((it) => (
            <div key={it.label}>
              {it.separatorBefore && <div className="my-1 border-t border-line-soft" />}
              <button
                type="button"
                role="menuitem"
                tabIndex={-1}
                aria-disabled={it.disabled || undefined}
                className={`w-full flex items-start gap-2 text-left px-3 py-1.5 text-[length:var(--fs-base)] ${
                  it.disabled ? "text-muted opacity-60 cursor-not-allowed" : "text-paper-dim hover:bg-ink-900 focus:bg-ink-900"
                }`}
                onClick={() => {
                  if (it.disabled) return;
                  close(true);
                  it.run();
                }}
              >
                <span className="w-4 shrink-0 grid place-items-center text-muted mt-0.5">{it.icon}</span>
                <span className="min-w-0">
                  {it.label}
                  {it.hint && <span className="block text-[length:var(--fs-sm)] text-muted">{it.hint}</span>}
                </span>
              </button>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
