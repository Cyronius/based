// Traces: BASED-RECONNECT-RETRY
import { describe, expect, test } from "bun:test";
import { isRetryableError, MAX_RECONNECT_ATTEMPTS, withReconnect } from "@based/core";

// No-op delay so backoff tests run instantly instead of waiting out real timers.
const noDelay = async () => {};

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
      delay: noDelay,
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
    expect(mints).toBe(2);
    expect(sawReconnecting).toBe(true);
  });

  test("always-failing retryable error propagates after exactly MAX_RECONNECT_ATTEMPTS attempts, with backoff between each", async () => {
    let attempts = 0;
    let delays = 0;
    await expect(
      withReconnect({
        attempt: async () => {
          attempts++;
          throw socketClosed;
        },
        rebuild: async () => {},
        onReconnecting: () => {},
        delay: async () => {
          delays++;
        },
      }),
    ).rejects.toThrow("socket hang up");
    expect(attempts).toBe(MAX_RECONNECT_ATTEMPTS);
    expect(delays).toBe(MAX_RECONNECT_ATTEMPTS - 1);
  });

  test("fails MAX_RECONNECT_ATTEMPTS - 1 times then succeeds: cap isn't exhausted", async () => {
    let attempts = 0;
    const result = await withReconnect({
      attempt: async () => {
        attempts++;
        if (attempts < MAX_RECONNECT_ATTEMPTS) throw socketClosed;
        return "ok";
      },
      rebuild: async () => {},
      onReconnecting: () => {},
      delay: noDelay,
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(MAX_RECONNECT_ATTEMPTS);
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
        delay: noDelay,
      }),
    ).rejects.toThrow("Incorrect syntax");
    expect(attempts).toBe(1);
    expect(rebuilds).toBe(0);
  });
});
