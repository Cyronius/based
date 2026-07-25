// Traces: BASED-EMBED-LABELS-AI
// One-shot cluster naming for the Embeddings view: sample snippets per cluster in, short names
// out. Deliberately a single generateText call against the active AI profile's model — not the
// agent loop (no tools, no memory, a few hundred output tokens). The prompt/parse halves are pure
// and unit-tested; the model call is the only impure line.
import { generateText, type LanguageModel } from "ai";

export interface LabelCluster {
  id: number;
  /** TF-IDF top terms — shown to the model as a hint AND used as the per-cluster fallback. */
  hint?: string;
  samples: string[];
}

export const MAX_LABEL_CLUSTERS = 24;
export const MAX_LABEL_SAMPLES = 10;
export const MAX_SAMPLE_CHARS = 300;

/** Server-enforced cost guard: over-limit input is truncated, never rejected. */
export function clampClusters(clusters: LabelCluster[]): LabelCluster[] {
  return clusters.slice(0, MAX_LABEL_CLUSTERS).map((c) => ({
    id: c.id,
    hint: c.hint,
    samples: (c.samples ?? []).slice(0, MAX_LABEL_SAMPLES).map((s) => String(s).slice(0, MAX_SAMPLE_CHARS)),
  }));
}

export function buildLabelPrompt(clusters: LabelCluster[]): { system: string; prompt: string } {
  const system =
    "You label clusters of database text snippets. Reply with ONLY a JSON array, no prose: " +
    '[{"id":0,"label":"..."}, ...]. Labels: 2-4 words, concrete, and distinct from each other.';
  const prompt = clusters
    .map((c) => {
      const head = `## Cluster ${c.id}${c.hint ? ` (top terms: ${c.hint})` : ""}`;
      const samples = c.samples.map((s, i) => `${i + 1}. ${s}`).join("\n");
      return `${head}\n${samples}`;
    })
    .join("\n\n");
  return { system, prompt };
}

/** Extract the first JSON array from the model's reply; per-cluster fallback to the TF-IDF hint
 *  (or a generic name) on missing/garbage entries. Unknown cluster ids are dropped. */
export function parseLabelResponse(text: string, clusters: LabelCluster[]): Array<{ id: number; label: string }> {
  const known = new Map(clusters.map((c) => [c.id, c]));
  const parsed = new Map<number, string>();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const arr = JSON.parse(text.slice(start, end + 1)) as unknown;
      if (Array.isArray(arr)) {
        for (const entry of arr) {
          const e = entry as { id?: unknown; label?: unknown };
          if (typeof e.id === "number" && typeof e.label === "string" && e.label.trim() && known.has(e.id)) {
            parsed.set(e.id, e.label.trim());
          }
        }
      }
    } catch {
      // fall through to hints
    }
  }
  return clusters.map((c) => ({ id: c.id, label: parsed.get(c.id) ?? c.hint ?? `Cluster ${c.id + 1}` }));
}

export async function labelClusters(
  model: LanguageModel,
  clusters: LabelCluster[],
  signal?: AbortSignal,
): Promise<Array<{ id: number; label: string }>> {
  const clamped = clampClusters(clusters);
  const { system, prompt } = buildLabelPrompt(clamped);
  const { text } = await generateText({ model, system, prompt, abortSignal: signal });
  return parseLabelResponse(text, clamped);
}
