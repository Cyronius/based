// Traces: BASED-LANCE-SEARCH-SCORE — how search results draw; the data and what Copy/Export see never change.
export const SCORE_COLUMN = /^_(score|distance|relevance_score|rerank_score)$/;

const SCORE_FORMAT = new Intl.NumberFormat("en-US", { maximumSignificantDigits: 3, useGrouping: false });

export function formatScore(v: number): string {
  return SCORE_FORMAT.format(v);
}

/** Words of a keyword query worth marking; one-letter words and FTS syntax are dropped. */
export function queryTerms(query: string): string[] {
  const words = query.toLowerCase().match(/[\p{L}\p{N}_]{2,}/gu) ?? [];
  return [...new Set(words.filter((w) => !["and", "or", "not"].includes(w)))];
}

/** [start, end) of each whole-word, case-insensitive match of any term. */
export function matchRanges(text: string, terms: string[]): Array<[number, number]> {
  if (terms.length === 0 || !text) return [];
  const alt = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alt})(?![\\p{L}\\p{N}_])`, "giu");
  return [...text.matchAll(re)].map((m) => [m.index!, m.index! + m[0].length]);
}
