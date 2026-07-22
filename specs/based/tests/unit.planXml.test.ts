// Traces: BASED-EXEC-PLAN
import { describe, expect, test } from "bun:test";
import { parsePlanXml, layoutPlan, NODE_WIDTH, NODE_HEIGHT } from "../../../ui/src/planXml";

// A hand-built but structurally faithful fixture: root Nested Loops over an Index Seek (leaf) and a
// Filter (wrapping a Table Scan leaf) — covers RelOp nesting, Object/Predicate extraction, and
// per-thread actual-counter aggregation for a parallel plan.
const FIXTURE_XML = `<ShowPlanXML xmlns="http://schemas.microsoft.com/sqlserver/2004/07/showplan">
  <BatchSequence>
    <Batch>
      <Statements>
        <StmtSimple StatementText="SELECT ...">
          <QueryPlan>
            <RelOp NodeId="0" PhysicalOp="Nested Loops" LogicalOp="Inner Join" EstimateRows="7" EstimatedTotalSubtreeCost="0.05">
              <RunTimeInformation>
                <RunTimeCountersPerThread Thread="0" ActualRows="3" ActualExecutions="1" />
                <RunTimeCountersPerThread Thread="1" ActualRows="4" ActualExecutions="1" />
              </RunTimeInformation>
              <NestedLoops>
                <RelOp NodeId="1" PhysicalOp="Index Seek" LogicalOp="Index Seek" EstimateRows="5" EstimatedTotalSubtreeCost="0.02">
                  <IndexScan>
                    <Object Schema="[dbo]" Table="[Foo]" Index="[PK_Foo]" />
                  </IndexScan>
                </RelOp>
                <RelOp NodeId="2" PhysicalOp="Filter" LogicalOp="Filter" EstimateRows="5" EstimatedTotalSubtreeCost="0.02">
                  <Filter>
                    <Predicate>
                      <ScalarOperator ScalarString="[Foo].[Bar]=1" />
                    </Predicate>
                    <RelOp NodeId="3" PhysicalOp="Table Scan" LogicalOp="Table Scan" EstimateRows="100" EstimatedTotalSubtreeCost="0.01">
                      <TableScan>
                        <Object Schema="[dbo]" Table="[Baz]" />
                      </TableScan>
                    </RelOp>
                  </Filter>
                </RelOp>
              </NestedLoops>
            </RelOp>
          </QueryPlan>
        </StmtSimple>
      </Statements>
    </Batch>
  </BatchSequence>
</ShowPlanXML>`;

describe("BASED-EXEC-PLAN: parsePlanXml", () => {
  test("builds the operator tree with correct nesting", () => {
    const [root] = parsePlanXml(FIXTURE_XML);
    expect(root).toBeDefined();
    expect(root!.nodeId).toBe("0");
    expect(root!.physicalOp).toBe("Nested Loops");
    expect(root!.children.map((c) => c.nodeId)).toEqual(["1", "2"]);
    expect(root!.children[1]!.children.map((c) => c.nodeId)).toEqual(["3"]);
    expect(root!.children[0]!.children).toEqual([]);
  });

  test("extracts the object accessed by a leaf scan operator", () => {
    const [root] = parsePlanXml(FIXTURE_XML);
    expect(root!.children[0]!.object).toBe("dbo.Foo (PK_Foo)");
    expect(root!.children[1]!.children[0]!.object).toBe("dbo.Baz");
  });

  test("extracts the predicate's pre-rendered ScalarString", () => {
    const [root] = parsePlanXml(FIXTURE_XML);
    expect(root!.children[1]!.predicate).toBe("[Foo].[Bar]=1");
    expect(root!.children[0]!.predicate).toBeNull();
  });

  test("aggregates actual rows/executions across parallel threads rather than reading only the first", () => {
    const [root] = parsePlanXml(FIXTURE_XML);
    expect(root!.actualRows).toBe(7); // 3 + 4
    expect(root!.actualExecutions).toBe(2); // 1 + 1
    expect(root!.children[0]!.actualRows).toBeNull(); // no RunTimeInformation on this leaf
  });

  test("no plan operators for malformed/empty input yields an empty root list", () => {
    expect(parsePlanXml("<ShowPlanXML></ShowPlanXML>")).toEqual([]);
  });
});

describe("BASED-EXEC-PLAN: layoutPlan", () => {
  test("assigns depth-based y and leaf-packed x, with edges matching parent/child nodeIds", () => {
    const [root] = parsePlanXml(FIXTURE_XML);
    const { nodes, edges } = layoutPlan(root!);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    expect(byId.get("0")!.y).toBe(0);
    expect(byId.get("1")!.y).toBe(NODE_HEIGHT + 90);
    expect(byId.get("2")!.y).toBe(NODE_HEIGHT + 90);
    expect(byId.get("3")!.y).toBe((NODE_HEIGHT + 90) * 2);

    // leaf 1 packed at x=0, leaf 3 packed next at x = NODE_WIDTH + 40 (H_GAP)
    expect(byId.get("1")!.x).toBe(0);
    expect(byId.get("3")!.x).toBe(NODE_WIDTH + 40);
    // node 2 centers over its single child (node 3)
    expect(byId.get("2")!.x).toBe(byId.get("3")!.x);
    // root centers over its two children's x span
    expect(byId.get("0")!.x).toBe((byId.get("1")!.x + byId.get("2")!.x) / 2);

    expect(new Set(edges.map((e) => `${e.source}->${e.target}`))).toEqual(
      new Set(["0->1", "0->2", "2->3"]),
    );
  });

  test("cost % splits self-cost (subtree cost minus children's) against the root's total cost", () => {
    const [root] = parsePlanXml(FIXTURE_XML);
    const { nodes } = layoutPlan(root!);
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));

    // root: 0.05 total, children sum 0.04 → self 0.01 → 20% of 0.05
    expect(byId.get("0")!.costPercent).toBeCloseTo(20, 5);
    // leaf 1: no children → self cost = its own 0.02 → 40% of 0.05
    expect(byId.get("1")!.costPercent).toBeCloseTo(40, 5);
    // node 2: 0.02 total minus child (0.01) → self 0.01 → 20%
    expect(byId.get("2")!.costPercent).toBeCloseTo(20, 5);
    // leaf 3: self cost = 0.01 → 20%
    expect(byId.get("3")!.costPercent).toBeCloseTo(20, 5);

    const total = [...byId.values()].reduce((s, n) => s + (n.costPercent ?? 0), 0);
    expect(total).toBeCloseTo(100, 5);
  });
});
