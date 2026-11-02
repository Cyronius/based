// Traces: BASED-ERROR-HEADLINE
import { describe, expect, test } from "bun:test";
import { errorHeadline } from "../../../ui/src/lib/errorText";

describe("BASED-ERROR-HEADLINE errorHeadline", () => {
  test("a one-line error is unchanged", () => {
    expect(errorHeadline("Invalid object name 'dbo.Nope'.")).toBe("Invalid object name 'dbo.Nope'.");
  });

  test("a multi-line error keeps its first line", () => {
    expect(errorHeadline('Folder not found: "D:/data"\n  at connect (lance.ts:10)')).toBe('Folder not found: "D:/data"');
  });

  test("a Rust chain drops Caused by frames and the source location", () => {
    const full =
      "Failed to execute query: Invalid user input: Cannot perform full text search unless an INVERTED index has been created on at least one column, /home/runner/work/lance/rust/lance/src/dataset/scanner.rs:1234:23 Caused by: lance error";
    expect(errorHeadline(full)).toBe(
      "Failed to execute query: Invalid user input: Cannot perform full text search unless an INVERTED index has been created on at least one column",
    );
  });

  test("an error that is only whitespace before its frames falls back to the whole text", () => {
    expect(errorHeadline("\nboom")).toBe("boom");
  });
});
