// Traces: BASED-DIAGRAM-UI (manual)
// ER diagram tab: React Flow canvas over the relations graph (BASED-RELATIONS), laid out by the
// pure dagre wrapper in diagramLayout.ts. Custom table nodes (schema.name header + column rows
// with the same ⚿/⚷ glyphs as the Details view, capped with a "+N more" footer), smoothstep FK
// edges with a detail card on selection, scope selector in the header, >300-table guard.
import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { DiagramTabState } from "../store";
import { useStore } from "../store";
import type { RelationsTable } from "../api/types";
import { layoutDiagram, nodeIdOf, DIAGRAM_NODE_WIDTH, DIAGRAM_MAX_ROWS } from "../diagramLayout";

const TABLE_LIMIT = 300;

type TableNodeData = { table: RelationsTable };

function TableNode({ data, selected }: NodeProps) {
  const { table } = data as TableNodeData;
  const overflow = table.columns.length - DIAGRAM_MAX_ROWS;
  return (
    <div
      className={`rounded border bg-ink-950 text-[length:var(--fs-xs)] font-mono shadow-lg shadow-black/30 ${
        selected ? "border-brass" : "border-line"
      }`}
      style={{ width: DIAGRAM_NODE_WIDTH }}
    >
      <Handle type="target" position={Position.Left} className="!bg-brass-soft !border-0 !w-1.5 !h-1.5" />
      <div className="px-2 py-1.5 border-b border-line bg-ink-900 rounded-t text-paper truncate font-semibold">
        <span className="text-muted">{table.schema}.</span>
        {table.name}
      </div>
      <div className="py-1">
        {table.columns.slice(0, DIAGRAM_MAX_ROWS).map((c) => (
          <div key={c.name} className="flex items-center gap-1.5 px-2 leading-[20px] text-paper-dim">
            <span className="w-3 text-center shrink-0">
              {c.isPrimaryKey ? <span className="text-brass" title="Primary key">⚿</span> : c.isForeignKey ? <span className="text-info" title="Foreign key">⚷</span> : null}
            </span>
            <span className="truncate">{c.name}</span>
            <span className="ml-auto text-faint shrink-0">{c.type}</span>
          </div>
        ))}
        {overflow > 0 && <div className="px-2 leading-[20px] text-faint italic">+{overflow} more</div>}
      </div>
      <Handle type="source" position={Position.Right} className="!bg-brass-soft !border-0 !w-1.5 !h-1.5" />
    </div>
  );
}

const nodeTypes = { tableNode: TableNode };

export function DiagramView({ tab }: { tab: DiagramTabState }) {
  const schemas = useStore((s) => s.schemas);
  const setDiagramScope = useStore((s) => s.setDiagramScope);
  const themeId = useStore((s) => s.theme);
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);

  const layout = useMemo(() => (tab.graph ? layoutDiagram(tab.graph) : null), [tab.graph]);

  const tooBig = (tab.graph?.tables.length ?? 0) > TABLE_LIMIT;

  const nodes = useMemo<Node[]>(() => {
    if (!layout || !tab.graph || tooBig) return [];
    const byId = new Map(tab.graph.tables.map((t) => [nodeIdOf(t.schema, t.name), t]));
    return layout.nodes.map((n) => ({
      id: n.id,
      type: "tableNode",
      position: { x: n.x, y: n.y },
      data: { table: byId.get(n.id)! },
    }));
  }, [layout, tab.graph, tooBig]);

  const edges = useMemo<Edge[]>(() => {
    if (!layout || tooBig) return [];
    return layout.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      type: "smoothstep",
      style: { stroke: "var(--color-brass-soft)", strokeWidth: 1.2, opacity: 0.75 },
    }));
  }, [layout, tooBig]);

  const selectedEdgeLabel = selectedEdge ? layout?.edges.find((e) => e.id === selectedEdge)?.label : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col bg-ink-900">
      <div className="px-5 pt-4 pb-3 flex items-center gap-3 shrink-0">
        <h1 className="font-display text-xl text-paper">{tab.title}</h1>
        <select
          className="px-2 py-1 rounded border border-line bg-ink-900 text-paper text-[length:var(--fs-base)] focus:outline-none focus:border-brass-soft"
          value={tab.schemaScope}
          onChange={(e) => setDiagramScope(tab.id, e.target.value)}
          title="Schema scope"
        >
          <option value="">All schemas</option>
          {schemas.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        {tab.graph && !tooBig && (
          <span className="text-[length:var(--fs-sm)] text-faint font-mono">
            {tab.graph.tables.length} tables · {layout?.edges.length ?? 0} relations
          </span>
        )}
      </div>

      <div className="flex-1 min-h-0 relative">
        {tab.error && (
          <div className="mx-5 px-3 py-2 text-[length:var(--fs-base)] text-err bg-err/10 border border-err/30 rounded font-mono">
            {tab.error}
          </div>
        )}
        {!tab.graph && !tab.error && <div className="px-5 text-muted pulse-soft text-[length:var(--fs-base)]">Loading relations…</div>}
        {tooBig && tab.graph && (
          <div className="px-5 text-[length:var(--fs-base)] text-muted">
            {tab.graph.tables.length.toLocaleString()} tables in scope — pick a schema above to draw the diagram.
          </div>
        )}
        {tab.graph && !tooBig && (
          <ReactFlow
            key={`${themeId}:${tab.schemaScope}`}
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            fitView
            minZoom={0.05}
            onlyRenderVisibleElements
            proOptions={{ hideAttribution: true }}
            onEdgeClick={(_, edge) => setSelectedEdge(edge.id)}
            onPaneClick={() => setSelectedEdge(null)}
            nodesConnectable={false}
            edgesFocusable
          >
            <Background gap={24} size={1} />
            <Controls showInteractive={false} />
          </ReactFlow>
        )}
        {selectedEdgeLabel && (
          <div className="absolute bottom-3 left-3 max-w-[70%] rounded border border-line bg-ink-950/95 px-3 py-2 text-[length:var(--fs-sm)] font-mono text-paper-dim shadow-xl shadow-black/40">
            {selectedEdgeLabel}
          </div>
        )}
      </div>
    </div>
  );
}
