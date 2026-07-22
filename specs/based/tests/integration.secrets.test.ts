// Traces: BASED-SECRET-STORE
import { describe, expect, test } from "bun:test";
import { setSecret, getSecret, deleteSecret } from "@based/core";

const TEST_ID = `spec-test-${process.pid}`;

describe("BASED-SECRET-STORE: Windows Credential Manager round-trip", () => {
  test("set → get → delete → get null", () => {
    try {
      setSecret(TEST_ID, "s3cret-value");
      expect(getSecret(TEST_ID)).toBe("s3cret-value");
      deleteSecret(TEST_ID);
      expect(getSecret(TEST_ID)).toBeNull();
    } finally {
      deleteSecret(TEST_ID);
    }
  });

  test("get of never-stored id is null, delete is a no-op", () => {
    expect(getSecret("spec-test-never-stored")).toBeNull();
    deleteSecret("spec-test-never-stored");
  });
});
