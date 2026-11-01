// Traces: BASED-TYPE-NAMES
import { describe, expect, test } from "bun:test";
import { plainIndexType, plainTypeName } from "../../../ui/src/lib/typeNames";

describe("BASED-TYPE-NAMES plainTypeName", () => {
  test("Arrow names get a plain word", () => {
    expect(["Utf8", "LargeUtf8", "Int64", "UInt8", "Float64", "Float32", "Boolean", "Date32", "Timestamp(Microsecond, None)", "Binary"].map(plainTypeName)).toEqual([
      "text", "text", "integer", "integer", "number", "number", "true/false", "date", "date and time", "bytes",
    ]);
  });

  test("names that already read plainly, vectors, and SQL Server types get none", () => {
    expect(["date", "string", "vector[8] float32", "nvarchar", "int"].map(plainTypeName)).toEqual([null, null, null, null, null]);
  });
});

describe("BASED-TYPE-NAMES plainIndexType", () => {
  test("index kinds read as people say them", () => {
    expect(["fts", "INVERTED", "BTREE", "IVF_PQ", "clustered"].map(plainIndexType)).toEqual([
      "full-text", "full-text", "sorted (btree)", "vector (IVF_PQ)", "clustered",
    ]);
  });
});
