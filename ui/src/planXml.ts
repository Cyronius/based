// Traces: BASED-EXEC-PLAN
// Parses SQL Server's showplan XML (captured via SET STATISTICS XML ON) into an operator tree, and
// lays that tree out for rendering. Uses fast-xml-parser (pure JS, no browser DOM) rather than
// DOMParser so the same code runs identically in the webview and in `bun test`.
import { XMLParser } from "fast-xml-parser";

export interface PlanOperator {
  nodeId: string;
  physicalOp: string;
  logicalOp: string;
  estimateRows: number | null;
  estimateIO: number | null;
  estimateCPU: number | null;
  estimatedTotalSubtreeCost: number | null;
  actualRows: number | null;
  actualExecutions: number | null;
  object: string | null;
  predicate: string | null;
  children: PlanOperator[];
}

export interface LayoutNode extends PlanOperator {
  x: number;
  y: number;
  /** Share of the whole plan's cost this operator alone (not its subtree) accounts for, 0-100. */
  costPercent: number | null;
  children: LayoutNode[];
}

export interface PlanEdge {
  id: string;
  source: string;
  target: string;
}

const NODE_W = 180;
const NODE_H = 70;
const H_GAP = 40;
const V_GAP = 90;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  removeNSPrefix: true,
});

function asArray<T>(v: T | T[] | undefined | null): T[] {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

function stripBrackets(s: unknown): string {
  return typeof s === "string" ? s.replace(/^\[|\]$/g, "") : "";
}

type XmlNode = Record<string, unknown>;

/** A RelOp's operands live one level down, under an operator-specific wrapper element (NestedLoops,
 *  Filter, IndexScan, ...) — this collects that wrapper's own RelOp children. */
function findDirectChildRelOps(relOp: XmlNode): XmlNode[] {
  const out: XmlNode[] = [];
  for (const key of Object.keys(relOp)) {
    if (key.startsWith("@_") || key === "RelOp") continue;
    for (const child of asArray(relOp[key] as XmlNode | XmlNode[])) {
      if (child && typeof child === "object" && "RelOp" in child) {
        out.push(...asArray(child.RelOp as XmlNode | XmlNode[]));
      }
    }
  }
  return out;
}

/** Schema/table/index this operator reads, from a nested <Object .../> (e.g. under IndexScan/TableScan). */
function findObject(relOp: XmlNode): string | null {
  for (const key of Object.keys(relOp)) {
    if (key.startsWith("@_") || key === "RelOp") continue;
    for (const child of asArray(relOp[key] as XmlNode | XmlNode[])) {
      if (!child || typeof child !== "object") continue;
      const obj = asArray(child.Object as XmlNode | XmlNode[])[0];
      if (!obj) continue;
      const schema = stripBrackets(obj["@_Schema"]);
      const table = stripBrackets(obj["@_Table"]);
      const index = stripBrackets(obj["@_Index"]);
      const base = [schema, table].filter(Boolean).join(".");
      return index ? `${base} (${index})` : base || null;
    }
  }
  return null;
}

/** SQL Server pre-renders a human-readable predicate string on the ScalarOperator — no need to walk
 *  the nested scalar-expression tree ourselves. */
function findPredicate(relOp: XmlNode): string | null {
  for (const key of Object.keys(relOp)) {
    if (key.startsWith("@_") || key === "RelOp") continue;
    for (const child of asArray(relOp[key] as XmlNode | XmlNode[])) {
      if (!child || typeof child !== "object") continue;
      const pred = asArray(child.Predicate as XmlNode | XmlNode[])[0];
      const scalar = pred && asArray(pred.ScalarOperator as XmlNode | XmlNode[])[0];
      const str = scalar?.["@_ScalarString"];
      if (typeof str === "string") return str;
    }
  }
  return null;
}

/** Actual plans carry per-thread runtime counters; sum across threads for parallel plans rather than
 *  reading only the first. */
function actualCounters(relOp: XmlNode): { rows: number | null; executions: number | null } {
  const rti = asArray(relOp.RunTimeInformation as XmlNode | XmlNode[])[0];
  const threads = asArray(rti?.RunTimeCountersPerThread as XmlNode | XmlNode[]);
  if (threads.length === 0) return { rows: null, executions: null };
  let rows = 0;
  let executions = 0;
  let any = false;
  for (const t of threads) {
    const r = num(t["@_ActualRows"]);
    const e = num(t["@_ActualExecutions"]);
    if (r != null) {
      rows += r;
      any = true;
    }
    if (e != null) {
      executions += e;
      any = true;
    }
  }
  return any ? { rows, executions } : { rows: null, executions: null };
}

function buildOperator(relOp: XmlNode): PlanOperator {
  const counters = actualCounters(relOp);
  return {
    nodeId: String(relOp["@_NodeId"] ?? ""),
    physicalOp: String(relOp["@_PhysicalOp"] ?? "Unknown"),
    logicalOp: String(relOp["@_LogicalOp"] ?? ""),
    estimateRows: num(relOp["@_EstimateRows"]),
    estimateIO: num(relOp["@_EstimateIO"]),
    estimateCPU: num(relOp["@_EstimateCPU"]),
    estimatedTotalSubtreeCost: num(relOp["@_EstimatedTotalSubtreeCost"]),
    actualRows: counters.rows,
    actualExecutions: counters.executions,
    object: findObject(relOp),
    predicate: findPredicate(relOp),
    children: findDirectChildRelOps(relOp).map(buildOperator),
  };
}

/** Parse one ShowPlanXML document (one statement's plan, as captured per QueryChunk) into its root
 *  operator(s) — normally exactly one, one per StmtSimple. */
export function parsePlanXml(xml: string): PlanOperator[] {
  const doc = parser.parse(xml) as XmlNode;
  const showPlan = doc.ShowPlanXML as XmlNode | undefined;
  const batchSequence = showPlan?.BatchSequence as XmlNode | undefined;
  const batches = asArray(batchSequence?.Batch as XmlNode | XmlNode[] | undefined);
  const roots: PlanOperator[] = [];
  for (const batch of batches) {
    const statements = batch.Statements as XmlNode | undefined;
    const stmts = asArray(statements?.StmtSimple as XmlNode | XmlNode[] | undefined);
    for (const stmt of stmts) {
      const qp = stmt.QueryPlan as XmlNode | undefined;
      const relOp = qp && asArray(qp.RelOp as XmlNode | XmlNode[])[0];
      if (relOp) roots.push(buildOperator(relOp));
    }
  }
  return roots;
}

/** Simplified Reingold-Tilford tree layout: y from depth, x from the average of each node's
 *  children's x (leaves packed left-to-right). Skips full overlap-avoidance shifting — acceptable for
 *  showplan's typically shallow/narrow trees. */
export function layoutPlan(root: PlanOperator): { nodes: LayoutNode[]; edges: PlanEdge[] } {
  const flat: LayoutNode[] = [];
  let nextLeafX = 0;

  function place(op: PlanOperator, depth: number): LayoutNode {
    if (op.children.length === 0) {
      const x = nextLeafX;
      nextLeafX += NODE_W + H_GAP;
      const node: LayoutNode = { ...op, x, y: depth, costPercent: null, children: [] };
      flat.push(node);
      return node;
    }
    const children = op.children.map((c) => place(c, depth + 1));
    const first = children[0]!.x;
    const last = children[children.length - 1]!.x;
    const node: LayoutNode = { ...op, x: (first + last) / 2, y: depth, costPercent: null, children };
    flat.push(node);
    return node;
  }

  const laidRoot = place(root, 0);
  const rootCost = laidRoot.estimatedTotalSubtreeCost ?? 0;

  function finalize(node: LayoutNode): void {
    const childCost = node.children.reduce((s, c) => s + (c.estimatedTotalSubtreeCost ?? 0), 0);
    const selfCost = (node.estimatedTotalSubtreeCost ?? 0) - childCost;
    node.costPercent = rootCost > 0 ? Math.max(0, (selfCost / rootCost) * 100) : null;
    node.y = node.y * (NODE_H + V_GAP);
    for (const c of node.children) finalize(c);
  }
  finalize(laidRoot);

  const edges: PlanEdge[] = [];
  function collectEdges(node: LayoutNode): void {
    for (const c of node.children) {
      edges.push({ id: `${node.nodeId}-${c.nodeId}`, source: node.nodeId, target: c.nodeId });
      collectEdges(c);
    }
  }
  collectEdges(laidRoot);

  return { nodes: flat, edges };
}

export const NODE_WIDTH = NODE_W;
export const NODE_HEIGHT = NODE_H;
