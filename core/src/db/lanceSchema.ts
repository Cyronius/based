// Traces: BASED-LANCE-CREATE-TABLE
// Pure column-spec → structural Arrow SchemaLike builder for LanceDB createEmptyTable. The SDK's
// sanitizeSchema accepts a plain `{fields}` object with string type names (and `{typeId, listSize}`
// for FixedSizeList), which keeps this module — like the rest of the adapter — free of an
// apache-arrow import. `date` maps to `datemillisecond` because the sanitizer's string-name table
// has no timestamp entry in 0.24.x.

export interface LanceColumnSpec {
  name: string;
  type: "string" | "int" | "float" | "bool" | "date" | "vector";
  /** Vector dimension — required iff type is "vector". */
  dim?: number;
}

/** The shape @lancedb/lancedb's sanitizeSchema accepts structurally. */
export interface LanceSchemaLike {
  fields: Array<{ name: string; type: unknown; nullable: boolean }>;
}

const SCALAR_TYPE_NAMES: Record<Exclude<LanceColumnSpec["type"], "vector">, string> = {
  string: "utf8",
  int: "int64",
  float: "float64",
  bool: "bool",
  date: "datemillisecond",
};

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
export const MAX_VECTOR_DIM = 8192;

/** Arrow's Type.FixedSizeList — a spec constant, stable across the SDK's whole peer range. */
const FIXED_SIZE_LIST_TYPE_ID = 16;

export function buildLanceSchema(columns: LanceColumnSpec[]): LanceSchemaLike {
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new Error("A table needs at least one column.");
  }
  const seen = new Set<string>();
  const fields = columns.map((col) => {
    if (typeof col.name !== "string" || !IDENTIFIER.test(col.name)) {
      throw new Error(
        `Invalid column name ${JSON.stringify(col.name ?? "")}: use letters, digits, and underscores, not starting with a digit.`,
      );
    }
    const lower = col.name.toLowerCase();
    if (seen.has(lower)) throw new Error(`Duplicate column name "${col.name}".`);
    seen.add(lower);

    if (col.type === "vector") {
      if (typeof col.dim !== "number" || !Number.isInteger(col.dim) || col.dim < 1 || col.dim > MAX_VECTOR_DIM) {
        throw new Error(`Vector column "${col.name}" needs an integer dimension between 1 and ${MAX_VECTOR_DIM}.`);
      }
      return {
        name: col.name,
        type: {
          typeId: FIXED_SIZE_LIST_TYPE_ID,
          listSize: col.dim,
          children: [{ name: "item", type: "float32", nullable: true }],
        },
        nullable: true,
      };
    }

    if (col.dim != null) throw new Error(`Column "${col.name}" has a dim but is not a vector column.`);
    const typeName = SCALAR_TYPE_NAMES[col.type];
    if (!typeName) throw new Error(`Unknown column type ${JSON.stringify(col.type)} for "${col.name}".`);
    return { name: col.name, type: typeName, nullable: true };
  });
  return { fields };
}
