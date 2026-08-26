// Generic closable tab strip for the panel below a grid (Output + Cell in Query tabs, Cell alone in
// the Data tab). Renders nothing when there are no open tabs — the caller collapses the wrapping
// resizable Panel to match.
import type { ReactNode } from "react";
import { IconButton } from "./IconButton";
import { ChevronDownIcon } from "./icons";

export interface BottomTab {
  id: string;
  label: string;
  content: ReactNode;
}

export function BottomTabPanel({
  tabs,
  activeId,
  onActivate,
  onClose,
  onMinimize,
}: {
  tabs: BottomTab[];
  activeId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onMinimize?: () => void;
}) {
  if (tabs.length === 0) return null;
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div className="h-full flex flex-col bg-ink-950">
      <div className="flex items-stretch h-6 border-b border-line-soft shrink-0">
        {tabs.map((t) => (
          <div
            key={t.id}
            className={`flex items-center gap-1.5 pl-2.5 pr-1.5 border-r border-line-soft text-[length:var(--fs-sm)] cursor-pointer ${
              active.id === t.id
                ? "bg-ink-900 text-brass shadow-[inset_0_2px_0_var(--color-brass)]"
                : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
            }`}
            onClick={() => onActivate(t.id)}
          >
            <span>{t.label}</span>
            <IconButton
              size="sm"
              className="-mr-0.5 text-faint hover:text-paper"
              title={`Close ${t.label}`}
              aria-label={`Close ${t.label}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(t.id);
              }}
            >
              ✕
            </IconButton>
          </div>
        ))}
        <div className="flex-1" />
        {onMinimize && (
          <IconButton size="sm" className="self-center text-faint hover:text-paper" title="Minimize panel" aria-label="Minimize panel" onClick={onMinimize}>
            <ChevronDownIcon />
          </IconButton>
        )}
      </div>
      <div className="flex-1 min-h-0">{active.content}</div>
    </div>
  );
}
