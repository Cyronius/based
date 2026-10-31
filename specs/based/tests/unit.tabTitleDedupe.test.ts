// Traces: BASED-TAB-TITLE-DEDUPE
import { describe, expect, test } from "bun:test";
import { dedupeTitles } from "../../../ui/src/lib/dedupeTitles";

describe("BASED-TAB-TITLE-DEDUPE dedupeTitles", () => {
  test("unique titles are unchanged", () => {
    const m = dedupeTitles([{ id: "a", title: "select Orders" }, { id: "b", title: "Query 2" }]);
    expect([...m.entries()]).toEqual([["a", "select Orders"], ["b", "Query 2"]]);
  });

  test("duplicates are suffixed in tab order, the first keeps its title", () => {
    const m = dedupeTitles([
      { id: "a", title: "select plain" },
      { id: "b", title: "docs" },
      { id: "c", title: "select plain" },
      { id: "d", title: "select plain" },
    ]);
    expect([m.get("a"), m.get("b"), m.get("c"), m.get("d")]).toEqual(["select plain", "docs", "select plain (2)", "select plain (3)"]);
  });

  test("closing a tab renumbers the rest", () => {
    const m = dedupeTitles([{ id: "c", title: "select plain" }, { id: "d", title: "select plain" }]);
    expect([m.get("c"), m.get("d")]).toEqual(["select plain", "select plain (2)"]);
  });
});
