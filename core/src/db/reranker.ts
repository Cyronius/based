// Traces: BASED-LANCE-RERANK-PIPELINE, BASED-LANCE-RERANK-OPENAI
// The external rerank step, in one of two wire shapes chosen by the profile's `api`:
//  - "rerank" (default): the de facto Cohere/TEI shape (POST {query, documents, top_n} ->
//    relevance scores) — one call for the whole candidate set.
//  - "openai": one chat-completions call per document against any OpenAI-compatible server
//    (LM Studio, llama-server, vLLM, OpenAI), scoring Qwen3-Reranker style: the model judges
//    yes/no and the score is the two-token softmax over the yes/no logprobs of the first
//    generated token. Nothing rerank-specific is needed server-side beyond logprobs support.
// Either way this is a separate, always-optional, always-external step — distinct from LanceDB's
// internal RRFReranker, which only ever fuses vector+FTS candidates inside hybrid mode.
import type { ResolvedRerankerProfile, RerankerRunOptions } from "./types";

export interface RerankResult {
  index: number;
  relevanceScore: number;
}

interface CohereShapeResult {
  index: number;
  relevance_score?: number;
  score?: number;
}

/** Upstream error bodies can be whole HTML error pages (LM Studio's 500 page) — reduce to one
 *  short text line before embedding in an Error message. */
function sanitizeErrorBody(text: string): string {
  const stripped = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return stripped.length > 300 ? `${stripped.slice(0, 300)}…` : stripped;
}

export async function rerank(
  profile: ResolvedRerankerProfile,
  query: string,
  documents: string[],
  opts?: RerankerRunOptions,
): Promise<RerankResult[]> {
  if ((profile.api ?? "rerank") === "openai") return rerankOpenAi(profile, query, documents, opts);
  return rerankCohere(profile, query, documents, opts);
}

