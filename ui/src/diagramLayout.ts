// Traces: BASED-DIAGRAM-LAYOUT
// Pure ER-diagram auto-layout over dagre (rankdir LR, node height from column count). dagre —
// not elkjs — because it's small, synchronous (consumed inside a useMemo like planXml's
// layoutPlan), the canonical React Flow pairing, and handles cyclic FK graphs the hand-rolled
// tree layout in planXml.ts cannot.
import dagre from "@dagrejs/dagre";
import type { RelationsGraph } from "./api/types";

export const DIAGRAM_NODE_WIDTH = 220;
export const DIAGRAM_HEADER_HEIGHT = 30;
export const DIAGRAM_ROW_HEIGHT = 20;
/** Column rows rendered per node before the "+N more" footer. */
export const DIAGRAM_MAX_ROWS = 25;

export interface PositionedTable {
  id: string;
  schema: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DiagramEdge {
  id: string;
  source: string;
  target: string;
  /** FK constraint name + column pairs — shown in the detail card on selection. */
  label: string;
}

export function nodeIdOf(schema: string, name: string): string {
  return `${schema}.${name}`;
}

export function nodeHeightFor(columnCount: number): number {
  const rows = Math.min(columnCount, DIAGRAM_MAX_ROWS) + (columnCount > DIAGRAM_MAX_ROWS ? 1 : 0);
  return DIAGRAM_HEADER_HEIGHT + rows * DIAGRAM_ROW_HEIGHT + 8;
}

/**
 * Position every table (finite coords, deterministic for a fixed input, cycle-safe) and emit one
 * edge per FK whose endpoints are both present in the graph.
 */
export function layoutDiagram(graph: RelationsGraph): { nodes: PositionedTable[]; edges: DiagramEdge[] } {
  // multigraph: two tables can carry more than one FK between them (each a named edge).
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 40, ranksep: 90, marginx: 20, marginy: 20 });
  g.setDefaultEdgeLabel(() => ({}));

  const ids = new Set<string>();
  for (const t of graph.tables) {
    const id = nodeIdOf(t.schema, t.name);
    ids.add(id);
    g.setNode(id, { width: DIAGRAM_NODE_WIDTH, height: nodeHeightFor(t.columns.length) });
  }

  const edges: DiagramEdge[] = [];
  for (const fk of graph.foreignKeys) {
    const source = nodeIdOf(fk.schema, fk.table);
    const target = nodeIdOf(fk.refSchema, fk.refTable);
    if (!ids.has(source) || !ids.has(target)) continue; // out-of-scope stub — edge only renders when both ends exist
    // Self-referencing FKs are legal (dagre handles the loop); duplicate names disambiguated by index.
    const id = `${fk.name}:${edges.length}`;
    g.setEdge(source, target, {}, id);
    edges.push({
      id,
      source,
      target,
      label: `${fk.name}: ${fk.columns.join(", ")} → ${fk.refTable}(${fk.refColumns.join(", ")})`,
    });
  }

  dagre.layout(g);

  const nodes: PositionedTable[] = graph.tables.map((t) => {
    const id = nodeIdOf(t.schema, t.name);
    const n = g.node(id) as { x: number; y: number; width: number; height: number };
    return {
      id,
      schema: t.schema,
      name: t.name,
      // dagre positions are centers; React Flow wants top-left.
      x: n.x - n.width / 2,
      y: n.y - n.height / 2,
      width: n.width,
      height: n.height,
    };
  });

  return { nodes, edges };
}
