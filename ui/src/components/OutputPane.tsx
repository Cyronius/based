import { useEffect, useRef } from "react";
import type { QueryTabState } from "../store";

export function OutputPane({ tab }: { tab: QueryTabState }) {
  const listRef = useRef<HTMLDivElement>(null);
  const shown = useRef(0);

  // Traces: BASED-UI-OUTPUT — show the newest entry from its first line, so a long entry's headline stays in view.
  useEffect(() => {
    const from = tab.output.length < shown.current ? 0 : shown.current;
    const first = from < tab.output.length ? listRef.current?.children[from] : null;
    shown.current = tab.output.length;
    if (first instanceof HTMLElement && listRef.current) listRef.current.scrollTop = first.offsetTop;
  }, [tab.output.length]);

  return (
    <div className="h-full flex flex-col bg-ink-950">
      {tab.output.length === 0 && (
        <div className="px-3 py-1.5 font-mono text-[length:var(--fs-sm)]">
          {tab.running ? (
            <span className="text-muted pulse-soft">Executing…</span>
          ) : (
            <span className="text-faint italic">
              {tab.stats?.status === "error" ? "No server messages. Errors are in Results." : "No messages."}
            </span>
          )}
        </div>
      )}
      <div ref={listRef} className="relative flex-1 overflow-y-auto px-3 py-1.5 font-mono text-[length:var(--fs-sm)] leading-relaxed">
        {tab.output.map((line, i) => (
          <div
            key={i}
            className={`whitespace-pre-wrap break-words ${line.kind === "error" ? "text-err" : line.kind === "system" ? "text-brass" : "text-paper-dim"}`}
          >
            {line.text}
          </div>
        ))}
      </div>
    </div>
  );
}
