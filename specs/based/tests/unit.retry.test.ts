// Traces: BASED-RECONNECT-RETRY
import { describe, expect, test } from "bun:test";
import { isRetryableError, withReconnect } from "@based/core";

const tokenExpired = Object.assign(new Error("Login failed: access token is expired"), { code: "ELOGIN" });
const socketClosed = Object.assign(new Error("socket hang up"), { code: "ESOCKET" });
const syntaxError = Object.assign(new Error("Incorrect syntax near 'SELEC'"), { code: "EREQUEST", number: 102 });

describe("BASED-RECONNECT-RETRY: retry orchestration", () => {
  test("classification: token expiry and socket loss are retryable, SQL errors are not", () => {
    expect(isRetryableError(tokenExpired)).toBe(true);
    expect(isRetryableError(socketClosed)).toBe(true);
    expect(isRetryableError(syntaxError)).toBe(false);
    expect(isRetryableError({ message: "Connection is closed." })).toBe(true);
  });

  test("fails once with token expiry then succeeds: rebuild (re-mint) ran, reconnecting announced", async () => {
    let attempts = 0;
    let mints = 1; // initial pool build minted once
    let sawReconnecting = false;
    const result = await withReconnect({
      attempt: async () => {
        attempts++;
        if (attempts === 1) throw tokenExpired;
        return "ok";
      },
      rebuild: async () => {
        mints++;
      },
      onReconnecting: () => {
        sawReconnecting = true;
      },
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(mints).toBe(2);
    expect(sawReconnecting).toBe(true);
  });

  test("always-failing retryable error propagates after exactly 2 attempts", async () => {
    let attempts = 0;
    await expect(
      withReconnect({
        attempt: async () => {
          attempts++;
          throw socketClosed;
        },
        rebuild: async () => {},
        onReconnecting: () => {},
      }),
    ).rejects.toThrow("socket hang up");
    expect(attempts).toBe(2);
  });

  test("non-retryable error: no retry, 1 attempt", async () => {
    let attempts = 0;
    let rebuilds = 0;
    await expect(
      withReconnect({
        attempt: async () => {
          attempts++;
          throw syntaxError;
        },
        rebuild: async () => {
          rebuilds++;
        },
        onReconnecting: () => {},
      }),
    ).rejects.toThrow("Incorrect syntax");
    expect(attempts).toBe(1);
    expect(rebuilds).toBe(0);
  });
});
