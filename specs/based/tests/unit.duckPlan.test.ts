// Traces: BASED-LANCE-SQL-PLAN
import { describe, expect, test } from "bun:test";
import { parseDuckPlanJson } from "../../../ui/src/duckPlan";
import { layoutPlan } from "../../../ui/src/planXml";

// A structurally faithful trim of DuckDB's JSON profiling tree (as core/src/db/duckProfile.ts sends
// it): TOP_N → HASH_GROUP_BY → TABLE_SCAN, with actual cardinality, self timing, and extra_info.
const FIXTURE = JSON.stringify([
  {
    operator_type: "TOP_N",
    operator_cardinality: 3,
    operator_timing: 0.02,
    extra_info: { Top: "3", "Order By": "memory.main.t.id ASC" },
    children: [
      {
        operator_type: "HASH_GROUP_BY",
        operator_cardinality: 99989,
        operator_timing: 0.05,
        extra_info: { Groups: "#0", Aggregates: "sum(#1)", "Estimated Cardinality": "17682" },
        children: [
          {
            operator_type: "TABLE_SCAN",
            operator_cardinality: 99989,
            operator_timing: 0.001,
            extra_info: { Table: "memory.main.t", Type: "Sequential Scan", Filters: "id>10", "Estimated Cardinality": "20000" },
            children: [],
          },
        ],
      },
    ],
  },
]);

describe("parseDuckPlanJson", () => {
  test("maps operator fields and humanizes the type", () => {
    const roots = parseDuckPlanJson(FIXTURE);
    expect(roots.length).toBe(1);
    const top = roots[0]!;
    expect(top.physicalOp).toBe("Top N");
    const scan = top.children[0]!.children[0]!;
    expect(scan.physicalOp).toBe("Table Scan");
    expect(scan.actualRows).toBe(99989);
    expect(scan.estimateRows).toBe(20000);
    expect(scan.object).toBe("memory.main.t");
    expect(scan.predicate).toBe("Filters: id>10");
    expect(scan.logicalOp).toBe("Sequential Scan");
    // No estimate IO/CPU split from DuckDB.
    expect(scan.estimateIO).toBeNull();
    expect(scan.estimateCPU).toBeNull();
  });

  test("estimatedTotalSubtreeCost is cumulative, so layout cost% recovers each self-timing share", () => {
    const roots = parseDuckPlanJson(FIXTURE);
    // root cumulative = 0.02 + 0.05 + 0.001 = 0.071
    expect(roots[0]!.estimatedTotalSubtreeCost).toBeCloseTo(0.071, 6);
    const { nodes } = layoutPlan(roots[0]!);
    const byOp = new Map(nodes.map((n) => [n.physicalOp, n]));
    // HASH_GROUP_BY self-time 0.05 of 0.071 total ≈ 70.4%
    expect(byOp.get("Hash Group By")!.costPercent!).toBeCloseTo((0.05 / 0.071) * 100, 1);
  });

  test("malformed json yields an empty tree rather than throwing", () => {
    expect(parseDuckPlanJson("not json")).toEqual([]);
    expect(parseDuckPlanJson("[]")).toEqual([]);
  });
});
