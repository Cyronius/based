// Traces: BASED-LANCE-SEARCH-SCORE
import { describe, expect, test } from "bun:test";
import { formatScore, matchRanges, queryTerms, SCORE_COLUMN } from "../../../ui/src/lib/searchDisplay";

describe("BASED-LANCE-SEARCH-SCORE", () => {
  test("scores show three significant figures", () => {
    expect([formatScore(0.123456789), formatScore(12.3456), formatScore(1234.5), formatScore(0.5)]).toEqual(["0.123", "12.3", "1230", "0.5"]);
  });

  test("only the engine's score columns count as scores", () => {
    expect(["_score", "_distance", "_relevance_score", "_rerank_score", "score", "_rowid"].map((c) => SCORE_COLUMN.test(c))).toEqual([
      true, true, true, true, false, false,
    ]);
  });

  test("query terms drop one-letter words, boolean words, and repeats", () => {
    expect(queryTerms('Refund "late" AND a refund')).toEqual(["refund", "late"]);
  });

  test("matches are whole words and ignore case", () => {
    expect(matchRanges("Refunds: refund the late fee. Late!", ["refund", "late"])).toEqual([[9, 15], [20, 24], [30, 34]]);
  });

  test("no terms, no matches", () => {
    expect(matchRanges("anything", [])).toEqual([]);
  });
});
