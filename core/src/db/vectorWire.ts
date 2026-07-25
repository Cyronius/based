// Traces: BASED-EMBED-WIRE
// Binary wire format for a VectorSampleResult: [u32 LE headerLen][JSON header, space-padded so the
// float block starts 4-byte aligned][raw float32 block]. JSON would balloon a 5k×768 sample to tens
// of MB and floats don't gzip usefully, so the vectors ride as raw bytes; the alignment padding is
// what lets the client build a Float32Array view straight over the response buffer without a copy.
import type { VectorSampleResult } from "./types";

export function encodeVectorSample(sample: VectorSampleResult): Uint8Array {
  const { vectors, ...header } = sample;
  const headerJson = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - ((4 + headerJson.length) % 4)) % 4;
  const headerLen = headerJson.length + pad;
  const out = new Uint8Array(4 + headerLen + vectors.byteLength);
  new DataView(out.buffer).setUint32(0, headerLen, true);
  out.set(headerJson, 4);
  for (let i = 0; i < pad; i++) out[4 + headerJson.length + i] = 0x20; // trailing spaces — JSON.parse ignores them
  out.set(new Uint8Array(vectors.buffer, vectors.byteOffset, vectors.byteLength), 4 + headerLen);
  return out;
}

export function decodeVectorSample(data: Uint8Array | ArrayBuffer): VectorSampleResult {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < 4) throw new Error("Vector sample payload too short");
  const headerLen = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(bytes.subarray(4, 4 + headerLen))) as Omit<
    VectorSampleResult,
    "vectors"
  >;
  const floatStart = bytes.byteOffset + 4 + headerLen;
  const floatCount = (bytes.byteLength - 4 - headerLen) / 4;
  // The encoder guarantees 4+headerLen is a multiple of 4; a nonzero byteOffset on the caller's
  // view can still misalign the absolute offset, in which case we fall back to a copy.
  const vectors =
    floatStart % 4 === 0
      ? new Float32Array(bytes.buffer, floatStart, floatCount)
      : new Float32Array(bytes.slice(4 + headerLen).buffer, 0, floatCount);
  return { ...header, vectors };
}
