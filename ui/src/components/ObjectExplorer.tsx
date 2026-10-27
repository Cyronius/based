// Traces: BASED-UI-EXPLORER (manual), BASED-UI-SCRIPT-AS (multi-select + Script as),
//         BASED-EXPLORER-ACTION (settings-driven double-click)
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "../store";
import type { DbObject, DbObjectType } from "../api/types";
import { profileFor } from "../lib/engineProfile";
import { ExplorerContextMenu } from "./ExplorerContextMenu";
import { IconButton } from "./IconButton";

const GROUPS: Array<{ type: DbObjectType; label: string; glyph: string }> = [
  { type: "table", label: "Tables", glyph: "▦" },
  { type: "view", label: "Views", glyph: "◫" },
  { type: "procedure", label: "Stored Procedures", glyph: "≡" },
  { type: "function", label: "Functions", glyph: "λ" },
];

const keyOf = (o: DbObject) => `${o.type}:${o.schema}.${o.name}`;

export function ObjectExplorer() {
  const objects = useStore((s) => s.objects);
  const schemaFilter = useStore((s) => s.schemaFilter);
  const openTableTab = useStore((s) => s.openTableTab);
  const openRoutineTab = useStore((s) => s.openRoutineTab);
  const scriptObjects = useStore((s) => s.scriptObjects);
  const capabilities = useStore((s) => s.capabilities);
  const explorerTableAction = useStore((s) => s.explorerTableAction);
  const explorerRoutineAction = useStore((s) => s.explorerRoutineAction);
  const status = useStore((s) => s.status);
  const activeConnectionId = useStore((s) => s.activeConnectionId);
  const connections = useStore((s) => s.connections);
  const engines = useStore((s) => s.engines);
  const setNewTableOpen = useStore((s) => s.setNewTableOpen);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Traces: BASED-UI-SCRIPT-AS — selection is type-homogeneous: plain click selects one, ctrl
  // toggles, shift ranges within the anchor's group; clicking another group's row resets.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [anchor, setAnchor] = useState<{ type: DbObjectType; index: number } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  const activeConn = connections.find((c) => c.id === activeConnectionId);
  // Traces: BASED-ENGINE-PROFILE-WIRE — tree shape comes from the engine's namespace profile:
  // "typed" groups tables/views/procedures/functions, "flat" is one list of the engine's leaf
  // objects. A schema-namespaced engine also gets schema qualification and the schema filter.
  const profile = activeConn ? profileFor(activeConn, engines) : undefined;
  const typed = profile ? profile.namespace.grouping === "typed" : true;
  const namespaced = profile ? profile.namespace.key === "schema" : true;
  const groups = typed ? GROUPS : GROUPS.filter((g) => g.type === "table");

  const grouped = useMemo(() => {
    const filtered = namespaced && schemaFilter ? objects.filter((o) => o.schema === schemaFilter) : objects;
    const map = new Map<DbObjectType, DbObject[]>();
    for (const g of groups) map.set(g.type, []);
    for (const o of filtered) map.get(o.type)?.push(o);
    return map;
  }, [objects, schemaFilter, namespaced, groups]);

  const displayName = (o: DbObject) =>
    namespaced ? (schemaFilter ? o.name : `${o.schema}.${o.name}`) : o.schema ? `${o.schema}/${o.name}` : o.name;

  const selectedObjects = useMemo(() => {
    const out: DbObject[] = [];
    for (const items of grouped.values()) for (const o of items) if (selected.has(keyOf(o))) out.push(o);
    return out;
  }, [grouped, selected]);

  function handleClick(e: React.MouseEvent, o: DbObject, index: number) {
    const k = keyOf(o);
    if (e.shiftKey && anchor && anchor.type === o.type) {
      const items = grouped.get(o.type) ?? [];
      const [lo, hi] = [Math.min(anchor.index, index), Math.max(anchor.index, index)];
      const range = items.slice(lo, hi + 1).map(keyOf);
      setSelected(new Set(e.ctrlKey || e.metaKey ? [...selected, ...range] : range));
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      // Ctrl-toggle; joining from a different group resets to this row (type-homogeneous).
      const sameGroup = anchor?.type === o.type && selectedObjects.every((s) => s.type === o.type);
      const next = new Set(sameGroup ? selected : []);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      setSelected(next);
      setAnchor({ type: o.type, index });
      return;
    }
    setSelected(new Set([k]));
    setAnchor({ type: o.type, index });
  }

  function handleContextMenu(e: React.MouseEvent, o: DbObject, index: number) {
    e.preventDefault();
    if (!selected.has(keyOf(o))) {
      setSelected(new Set([keyOf(o)]));
      setAnchor({ type: o.type, index });
    }
    setMenu({ x: e.clientX, y: e.clientY });
  }

  // Traces: BASED-EXPLORER-ACTION — settings-driven default, degraded to what the engine supports.
  function handleDoubleClick(o: DbObject) {
    if (o.type === "table" || o.type === "view") {
      let action = explorerTableAction;
      if (action === "sql" && !capabilities?.sql) action = "details";
      if (action === "script-create" && !capabilities?.script) action = "details";
      if (action === "script-create") {
        void scriptObjects([{ schema: o.schema, name: o.name, type: o.type }], "create");
        return;
      }
      void openTableTab(o.schema, o.name, o.type, action);
      return;
    }
    const action = capabilities?.script ? explorerRoutineAction : "details";
    if (action === "script-create") {
      void scriptObjects([{ schema: o.schema, name: o.name, type: o.type }], "create");
      return;
    }
    void openRoutineTab(o.schema, o.name, o.type);
  }

  // Traces: BASED-UI-A11Y-KEYBOARD — the explorer is a tree with one tab stop (roving tabindex).
  const treeRef = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const typeAhead = useRef({ text: "", at: 0 });
  type Node = { key: string; group: DbObjectType; obj: DbObject | null; index: number; label: string };
  const nodes: Node[] = [];
  for (const g of groups) {
    nodes.push({ key: `group:${g.type}`, group: g.type, obj: null, index: -1, label: g.label });
    if (!(collapsed[g.type] ?? false)) {
      (grouped.get(g.type) ?? []).forEach((o, index) => nodes.push({ key: keyOf(o), group: g.type, obj: o, index, label: displayName(o) }));
    }
  }
  const tabStop = nodes.some((n) => n.key === focusKey) ? focusKey : (nodes[0]?.key ?? null);
  const focusNode = (key: string) => {
    setFocusKey(key);
    treeRef.current?.querySelector<HTMLElement>(`[data-node="${CSS.escape(key)}"]`)?.focus();
  };

  function onTreeKey(e: KeyboardEvent<HTMLDivElement>) {
    const at = nodes.findIndex((n) => n.key === tabStop);
    const node = nodes[at];
    if (!node) return;
    const groupCollapsed = collapsed[node.group] ?? false;
    const move = (i: number) => {
      const n = nodes[Math.max(0, Math.min(nodes.length - 1, i))];
      if (n) focusNode(n.key);
    };
    let handled = true;
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(nodes.length - 1);
    else if (e.key === "ArrowRight") {
      if (!node.obj && groupCollapsed) setCollapsed({ ...collapsed, [node.group]: false });
      else if (!node.obj) move(at + 1);
    } else if (e.key === "ArrowLeft") {
      if (!node.obj && !groupCollapsed) setCollapsed({ ...collapsed, [node.group]: true });
      else if (node.obj) focusNode(`group:${node.group}`);
    } else if (e.key === "Enter") {
      if (node.obj) handleDoubleClick(node.obj);
      else setCollapsed({ ...collapsed, [node.group]: !groupCollapsed });
    } else if (e.key === " " && node.obj) {
      setSelected(new Set([node.key]));
      setAnchor({ type: node.obj.type, index: node.index });
    } else if (((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") && node.obj) {
      if (!selected.has(node.key)) {
        setSelected(new Set([node.key]));
        setAnchor({ type: node.obj.type, index: node.index });
      }
      const r = (e.target as HTMLElement).getBoundingClientRect();
      setMenu({ x: r.left + 24, y: r.bottom });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      const now = Date.now();
      const t = typeAhead.current;
      t.text = now - t.at < 600 ? t.text + e.key.toLowerCase() : e.key.toLowerCase();
      t.at = now;
      const order = [...nodes.slice(at + (t.text.length === 1 ? 1 : 0)), ...nodes.slice(0, at + 1)];
      const hit = order.find((n) => n.obj && (n.obj.name.toLowerCase().startsWith(t.text) || n.label.toLowerCase().startsWith(t.text)));
      if (hit) focusNode(hit.key);
    } else handled = false;
    if (e.key.length !== 1) typeAhead.current.text = "";
    if (handled) e.preventDefault();
  }

  if (status !== "connected" && objects.length === 0) {
    return <div className="p-4 text-faint text-[length:var(--fs-base)] italic">No connection.</div>;
  }

  return (
    <div
      ref={treeRef}
      role="tree"
      aria-label="Database objects"
      aria-multiselectable="true"
      className="h-full overflow-y-auto py-1"
      onKeyDown={onTreeKey}
    >
      {groups.map((g) => {
        const items = grouped.get(g.type) ?? [];
        const isCollapsed = collapsed[g.type] ?? false;
        // Traces: BASED-LANCE-CREATE-TABLE-UI — the "+" beside Tables opens the New Table dialog.
        // It sits next to (not inside) the collapse toggle: buttons don't nest.
        const canAdd = g.type === "table" && !!capabilities?.createTable && status === "connected";
        return (
          <section key={g.type}>
            <div className="flex items-center pr-1 hover:bg-ink-900 group">
              <button
                data-node={`group:${g.type}`}
                role="treeitem"
                aria-level={1}
                aria-expanded={!isCollapsed}
                tabIndex={tabStop === `group:${g.type}` ? 0 : -1}
                className="flex-1 min-w-0 flex items-center gap-2 px-3 py-1.5 focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-brass)]"
                onFocus={() => setFocusKey(`group:${g.type}`)}
                onClick={() => setCollapsed({ ...collapsed, [g.type]: !isCollapsed })}
              >
                <span className={`text-faint text-[length:var(--fs-xs)] transition-transform ${isCollapsed ? "" : "rotate-90"}`}>▶</span>
                <span className="ledger-label group-hover:text-muted">{g.label}</span>
                <span className="ml-auto text-[length:var(--fs-xs)] font-mono text-faint">{items.length}</span>
              </button>
              {canAdd && (
                <IconButton
                  size="sm"
                  title="New table"
                  aria-label="New table"
                  className="shrink-0 text-faint opacity-0 group-hover:opacity-100 focus-visible:opacity-100 hover:text-brass"
                  onClick={() => setNewTableOpen(true)}
                >
                  +
                </IconButton>
              )}
            </div>
            {!isCollapsed &&
              items.map((o, index) => {
                const isSelected = selected.has(keyOf(o));
                return (
                  <div
                    key={`${o.schema}.${o.name}`}
                    data-node={keyOf(o)}
                    role="treeitem"
                    aria-level={2}
                    aria-selected={isSelected}
                    tabIndex={tabStop === keyOf(o) ? 0 : -1}
                    onFocus={() => setFocusKey(keyOf(o))}
                    className={`flex items-center gap-2 pl-8 pr-3 py-[3px] text-[length:var(--fs-base)] select-none cursor-pointer focus-visible:outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--color-brass)] ${
                      isSelected ? "bg-ink-850 text-paper" : "text-paper-dim hover:bg-ink-900 hover:text-paper"
                    }`}
                    title={`${displayName(o)} — double-click to open`}
                    onClick={(e) => handleClick(e, o, index)}
                    onContextMenu={(e) => handleContextMenu(e, o, index)}
                    onDoubleClick={() => handleDoubleClick(o)}
                  >
                    <span className="text-faint text-[length:var(--fs-sm)] w-3 text-center">{g.glyph}</span>
                    <span className="truncate font-mono text-[length:var(--fs-sm)]">{displayName(o)}</span>
                  </div>
                );
              })}
          </section>
        );
      })}
      {menu && selectedObjects.length > 0 && (
        <ExplorerContextMenu objects={selectedObjects} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
