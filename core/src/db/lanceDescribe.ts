// Traces: BASED-SCRIPT-OBJECT (LanceDB half)
// Pure schema description for a LanceDB table — Lance has no SQL DDL, so describe_table's pyarrow
// tool returns a readable column listing plus a pyarrow schema snippet (Lance tooling is
// Python-first). No DB access; unit-testable with fixture columns.
import type { TableColumn } from "./types";

/** Map an Arrow-ish type string (what LanceDbAdapter.getTableColumns reports) to a pyarrow
 *  constructor expression. Unknown types fall back to a comment so the snippet stays valid-ish. */
function pyarrowType(c: TableColumn): string {
  if (c.isVector) {
    const elem = pyarrowScalar(c.elementType ?? "float32");
    return `pa.list_(${elem}, ${c.vectorDimension ?? -1})`;
  }
  return pyarrowScalar(c.type);
}

function pyarrowScalar(t: string): string {
  const s = t.toLowerCase();
  if (/large_utf8|largeutf8/.test(s)) return "pa.large_string()";
  if (/utf8|string/.test(s)) return "pa.string()";
  if (/float64|double/.test(s)) return "pa.float64()";
  if (/float32|^float$/.test(s)) return "pa.float32()";
  if (/float16|half/.test(s)) return "pa.float16()";
  if (/int64/.test(s)) return "pa.int64()";
  if (/int32|^int$/.test(s)) return "pa.int32()";
  if (/int16/.test(s)) return "pa.int16()";
  if (/int8/.test(s)) return "pa.int8()";
  if (/uint64/.test(s)) return "pa.uint64()";
  if (/uint32/.test(s)) return "pa.uint32()";
  if (/bool/.test(s)) return "pa.bool_()";
  if (/timestamp/.test(s)) return "pa.timestamp('us')";
  if (/date/.test(s)) return "pa.date32()";
  if (/binary/.test(s)) return "pa.binary()";
  return `pa.string()  # unknown type: ${t}`;
}

/** One line per column: name, type (vector columns as `vector[dim] of elementType`, with the ANN
 *  index metric when known), nullability. */
function columnLine(c: TableColumn): string {
  if (c.isVector) {
    const metric = c.vectorMetric ? ` (index metric: ${c.vectorMetric})` : "";
    return `  ${c.name}: vector[${c.vectorDimension ?? "?"}] of ${c.elementType ?? "float32"}${metric}${c.nullable ? "" : ", not null"}`;
  }
  return `  ${c.name}: ${c.type}${c.nullable ? "" : ", not null"}`;
}

/** Readable pseudo-DDL + a pyarrow schema snippet for a LanceDB table. */
export function describeLanceSchema(table: string, columns: TableColumn[]): string {
  const lines = columns.map(columnLine).join("\n");
  const pySchema = columns.map((c) => `    pa.field("${c.name}", ${pyarrowType(c)}${c.nullable ? "" : ", nullable=False"}),`).join("\n");
  return `table ${table} (
${lines}
)

# pyarrow schema (for creating a compatible table with lancedb / pylance):
import pyarrow as pa
schema = pa.schema([
${pySchema}
])`;
}
