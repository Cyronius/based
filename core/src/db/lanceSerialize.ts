// Traces: BASED-LANCE-WIRE
// Turn a LanceDB (Arrow-materialized) cell value into a JSON-safe WireValue. Vector columns are
// summarized to a small preview so a 1536-dim embedding never floods the grid or the model context;
// scalars reuse the shared serializer.
import type { WireValue } from "./types";
import { serializeValue } from "./serialize";

/** How many leading components of a vector to carry to the client for display. */
const VEC_PREVIEW = 8;

/** True for a plain array, a TypedArray, or an apache-arrow Vector — all of which LanceDB may hand
 *  back for a list-typed cell. Excludes strings (also iterable) so scalars stay scalars. */
function isSequence(v: unknown): v is Iterable<unknown> {
  if (Array.isArray(v) || ArrayBuffer.isView(v)) return true;
  return typeof v === "object" && v !== null && typeof (v as Record<symbol, unknown>)[Symbol.iterator] === "function";
}

export function serializeLanceValue(v: unknown, isVector: boolean): WireValue {
  if (v === null || v === undefined) return null;
  if (isVector && isSequence(v)) {
    const nums = Array.from(v as Iterable<number>, (x) => Number(x));
    return { $: "vec", dim: nums.length, preview: nums.slice(0, VEC_PREVIEW) };
  }
  // A non-vector sequence or a nested struct → compact JSON summary (serializeValue would flatten it).
  if (isSequence(v)) {
    try {
      return JSON.stringify(Array.from(v as Iterable<unknown>));
    } catch {
      return "[unrenderable]";
    }
  }
  if (typeof v === "object" && !(v instanceof Date) && !(v instanceof Uint8Array)) {
    try {
      return JSON.stringify(v);
    } catch {
      return "[unrenderable]";
    }
  }
  return serializeValue(v);
}