async function rerankCohere(
  profile: ResolvedRerankerProfile,
  query: string,
  documents: string[],
  opts?: RerankerRunOptions,
): Promise<RerankResult[]> {
  const url = `${profile.baseUrl.replace(/\/$/, "")}/rerank`;
  const body: Record<string, unknown> = { query, documents };
  if (profile.model) body.model = profile.model;
  if (opts?.topN != null) body.top_n = opts.topN;
  if (opts?.temperature != null) body.temperature = opts.temperature;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Rerank endpoint returned ${res.status}${text ? `: ${sanitizeErrorBody(text)}` : ""}`);
  }
  const json = (await res.json()) as unknown;
  // Cohere wraps results in {results:[...]}; some TEI builds return a bare array. Field name also
  // varies (relevance_score vs score) — handle both defensively.
  const arr: CohereShapeResult[] | undefined = Array.isArray(json)
    ? (json as CohereShapeResult[])
    : (json as { results?: CohereShapeResult[] }).results;
  if (!arr) throw new Error("Rerank endpoint returned an unrecognized response shape");
  return arr.map((r) => ({ index: r.index, relevanceScore: r.relevance_score ?? r.score ?? 0 }));
}

// --- openai api: Qwen3-Reranker yes/no logprob scoring over chat completions ---

// The prompt format Qwen3-Reranker was trained on (its model card's usage).
const JUDGE_SYSTEM_PROMPT =
  'Judge whether the Document meets the requirements based on the Query and the Instruct provided. Note that the answer can only be "yes" or "no".';
export const DEFAULT_RERANK_INSTRUCTION = "Given a web search query, retrieve relevant passages that answer the query";

/** One request per document; keep the fan-out bounded so a 50-candidate pool doesn't open 50 sockets. */
const OPENAI_RERANK_CONCURRENCY = 8;

/** Pause before a document's single retry — long enough for a slot-level hiccup to clear, short
 *  enough that a whole flaky pool retries within one perceptible beat. */
const OPENAI_RERANK_RETRY_BACKOFF_MS = 300;

/** A per-document failure worth one retry (5xx, network error, 200-with-no-logprobs) — LM Studio
 *  exhibits all three transiently under concurrent load. 4xx stays a plain Error: that's
 *  misconfiguration (bad key/model), and retrying or degrading would only mask it. */
class TransientRerankError extends Error {}

interface TopLogprobEntry {
  token: string;
  logprob: number;
}

interface ChatLogprobsResponse {
  choices?: Array<{ logprobs?: { content?: Array<{ top_logprobs?: TopLogprobEntry[] }> } }>;
}

/** Relevance from the first generated token's top_logprobs: sum probability mass over all
 *  case/whitespace variants of "yes" and "no", then pYes/(pYes+pNo). When "no" isn't in the
 *  returned top-k (model is confident), raw pYes still ranks correctly. Neither present (e.g. a
 *  thinking-enabled template emitting `<think>`) → null, so callers can distinguish "scored 0"
 *  from "couldn't score at all". */
export function scoreFromTopLogprobs(entries: TopLogprobEntry[]): number | null {
  let pYes = 0;
  let pNo = 0;
  for (const e of entries) {
    const t = e.token.trim().toLowerCase();
    if (t === "yes") pYes += Math.exp(e.logprob);
    else if (t === "no") pNo += Math.exp(e.logprob);
  }
  if (pYes === 0 && pNo === 0) return null;
  if (pNo === 0) return pYes;
  return pYes / (pYes + pNo);
}

async function rerankOpenAi(
  profile: ResolvedRerankerProfile,
  query: string,
  documents: string[],
  opts?: RerankerRunOptions,
): Promise<RerankResult[]> {
  const url = `${profile.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const instruction = profile.instruction?.trim() || DEFAULT_RERANK_INSTRUCTION;

  const transientErrors: TransientRerankError[] = [];

  async function attemptDocument(doc: string): Promise<number | null> {
    const body: Record<string, unknown> = {
      messages: [
        { role: "system", content: JUDGE_SYSTEM_PROMPT },
        { role: "user", content: `<Instruct>: ${instruction}\n<Query>: ${query}\n<Document>: ${doc}` },
      ],
      max_tokens: 1,
      temperature: 0,
      logprobs: true,
      top_logprobs: 20,
    };
    if (profile.model) body.model = profile.model;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(profile.apiKey ? { authorization: `Bearer ${profile.apiKey}` } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new TransientRerankError(`Rerank chat endpoint unreachable: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const message = `Rerank chat endpoint returned ${res.status}${text ? `: ${sanitizeErrorBody(text)}` : ""}`;
      throw res.status >= 500 ? new TransientRerankError(message) : new Error(message);
    }
    const json = (await res.json()) as ChatLogprobsResponse;
    const entries = json.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs;
    if (!entries) {
      // LM Studio intermittently drops logprobs under concurrent load, so this is transient
      // (retryable) rather than proof the server can't do logprobs at all.
      throw new TransientRerankError(
        "Rerank chat endpoint returned no logprobs — the server may not support logprobs on chat completions.",
      );
    }
    return scoreFromTopLogprobs(entries);
  }

  /** One retry on transient failure; a persistently flaky document degrades to null (→ score 0)
   *  instead of failing the whole rerank — only an all-documents failure aborts (below). */
  async function scoreDocument(doc: string): Promise<number | null> {
    try {
      return await attemptDocument(doc);
    } catch (err) {
      if (!(err instanceof TransientRerankError)) throw err;
      await new Promise((resolve) => setTimeout(resolve, OPENAI_RERANK_RETRY_BACKOFF_MS));
      try {
        return await attemptDocument(doc);
      } catch (retryErr) {
        if (!(retryErr instanceof TransientRerankError)) throw retryErr;
        transientErrors.push(retryErr);
        return null;
      }
    }
  }

  // Bounded worker pool over the documents, preserving index pairing.
  const scores: Array<number | null> = new Array(documents.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(OPENAI_RERANK_CONCURRENCY, documents.length) }, async () => {
      while (next < documents.length) {
        const i = next++;
        scores[i] = await scoreDocument(documents[i]!);
      }
    }),
  );

  if (documents.length > 0 && scores.every((s) => s === null)) {
    const lastTransient = transientErrors[transientErrors.length - 1];
    if (lastTransient) {
      throw new Error(`Rerank chat endpoint failed for every document — ${lastTransient.message}`);
    }
    throw new Error(
      'Rerank chat endpoint never put "yes" or "no" in its top logprobs — the model is likely not a yes/no reranker, ' +
        "or its chat template has thinking enabled (first token `<think>`). Use a non-thinking template/conversion.",
    );
  }

  const results = scores
    .map((s, index) => ({ index, relevanceScore: s ?? 0 }))
    .sort((a, b) => b.relevanceScore - a.relevanceScore);
  // Mirror the Cohere endpoint's top_n semantics based-side: only the best topN survive.
  return opts?.topN != null ? results.slice(0, Math.max(0, Math.floor(opts.topN))) : results;
}
