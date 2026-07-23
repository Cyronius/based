// Traces: BASED-UI-EXPLORER (manual)
import { useMemo, useState } from "react";
import { useStore } from "../store";
import type { DbObject, DbObjectType } from "../api/types";
import { engineOf } from "../api/types";

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
  const openRoutineTab = useStore((s) => s.openRoutineTab);
  const status = useStore((s) => s.status);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const connections = useStore((s) => s.connections);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const activeConn = connections.find((c) => c.id === activeConnectionId);
  const engine = activeConn ? engineOf(activeConn) : "mssql";
  const groups = engine === "mssql" ? GROUPS : GROUPS.filter((g) => g.type === "table");

  const grouped = useMemo(() => {
    const filtered = engine === "mssql" && schemaFilter ? objects.filter((o) => o.schema === schemaFilter) : objects;
    const map = new Map<DbObjectType, DbObject[]>();
    for (const g of groups) map.set(g.type, []);
    for (const o of filtered) map.get(o.type)?.push(o);
    return map;
  }, [objects, schemaFilter, engine, groups]);

  const displayName = (o: DbObject) =>
    engine === "mssql" ? (schemaFilter ? o.name : `${o.schema}.${o.name}`) : o.schema ? `${o.schema}/${o.name}` : o.name;

  if (status !== "connected" && objects.length === 0) {
    return <div className="p-4 text-faint text-[length:var(--fs-base)] italic">No connection.</div>;
  }

  return (
    <div className="h-full overflow-y-auto py-1">
      {groups.map((g) => {
        const items = grouped.get(g.type) ?? [];
        const isCollapsed = collapsed[g.type] ?? false;
        return (
          <section key={g.type}>
            <button
              className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-ink-900 group"
              onClick={() => setCollapsed({ ...collapsed, [g.type]: !isCollapsed })}
            >
              <span className={`text-faint text-[length:var(--fs-xs)] transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
              <span className="ledger-label group-hover:text-muted">{g.label}</span>
              <span className="ml-auto text-[length:var(--fs-xs)] font-mono text-faint">{items.length}</span>
            </button>
            {!isCollapsed &&
              items.map((o) => {
                return (
                  <div
                    key={`${o.schema}.${o.name}`}
                    className="flex items-center gap-2 pl-8 pr-3 py-[3px] text-[length:var(--fs-base)] text-paper-dim hover:bg-ink-900 hover:text-paper select-none cursor-pointer"
                    title={`${displayName(o)} — double-click for details`}
                    onDoubleClick={() => {
                      if (o.type === "table" || o.type === "view") void openTableTab(o.schema, o.name, o.type);
                      else void openRoutineTab(o.schema, o.name, o.type);
                    }}
                  >
                    <span className="text-faint text-[length:var(--fs-sm)] w-3 text-center">{g.glyph}</span>
                    <span className="truncate font-mono text-[length:var(--fs-sm)]">{displayName(o)}</span>
                  </div>
                );
              })}
          </section>
        );
      })}
    </div>
  );
}
