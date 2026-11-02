// Traces: BASED-UI-A11Y-KEYBOARD
// Shared modal shell: dialog semantics, focus trap, initial focus, Esc, and focus return to the
// opener. Backdrop clicks close only when the caller says the dialog holds no in-progress input.
import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({
  title,
  onClose,
  closeOnBackdrop = true,
  initialFocus = "field",
  className = "w-[440px] max-h-[90vh] overflow-y-auto",
  z = "z-50",
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  /** False when the dialog holds input a stray click must not throw away. */
  closeOnBackdrop?: boolean;
  /** "field" focuses `[data-autofocus]` or the first field; "panel" focuses the dialog itself. */
  initialFocus?: "field" | "panel";
  /** Size and overflow utilities for the panel. */
  className?: string;
  z?: string;
  children: ReactNode;
}) {
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    if (panel) {
      const auto = panel.querySelector<HTMLElement>("[data-autofocus]");
      const field = panel.querySelector<HTMLElement>("input:not([disabled]), select:not([disabled]), textarea:not([disabled])");
      (initialFocus === "panel" ? panel : (auto ?? field ?? panel)).focus();
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== "Tab" || !panelRef.current) return;
      const items = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (e.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    // Capture phase, so Esc closes the dialog before any global shortcut handler sees it.
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      if (opener && document.contains(opener)) opener.focus();
    };
    // Mount-only: focus and the trap belong to this dialog instance, not to prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`fixed inset-0 ${z} grid place-items-center bg-black/60`}
      onMouseDown={(e) => closeOnBackdrop && e.target === e.currentTarget && onClose()}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className={`rounded-lg border border-line bg-ink-900 shadow-2xl shadow-black/50 fade-up focus:outline-none ${className}`}
      >
        <div className="px-5 pt-4 pb-3 border-b border-line-soft flex items-baseline justify-between gap-3 shrink-0">
          <h2 id={titleId} className="font-display text-lg text-paper">
            {title}
          </h2>
          <IconButton title="Close" aria-label="Close" className="text-faint hover:text-paper" onClick={onClose}>
            ✕
          </IconButton>
        </div>
        {children}
      </div>
    </div>
  );
}
