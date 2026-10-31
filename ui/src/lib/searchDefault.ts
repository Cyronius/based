// Traces: BASED-LANCE-SEARCH-DEFAULT — open on a mode that can run now; null capability = unknown = allowed.
import type { LanceSearchMode } from "../api/types";

export function defaultSearchMode(t: {
  hasFts: boolean | null;
  hasVectorColumn: boolean | null;
  hasEmbeddingProfile: boolean;
}): LanceSearchMode | null {
  const vector = t.hasVectorColumn !== false;
  const text = t.hasFts !== false;
  if (vector && t.hasEmbeddingProfile) return "vector";
  if (text) return "text";
  if (vector) return "vector";
  return null;
}
