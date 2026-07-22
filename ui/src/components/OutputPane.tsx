import { useEffect, useRef } from "react";
import type { QueryTabState } from "../store";

export function OutputPane({ tab }: { tab: QueryTabState }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [tab.output.length, tab.stats]);

  return (
    <div className="h-full flex flex-col bg-ink-950">
      <div className="px-3 py-1 border-b border-line-soft shrink-0 flex items-center gap-3">
        <span className="ledger-label">Output</span>
        {tab.stats && (
          <span
            className={`text-[11px] font-mono ${
              tab.stats.status === "ok" ? "text-ok" : tab.stats.status === "cancelled" ? "text-brass" : "text-err"
            }`}
          >
            {tab.stats.status} · {tab.stats.durationMs.toLocaleString()} ms
          </span>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-3 py-1.5 font-mono text-[11.5px] leading-relaxed">
        {tab.output.length === 0 && !tab.running && <span className="text-faint italic">No messages.</span>}
        {tab.running && tab.output.length === 0 && <span className="text-muted pulse-soft">Executing…</span>}
        {tab.output.map((line, i) => (
          <div
            key={i}
            className={line.kind === "error" ? "text-err" : line.kind === "system" ? "text-brass" : "text-paper-dim"}
          >
            {line.text}
          </div>
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}
