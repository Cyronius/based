// Traces: BASED-LANCE-CREATE-TABLE — pure column-spec → structural Arrow SchemaLike builder.
// The output must survive the lancedb SDK's own sanitizer, so that (not our shape) is what the
// round-trip assertions run through.
import { describe, expect, test } from "bun:test";
import { buildLanceSchema, type LanceColumnSpec } from "@based/core";
// The SDK's sanitizer is the authority on whether a structural schema is valid.
// eslint-disable-next-line import/no-relative-packages
import { sanitizeSchema } from "../../../core/node_modules/@lancedb/lancedb/dist/sanitize.js";

function names(specs: LanceColumnSpec[]): string[] {
  const schema = sanitizeSchema(buildLanceSchema(specs));
  return schema.fields.map((f: { name: string; type: unknown }) => `${f.name}: ${String(f.type)}`);
}

describe("buildLanceSchema", () => {
  test("maps every supported scalar type through the SDK sanitizer", () => {
    expect(
      names([
        { name: "s", type: "string" },
        { name: "i", type: "int" },
        { name: "f", type: "float" },
        { name: "b", type: "bool" },
        { name: "d", type: "date" },
      ]),
    ).toEqual(["s: Utf8", "i: Int64", "f: Float64", "b: Bool", "d: Date64<MILLISECOND>"]);
  });

  test("maps a vector column to FixedSizeList<Float32> of the given dimension", () => {
    expect(names([{ name: "vec", type: "vector", dim: 384 }])).toEqual(["vec: FixedSizeList[384]<Float32>"]);
  });

  test("rejects an empty column list", () => {
    expect(() => buildLanceSchema([])).toThrow(/at least one column/i);
  });

  test("rejects duplicate names (case-insensitive)", () => {
    expect(() =>
      buildLanceSchema([
        { name: "id", type: "string" },
        { name: "ID", type: "int" },
      ]),
    ).toThrow(/duplicate/i);
  });

  test("rejects names that are not plain identifiers", () => {
    expect(() => buildLanceSchema([{ name: "bad name", type: "string" }])).toThrow(/name/i);
    expect(() => buildLanceSchema([{ name: "", type: "string" }])).toThrow(/name/i);
    expect(() => buildLanceSchema([{ name: "1st", type: "string" }])).toThrow(/name/i);
  });

  test("rejects a vector column without a dimension, and out-of-range dimensions", () => {
    expect(() => buildLanceSchema([{ name: "v", type: "vector" }])).toThrow(/dimension/i);
    expect(() => buildLanceSchema([{ name: "v", type: "vector", dim: 0 }])).toThrow(/dimension/i);
    expect(() => buildLanceSchema([{ name: "v", type: "vector", dim: 8193 }])).toThrow(/dimension/i);
    expect(() => buildLanceSchema([{ name: "v", type: "vector", dim: 3.5 }])).toThrow(/dimension/i);
  });

  test("rejects a dim on a non-vector column", () => {
    expect(() => buildLanceSchema([{ name: "s", type: "string", dim: 4 }])).toThrow(/dim/i);
  });

  test("rejects an unknown type", () => {
    expect(() => buildLanceSchema([{ name: "x", type: "decimal" as never }])).toThrow(/type/i);
  });
});
