import { useStore } from "../store";

export function TabStrip() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const activateTab = useStore((s) => s.activateTab);
  const closeTab = useStore((s) => s.closeTab);
  const newQueryTab = useStore((s) => s.newQueryTab);

  return (
    <div className="flex items-stretch h-9 border-b border-line-soft bg-ink-950 overflow-x-auto shrink-0">
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        const running = t.kind === "query" && t.running;
        const dirty = t.kind === "query" && t.dirty;
        return (
          <div
            key={t.id}
            className={`group flex items-center gap-2 px-3 border-r border-line-soft cursor-pointer max-w-56 select-none ${
              active ? "bg-ink-900 text-paper shadow-[inset_0_2px_0_var(--color-brass)]" : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
            }`}
            onClick={() => activateTab(t.id)}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.id);
            }}
            title={t.kind === "query" && t.filePath ? t.filePath : t.title}
          >
            {t.kind === "table" && <span className="text-faint text-[11px]">▦</span>}
            {running && <span className="size-1.5 rounded-full bg-brass pulse-soft shrink-0" />}
            <span className="truncate text-[12px]">
              {t.title}
              {dirty ? " •" : ""}
            </span>
            <button
              className="text-faint hover:text-err opacity-0 group-hover:opacity-100 transition-opacity text-[11px]"
              onClick={(e) => {
                e.stopPropagation();
                closeTab(t.id);
              }}
            >
              ✕
            </button>
          </div>
        );
      })}
      <button
        className="px-3 text-muted hover:text-brass text-base leading-none"
        title="New query tab"
        onClick={() => newQueryTab()}
      >
        +
      </button>
    </div>
  );
}
