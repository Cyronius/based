// Traces: BASED-DIAGRAM-LAYOUT
import { describe, expect, test } from "bun:test";
import { layoutDiagram, nodeHeightFor, DIAGRAM_MAX_ROWS, DIAGRAM_HEADER_HEIGHT, DIAGRAM_ROW_HEIGHT } from "../../../ui/src/diagramLayout";
import type { RelationsGraph } from "../../../ui/src/api/types";

const colsOf = (names: string[]) =>
  names.map((name) => ({ name, type: "int", isPrimaryKey: name === "id", isForeignKey: false, nullable: false }));

const GRAPH: RelationsGraph = {
  tables: [
    { schema: "dbo", name: "customers", columns: colsOf(["id", "name"]) },
    { schema: "dbo", name: "orders", columns: colsOf(["id", "customer_id", "total"]) },
    { schema: "sales", name: "invoices", columns: colsOf(["id", "order_id"]) },
  ],
  foreignKeys: [
    { name: "FK_orders_customers", schema: "dbo", table: "orders", columns: ["customer_id"], refSchema: "dbo", refTable: "customers", refColumns: ["id"] },
    { name: "FK_invoices_orders", schema: "sales", table: "invoices", columns: ["order_id"], refSchema: "dbo", refTable: "orders", refColumns: ["id"] },
  ],
};

describe("BASED-DIAGRAM-LAYOUT", () => {
  test("every table gets a node with finite, non-overlapping coordinates", () => {
    const { nodes } = layoutDiagram(GRAPH);
    expect(nodes.length).toBe(3);
    for (const n of nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.height).toBeGreaterThan(0);
    }
    const coords = new Set(nodes.map((n) => `${n.x},${n.y}`));
    expect(coords.size).toBe(3);
  });

  test("edges reference existing node ids; out-of-scope refs are dropped", () => {
    const { nodes, edges } = layoutDiagram(GRAPH);
    const ids = new Set(nodes.map((n) => n.id));
    expect(edges.length).toBe(2);
    for (const e of edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    // an FK to a table outside the graph produces no edge
    const scoped: RelationsGraph = {
      tables: [GRAPH.tables[2]!],
      foreignKeys: GRAPH.foreignKeys,
    };
    expect(layoutDiagram(scoped).edges.length).toBe(0);
  });

  test("a two-table cycle lays out without throwing", () => {
    const cyclic: RelationsGraph = {
      tables: [
        { schema: "dbo", name: "a", columns: colsOf(["id", "b_id"]) },
        { schema: "dbo", name: "b", columns: colsOf(["id", "a_id"]) },
      ],
      foreignKeys: [
        { name: "FK_a_b", schema: "dbo", table: "a", columns: ["b_id"], refSchema: "dbo", refTable: "b", refColumns: ["id"] },
        { name: "FK_b_a", schema: "dbo", table: "b", columns: ["a_id"], refSchema: "dbo", refTable: "a", refColumns: ["id"] },
      ],
    };
    const { nodes, edges } = layoutDiagram(cyclic);
    expect(nodes.length).toBe(2);
    expect(edges.length).toBe(2);
  });

  test("deterministic: same input twice → identical output", () => {
    expect(layoutDiagram(GRAPH)).toEqual(layoutDiagram(GRAPH));
  });

  test("node height caps at the max-rows footer", () => {
    const many = nodeHeightFor(100);
    expect(many).toBe(DIAGRAM_HEADER_HEIGHT + (DIAGRAM_MAX_ROWS + 1) * DIAGRAM_ROW_HEIGHT + 8);
    expect(nodeHeightFor(2)).toBe(DIAGRAM_HEADER_HEIGHT + 2 * DIAGRAM_ROW_HEIGHT + 8);
  });
});
