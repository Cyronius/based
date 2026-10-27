// Traces: BASED-CONN-ERROR-TEXT
import { describe, expect, test } from "bun:test";
import { describeConnectError } from "../../../ui/src/lib/connectError";

describe("BASED-CONN-ERROR-TEXT: describeConnectError", () => {
  test("SQL Server host not reachable names the host and keeps the raw text", () => {
    const raw = "Failed to connect to localhost:15433 - Could not connect (sequence)";
    expect(describeConnectError(raw)).toEqual({ summary: "Server not reachable at localhost:15433", detail: raw });
  });

  test("login failure names the user", () => {
    expect(describeConnectError("Login failed for user 'sa'.").summary).toBe("Login failed for sa");
  });

  test("unknown host", () => {
    expect(describeConnectError("getaddrinfo ENOTFOUND nosuch.example.com").summary).toBe("Server name not found: nosuch.example.com");
  });

  test("Snowflake credentials and role", () => {
    expect(describeConnectError("Incorrect username or password was specified.").summary).toBe("Incorrect username or password");
    expect(describeConnectError("Role 'ANALYST' specified in the connect string does not exist or not authorized.").summary).toBe(
      "Role ANALYST does not exist or is not granted to this user",
    );
  });

  test("Azure CLI sign-in", () => {
    expect(describeConnectError("AzureCliCredential authentication failed. Please run 'az login'.").summary).toBe(
      "Azure CLI sign-in needed — run az login",
    );
  });

  test("Lance missing folder", () => {
    expect(describeConnectError('Folder not found: "C:\\data\\lance"').summary).toBe("Folder not found: C:\\data\\lance");
  });

  test("timeout", () => {
    expect(describeConnectError("connect ETIMEDOUT 10.0.0.5:1433").summary).toBe("Connection timed out");
  });

  test("an unknown message passes through with no detail", () => {
    expect(describeConnectError("Something odd happened")).toEqual({ summary: "Something odd happened", detail: null });
  });
});
