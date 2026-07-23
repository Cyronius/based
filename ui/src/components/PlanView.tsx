import { useMemo, useState } from "react";
import { ReactFlow, Background, Controls, Handle, Position, type Node, type Edge, type NodeProps } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { parsePlanXml, layoutPlan, NODE_WIDTH, NODE_HEIGHT, type LayoutNode } from "../planXml";

const OPERATOR_GLYPHS: Record<string, string> = {
  "Index Seek": "⌕",
  "Clustered Index Seek": "⌕",
  "Index Scan": "▤",
  "Clustered Index Scan": "▤",
  "Table Scan": "▦",
  "Hash Match": "⋈",
  "Merge Join": "⋈",
  "Nested Loops": "↻",
  Sort: "⇅",
  "Compute Scalar": "ƒ",
  Filter: "▽",
  "Stream Aggregate": "Σ",
};

function glyphFor(physicalOp: string): string {
  return OPERATOR_GLYPHS[physicalOp] ?? "▢";
}

function OperatorNode({ data }: NodeProps<Node<{ op: LayoutNode }>>) {
  const { op } = data;
  return (
    <div
      className="rounded border border-line bg-ink-900 text-paper-dim px-2 py-1.5 text-[length:var(--fs-sm)] flex flex-col gap-0.5"
      style={{ width: NODE_WIDTH, height: NODE_HEIGHT }}
    >
      <Handle type="target" position={Position.Top} />
      <div className="flex items-center gap-1.5">
        <span className="text-brass text-[length:var(--fs-md)]">{glyphFor(op.physicalOp)}</span>
        <span className="truncate font-medium">{op.physicalOp}</span>
      </div>
      <div className="text-faint truncate">{op.logicalOp}</div>
      <div className="flex items-center justify-between text-faint font-mono">
        <span>{op.costPercent != null ? `${op.costPercent.toFixed(0)}%` : "—"}</span>
        <span>{op.estimateRows != null ? `~${Math.round(op.estimateRows)}` : ""}</span>
      </div>
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

const nodeTypes = { operator: OperatorNode };

function DetailPanel({ op, onClose }: { op: LayoutNode; onClose: () => void }) {
  const row = (label: string, value: string | number | null) =>
    value == null || value === "" ? null : (
      <div className="flex items-center justify-between gap-3 py-0.5 border-b border-line-soft/50">
        <span className="text-faint">{label}</span>
        <span className="font-mono text-paper-dim text-right truncate max-w-[60%]">{value}</span>
      </div>
    );

  return (
    <div className="absolute top-2 right-2 w-72 max-h-[calc(100%-1rem)] overflow-auto rounded border border-line bg-ink-950/95 backdrop-blur-sm p-3 text-[length:var(--fs-sm)] shadow-lg">
      <div className="flex items-center justify-between mb-1.5">
        <div className="font-medium text-paper">{op.physicalOp}</div>
        <button className="text-faint hover:text-paper" onClick={onClose}>
          ✕
        </button>
      </div>
      {row("Logical Op", op.logicalOp)}
      {row("Estimated Rows", op.estimateRows != null ? op.estimateRows.toLocaleString() : null)}
      {row("Actual Rows", op.actualRows != null ? op.actualRows.toLocaleString() : null)}
      {row("Actual Executions", op.actualExecutions)}
      {row("Estimate IO", op.estimateIO != null ? op.estimateIO.toFixed(4) : null)}
      {row("Estimate CPU", op.estimateCPU != null ? op.estimateCPU.toFixed(4) : null)}
      {row("Subtree Cost", op.estimatedTotalSubtreeCost != null ? op.estimatedTotalSubtreeCost.toFixed(4) : null)}
      {row("Cost %", op.costPercent != null ? `${op.costPercent.toFixed(1)}%` : null)}
      {row("Object", op.object)}
      {op.predicate && (
        <div className="pt-1.5 mt-1">
          <div className="text-faint mb-0.5">Predicate</div>
          <div className="font-mono text-paper-dim whitespace-pre-wrap break-words">{op.predicate}</div>
        </div>
      )}
    </div>
  );
}

function SinglePlanCanvas({ xml }: { xml: string }) {
  const [selected, setSelected] = useState<LayoutNode | null>(null);

  const { nodes, edges } = useMemo(() => {
    const roots = parsePlanXml(xml);
    const root = roots[0];
    if (!root) return { nodes: [] as LayoutNode[], edges: [] as ReturnType<typeof layoutPlan>["edges"] };
    return layoutPlan(root);
  }, [xml]);

  if (nodes.length === 0) {
    return <div className="h-full grid place-items-center text-faint text-[length:var(--fs-base)] italic">No plan operators found.</div>;
  }

  const flowNodes: Node[] = nodes.map((n) => ({
    id: n.nodeId,
    type: "operator",
    position: { x: n.x, y: n.y },
    data: { op: n },
  }));
  const flowEdges: Edge[] = edges.map((e) => ({ ...e, type: "smoothstep" }));

  return (
    <div className="relative h-full w-full">
      <ReactFlow
        nodes={flowNodes}
        edges={flowEdges}
        nodeTypes={nodeTypes}
        onNodeClick={(_, node) => setSelected((node.data as { op: LayoutNode }).op)}
        onPaneClick={() => setSelected(null)}
        fitView
        proOptions={{ hideAttribution: true }}
      >
        <Background />
        <Controls />
      </ReactFlow>
      {selected && <DetailPanel op={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

/** Renders one or more captured execution plans (one per statement in the run). Multi-statement runs
 *  get a small nested tab strip above the canvas; single-statement runs skip it. */
export function PlanView({ plans }: { plans: string[] }) {
  const [active, setActive] = useState(0);

  if (plans.length === 0) return null;

  return (
    <div className="h-full flex flex-col">
      {plans.length > 1 && (
        <div className="flex items-stretch h-6 border-b border-line-soft shrink-0">
          {plans.map((_, i) => (
            <button
              key={i}
              className={`px-2.5 border-r border-line-soft text-[length:var(--fs-sm)] ${
                active === i
                  ? "bg-ink-800 text-brass shadow-[inset_0_2px_0_var(--color-brass)]"
                  : "text-muted hover:text-paper-dim hover:bg-ink-900/50"
              }`}
              onClick={() => setActive(i)}
            >
              Statement {i + 1}
            </button>
          ))}
        </div>
      )}
      <div className="flex-1 min-h-0">
        <SinglePlanCanvas key={active} xml={plans[active]!} />
      </div>
    </div>
  );
}
