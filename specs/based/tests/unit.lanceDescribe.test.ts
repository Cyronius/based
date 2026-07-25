// Traces: BASED-SCRIPT-OBJECT (LanceDB half) — pure schema description, no DB.
import { describe, expect, test } from "bun:test";
import { describeLanceSchema } from "@based/core";
import type { TableColumn } from "@based/core";

function col(over: Partial<TableColumn> & { name: string; type: string }): TableColumn {
  return {
    maxLength: null,
    precision: null,
    scale: null,
    nullable: true,
    isPrimaryKey: false,
    isForeignKey: false,
    fkTarget: null,
    ...over,
  };
}

const FIXTURE: TableColumn[] = [
  col({ name: "id", type: "Int64", nullable: false }),
  col({ name: "text", type: "Utf8" }),
  col({
    name: "vector",
    type: "FixedSizeList",
    isVector: true,
    vectorDimension: 384,
    vectorMetric: "cosine",
    elementType: "float32",
  }),
];

describe("BASED-SCRIPT-OBJECT: describeLanceSchema", () => {
  test("names every column and renders the vector column as vector[dim] with its metric", () => {
    const out = describeLanceSchema("docs", FIXTURE);
    expect(out).toContain("table docs");
    expect(out).toContain("id: Int64, not null");
    expect(out).toContain("text: Utf8");
    expect(out).toContain("vector: vector[384] of float32 (index metric: cosine)");
  });

  test("includes a pyarrow schema snippet with the vector as a fixed-size list", () => {
    const out = describeLanceSchema("docs", FIXTURE);
    expect(out).toContain("pa.schema([");
    expect(out).toContain('pa.field("vector", pa.list_(pa.float32(), 384))');
    expect(out).toContain('pa.field("id", pa.int64(), nullable=False)');
    expect(out).toContain('pa.field("text", pa.string())');
  });

  test("an unindexed vector column omits the metric note", () => {
    const out = describeLanceSchema("t", [col({ name: "v", type: "FixedSizeList", isVector: true, vectorDimension: 8, elementType: "float32" })]);
    expect(out).toContain("v: vector[8] of float32");
    expect(out).not.toContain("index metric");
  });
});
