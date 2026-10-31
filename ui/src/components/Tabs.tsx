// Traces: BASED-UI-A11Y-KEYBOARD — the one look and key model for every view switch inside a pane;
// document tabs (TabStrip) and panel tabs (BottomTabPanel) keep their own top-bar style.
import { useRef, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  title?: string;
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
  label,
  className = "",
  fill = false,
}: {
  tabs: TabItem<T>[];
  value: T;
  onChange: (id: T) => void;
  label: string;
  className?: string;
  /** Tabs share the row's width equally. */
  fill?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = tabs.findIndex((t) => t.id === value);
    const next =
      e.key === "ArrowRight" ? (i + 1) % tabs.length
      : e.key === "ArrowLeft" ? (i - 1 + tabs.length) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    onChange(tabs[next]!.id);
    ref.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };
  return (
    <div ref={ref} role="tablist" aria-label={label} className={`flex items-stretch ${className}`} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            title={t.title}
            className={`${fill ? "flex-1 " : ""}whitespace-nowrap px-2.5 py-1 text-[length:var(--fs-sm)] border-b-2 ${
              active ? "border-brass text-brass font-bold" : "border-transparent text-muted hover:text-paper-dim"
            }`}
            onClick={() => onChange(t.id)}
          >
            {t.label}
          </button>
        );
      })}
    </div>
  );
}
