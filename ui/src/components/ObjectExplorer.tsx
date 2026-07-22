import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { DbObject, DbObjectType } from "../api/types";

const GROUPS: Array<{ type: DbObjectType; label: string; glyph: string }> = [
  { type: "table", label: "Tables", glyph: "▦" },
  { type: "view", label: "Views", glyph: "◫" },
  { type: "procedure", label: "Stored Procedures", glyph: "≡" },
  { type: "function", label: "Functions", glyph: "λ" },
];

export function ObjectExplorer() {
  const objects = useStore((s) => s.objects);
  const schemaFilter = useStore((s) => s.schemaFilter);
  const openTableTab = useStore((s) => s.openTableTab);
  const status = useStore((s) => s.status);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const grouped = useMemo(() => {
    const filtered = schemaFilter ? objects.filter((o) => o.schema === schemaFilter) : objects;
    const map = new Map<DbObjectType, DbObject[]>();
    for (const g of GROUPS) map.set(g.type, []);
    for (const o of filtered) map.get(o.type)?.push(o);
    return map;
  }, [objects, schemaFilter]);

  const displayName = (o: DbObject) => (schemaFilter ? o.name : `${o.schema}.${o.name}`);

  if (status !== "connected" && objects.length === 0) {
    return <div className="p-4 text-faint text-[12px] italic">No connection.</div>;
  }

  return (
    <div className="h-full overflow-y-auto py-1">
      {GROUPS.map((g) => {
        const items = grouped.get(g.type) ?? [];
        const isCollapsed = collapsed[g.type] ?? false;
        return (
          <section key={g.type}>
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-ink-900 group"
              onClick={() => setCollapsed({ ...collapsed, [g.type]: !isCollapsed })}
            >
              <span className={`text-faint text-[10px] transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
              <span className="ledger-label group-hover:text-muted">{g.label}</span>
              <span className="ml-auto text-[10px] font-mono text-faint">{items.length}</span>
            </button>
            {!isCollapsed &&
              items.map((o) => {
                const openable = o.type === "table" || o.type === "view";
                return (
                  <div
                    key={`${o.schema}.${o.name}`}
                    className={`flex items-center gap-2 pl-8 pr-3 py-[3px] text-[12px] text-paper-dim hover:bg-ink-900 hover:text-paper select-none ${
                      openable ? "cursor-pointer" : "cursor-default"
                    }`}
                    title={openable ? `${o.schema}.${o.name} — double-click for details` : `${o.schema}.${o.name}`}
                    onDoubleClick={() => {
                      if (openable) void openTableTab(o.schema, o.name, o.type as "table" | "view");
                    }}
                  >
                    <span className="text-faint text-[11px] w-3 text-center">{g.glyph}</span>
                    <span className="truncate font-mono text-[11.5px]">{displayName(o)}</span>
                  </div>
                );
              })}
          </section>
        );
      })}
    </div>
  );
}
