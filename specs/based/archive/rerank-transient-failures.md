# Harden openai-api rerank against transient failures

LM Studio under 8-way concurrent rerank load intermittently returns HTTP 200 with
`logprobs: null` (reproduced: 1 of 8 parallel long-document requests), and returns an
HTML 500 page during cold model load. `rerankOpenAi` currently treats one such response
as fatal: the first failed `scoreDocument` rejects the whole worker pool and aborts the
entire search.

## Spec impact

**Modified: BASED-LANCE-RERANK-OPENAI** — acceptance criteria change:

- "A response with no `logprobs` content → descriptive error" becomes: a missing-logprobs
  or 5xx/network-failed response is retried once (short backoff); if it persists, that
  document scores 0 and the search completes; only when **no** document could be scored
  does the search fail, with a descriptive error mentioning logprobs support.
- Added: a transient 5xx on a single document is retried and does not abort the rerank;
  4xx responses still fail immediately (misconfiguration, not flakiness).
- Added: upstream error bodies embedded in error messages are HTML-stripped and truncated
  (applies to both the `rerank` and `openai` api paths).

No other requirements added/removed.
