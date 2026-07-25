// Traces: BASED-LANCE-SQL-PLAN
// Parses DuckDB's JSON profiling operator tree (emitted by the Lance bridge as a `duckdb-json` plan
// chunk) into the same PlanOperator shape parsePlanXml produces for SQL Server — so the shared
// PlanView graph renders both engines. The wire payload is the trimmed roots array from
// core/src/db/duckProfile.ts (`extractDuckPlanTree`).
import type { PlanOperator } from "./planXml";

interface DuckNode {
  operator_type?: string;
  operator_cardinality?: number | null;
  operator_timing?: number | null;
  extra_info?: Record<string, unknown>;
  children?: DuckNode[];
}

/** "HASH_GROUP_BY" → "Hash Group By". Keeps parsePlanXml's Title-Case operator labels so the glyph
 *  map and node headers read consistently across engines. */
function humanize(op: string): string {
  return op
    .toLowerCase()
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** DuckDB's extra_info values are strings or string arrays (e.g. Filters, Order By); render either as
 *  a single human line. */
function asText(v: unknown): string | null {
  if (v == null) return null;
  if (Array.isArray(v)) return v.length ? v.map(String).join(", ") : null;
  const s = String(v);
  return s.length ? s : null;
}

/** First present predicate-ish field, in priority order — the operator's most informative one-liner. */
function predicateOf(info: Record<string, unknown>): string | null {
  for (const key of ["Filters", "Condition", "Join Type", "Order By", "Groups", "Aggregates"]) {
    const t = asText(info[key]);
    if (t) return `${key}: ${t}`;
  }
  return null;
}

export function parseDuckPlanJson(json: string): PlanOperator[] {
  let roots: DuckNode[];
  try {
    const parsed = JSON.parse(json);
    roots = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
  let nextId = 0;

  // estimatedTotalSubtreeCost is set to *cumulative* self+descendant timing so layoutPlan's cost%
  // math (self = subtree − Σchildren) recovers each operator's own timing share.
  function build(node: DuckNode): PlanOperator {
    const info = node.extra_info ?? {};
    const children = (node.children ?? []).map(build);
    const selfTiming = typeof node.operator_timing === "number" ? node.operator_timing : 0;
    const subtreeCost = selfTiming + children.reduce((s, c) => s + (c.estimatedTotalSubtreeCost ?? 0), 0);
    return {
      nodeId: String(nextId++),
      physicalOp: humanize(node.operator_type ?? "Operator"),
      logicalOp: asText(info["Type"]) ?? "",
      estimateRows: num(info["Estimated Cardinality"]),
      estimateIO: null,
      estimateCPU: null,
      estimatedTotalSubtreeCost: subtreeCost,
      actualRows: typeof node.operator_cardinality === "number" ? node.operator_cardinality : null,
      actualExecutions: null,
      object: asText(info["Table"]),
      predicate: predicateOf(info),
      children,
    };
  }

  return roots.map(build);
}
