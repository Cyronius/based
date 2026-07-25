// Traces: BASED-EMBED-WIRE
// Binary wire format for raw vector samples: [u32 LE headerLen][JSON header, space-padded to
// 4-byte alignment][raw float32 block]. The alignment guarantee is what lets the client build a
// Float32Array view directly over the response buffer without a copy.
import { describe, expect, test } from "bun:test";
import { encodeVectorSample, decodeVectorSample } from "@based/core";
import type { VectorSampleResult } from "@based/core";

function sample(overrides: Partial<VectorSampleResult> = {}): VectorSampleResult {
  return {
    dim: 4,
    count: 3,
    totalRows: 10,
    sampled: true,
    columns: [
      { name: "id", type: "Int32" },
      { name: "text", type: "Utf8" },
    ],
    rows: [
      [1, "alpha"],
      [2, "beta"],
      [3, "gamma"],
    ],
    vectors: new Float32Array([0.1, 0.2, 0.3, 0.4, 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4]),
    ...overrides,
  };
}

describe("BASED-EMBED-WIRE: vector sample binary encoding", () => {
  test("encode → decode round-trips header fields and the exact float block", () => {
    const s = sample();
    const decoded = decodeVectorSample(encodeVectorSample(s));
    expect(decoded.dim).toBe(4);
    expect(decoded.count).toBe(3);
    expect(decoded.totalRows).toBe(10);
    expect(decoded.sampled).toBe(true);
    expect(decoded.columns).toEqual(s.columns);
    expect(decoded.rows).toEqual(s.rows);
    expect(Array.from(decoded.vectors)).toEqual(Array.from(s.vectors));
  });

  test("float block starts at a 4-byte-aligned offset regardless of header length", () => {
    // Vary header length by 0..3 bytes via the text cell to sweep all padding cases.
    for (const text of ["a", "ab", "abc", "abcd"]) {
      const s = sample({ rows: [[1, text], [2, "x"], [3, "y"]] });
      const encoded = encodeVectorSample(s);
      const headerLen = new DataView(encoded.buffer, encoded.byteOffset).getUint32(0, true);
      expect((4 + headerLen) % 4).toBe(0);
      const decoded = decodeVectorSample(encoded);
      expect(Array.from(decoded.vectors)).toEqual(Array.from(s.vectors));
    }
  });

  test("multibyte utf8 in the header pads by encoded byte length, not string length", () => {
    const s = sample({ rows: [[1, "héllo ✓"], [2, "日本語"], [3, "z"]] });
    const decoded = decodeVectorSample(encodeVectorSample(s));
    expect(decoded.rows[0]![1]).toBe("héllo ✓");
    expect(decoded.rows[1]![1]).toBe("日本語");
    expect(Array.from(decoded.vectors)).toEqual(Array.from(s.vectors));
  });

  test("empty sample (count 0) survives the round trip", () => {
    const s = sample({ count: 0, rows: [], vectors: new Float32Array(0), sampled: false });
    const decoded = decodeVectorSample(encodeVectorSample(s));
    expect(decoded.count).toBe(0);
    expect(decoded.vectors.length).toBe(0);
  });
});
