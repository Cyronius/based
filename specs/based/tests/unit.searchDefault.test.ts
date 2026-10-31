// Traces: BASED-LANCE-SEARCH-DEFAULT
import { describe, expect, test } from "bun:test";
import { defaultSearchMode } from "../../../ui/src/lib/searchDefault";

describe("BASED-LANCE-SEARCH-DEFAULT defaultSearchMode", () => {
  test("vector when a vector column and an embedding profile both exist", () => {
    expect(defaultSearchMode({ hasFts: true, hasVectorColumn: true, hasEmbeddingProfile: true })).toBe("vector");
  });

  test("text when there is no profile but a full-text index", () => {
    expect(defaultSearchMode({ hasFts: true, hasVectorColumn: true, hasEmbeddingProfile: false })).toBe("text");
  });

  test("vector with no profile and no full-text index (the hint shows)", () => {
    expect(defaultSearchMode({ hasFts: false, hasVectorColumn: true, hasEmbeddingProfile: false })).toBe("vector");
  });

  test("text when there is a full-text index and no vector column", () => {
    expect(defaultSearchMode({ hasFts: true, hasVectorColumn: false, hasEmbeddingProfile: true })).toBe("text");
  });

  test("null when the table can run no search", () => {
    expect(defaultSearchMode({ hasFts: false, hasVectorColumn: false, hasEmbeddingProfile: true })).toBeNull();
  });

  test("unknown capability (null) counts as available", () => {
    expect(defaultSearchMode({ hasFts: null, hasVectorColumn: null, hasEmbeddingProfile: false })).toBe("text");
  });
});
