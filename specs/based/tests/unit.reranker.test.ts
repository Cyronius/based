// Traces: BASED-LANCE-RERANK-PIPELINE, BASED-LANCE-RERANK-OPENAI
// The two score parsers, in isolation (no HTTP). Both sit at a wire boundary where a shape we don't
// speak used to become a uniformly-zero score set — which is indistinguishable from a working rerank
// at every layer above: the adapter sorts by it, finds the order already "correct", and returns
// confidently-ranked garbage. These assert the parse fails loudly instead.
import { describe, expect, test } from "bun:test";
import { parseCohereRerankResults, scoreFromTopLogprobs } from "@based/core";

describe("BASED-LANCE-RERANK-PIPELINE: Cohere/TEI response parsing", () => {
  test("reads relevance_score, and score as the TEI alternative", () => {
    expect(parseCohereRerankResults({ results: [{ index: 1, relevance_score: 0.9 }] }, 2)).toEqual([
      { index: 1, relevanceScore: 0.9 },
    ]);
    expect(parseCohereRerankResults([{ index: 0, score: 0.4 }], 1)).toEqual([{ index: 0, relevanceScore: 0.4 }]);
  });

  test("a genuine zero survives — only an unscorable set is an error", () => {
    expect(parseCohereRerankResults({ results: [{ index: 0, relevance_score: 0 }] }, 1)).toEqual([
      { index: 0, relevanceScore: 0 },
    ]);
  });

  test("results carrying no recognized score field throw, naming the fields actually seen", () => {
    // The failure this exists for: an endpoint using a third field name (camelCase, nested) used to
    // yield every document scored 0 and no error anywhere.
    expect(() => parseCohereRerankResults({ results: [{ index: 0, relevanceScore: 0.9 }] }, 1)).toThrow(
      /no recognized score field.*relevanceScore/s,
    );
  });

  test("a response that is neither an array nor {results} is still a shape error", () => {
    expect(() => parseCohereRerankResults({ data: [] }, 1)).toThrow(/unrecognized response shape/);
    expect(() => parseCohereRerankResults(null, 1)).toThrow(/unrecognized response shape/);
  });

  test("an out-of-range or missing index throws instead of pairing a score to no document", () => {
    // index pairs the score back to its candidate row; an absent one would spread `records[undefined]`
    // into a result row carrying nothing but the score.
    expect(() => parseCohereRerankResults({ results: [{ index: 5, relevance_score: 1 }] }, 2)).toThrow(/out-of-range/);
    expect(() => parseCohereRerankResults({ results: [{ relevance_score: 1 }] }, 2)).toThrow(/out-of-range/);
  });

  test("an empty result set is not an error — it is simply nothing to reorder", () => {
    expect(parseCohereRerankResults({ results: [] }, 3)).toEqual([]);
  });
});

describe("BASED-LANCE-RERANK-OPENAI: yes/no logprob scoring", () => {
  test("scores the two-token softmax over yes/no, case- and whitespace-insensitively", () => {
    const s = scoreFromTopLogprobs([
      { token: " Yes", logprob: Math.log(0.75) },
      { token: "no", logprob: Math.log(0.25) },
    ]);
    expect(s).toBeCloseTo(0.75, 5);
  });

  test("with no 'no' in the top-k, raw pYes still ranks correctly", () => {
    expect(scoreFromTopLogprobs([{ token: "yes", logprob: Math.log(0.6) }])).toBeCloseTo(0.6, 5);
  });

  test("neither token present returns null — 'couldn't score', not 'scored zero'", () => {
    // A thinking-enabled chat template emits `<think>` first; the caller turns an all-null set into
    // a hard error naming that cause rather than silently ranking by zeros.
    expect(scoreFromTopLogprobs([{ token: "<think>", logprob: Math.log(0.99) }])).toBeNull();
    expect(scoreFromTopLogprobs([])).toBeNull();
  });
});
