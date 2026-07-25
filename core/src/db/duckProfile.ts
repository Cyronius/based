// Traces: BASED-LANCE-SQL-PLAN, BASED-LANCE-SQL-STATS
// Helpers over DuckDB's JSON profiling output (captured via `SET enable_profiling='json'` +
// `profiling_output=<file>` — see lanceSql.ts). The bridge reads the profile file after a capture
// run and calls these to (a) trim the operator tree for the `plan` chunk the UI renders, and
// (b) format a client-statistics summary for the Output pane.

/** A node in DuckDB's profiling tree. Only the fields we surface are typed; the profile carries many
 *  more (optimizer sub-timings, memory counters) that we ignore. `operator_type` is the streamed
 *  profile's operator label; a plain `EXPLAIN (FORMAT json)` uses `name` instead — accept either. */
export interface DuckProfileNode {
  operator_type?: string;
  name?: string;
  operator_cardinality?: number;
  operator_timing?: number;
  extra_info?: Record<string, unknown>;
  children?: DuckProfileNode[];
  // Top-level (query root) summary fields:
  latency?: number;
  cpu_time?: number;
  rows_returned?: number;
  cumulative_rows_scanned?: number;
  system_peak_buffer_memory?: number;
  total_bytes_read?: number;
}

/** The subset of each operator node we send over the wire — keeps the `plan` chunk small and the UI
 *  parser (parseDuckPlanJson) stable regardless of which extra profiling fields a DuckDB build adds. */
interface TrimmedNode {
  operator_type: string;
  operator_cardinality: number | null;
  operator_timing: number | null;
  extra_info: Record<string, unknown>;
  children: TrimmedNode[];
}

function trim(node: DuckProfileNode): TrimmedNode {
  return {
    operator_type: node.operator_type ?? node.name ?? "OPERATOR",
    operator_cardinality: typeof node.operator_cardinality === "number" ? node.operator_cardinality : null,
    operator_timing: typeof node.operator_timing === "number" ? node.operator_timing : null,
    extra_info: (node.extra_info as Record<string, unknown>) ?? {},
    children: (node.children ?? []).map(trim),
  };
}

/** Trim the profile's operator roots (`profile.children`) to the wire shape and JSON-stringify them,
 *  or null when the profile has no operator tree (e.g. a `SET`/DDL statement, or a truncated run whose
 *  profile never flushed). */
export function extractDuckPlanTree(profile: DuckProfileNode): string | null {
  const roots = (profile.children ?? []).map(trim);
  if (roots.length === 0) return null;
  return JSON.stringify(roots);
}

function ms(seconds: unknown): string {
  return typeof seconds === "number" ? `${(seconds * 1000).toFixed(1)} ms` : "—";
}

function count(n: unknown): string {
  return typeof n === "number" ? n.toLocaleString("en-US") : "—";
}

/** A human-readable client-statistics line for the Output pane — the DuckDB analog of SQL Server's
 *  STATISTICS TIME/IO messages (BASED-CLIENT-STATS). Deliberately lowercase key phrases
 *  (`latency`, `rows returned`, `rows scanned`) so tests and the eye can grep them. */
export function duckStatsMessage(profile: DuckProfileNode): string {
  const parts = [
    `latency ${ms(profile.latency)}`,
    `CPU time ${ms(profile.cpu_time)}`,
    `${count(profile.rows_returned)} rows returned`,
    `${count(profile.cumulative_rows_scanned)} rows scanned`,
  ];
  if (typeof profile.system_peak_buffer_memory === "number") {
    parts.push(`peak memory ${(profile.system_peak_buffer_memory / (1024 * 1024)).toFixed(1)} MiB`);
  }
  return `Client statistics: ${parts.join(" · ")}`;
}
