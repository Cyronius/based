// Traces: BASED-SNOWFLAKE-AUTH, BASED-CONN-TEST
//
// Two properties, both regressions from the same incident: Snowflake "Test connection" produced no
// result at all — no success, no error, no timeout — because snowflake-sdk 3.1.0 awaits its cloud
// platform detection before sending the login request, and that detection never settles under Bun
// (its hasAwsIdentity detector calls @aws-sdk/client-sts, which ignores the abort signal there).
//
// 1. The adapter disables that detection before the SDK loads, so the driver reaches the network.
// 2. Independently of any specific driver bug, connect is bounded: it settles with a descriptive
//    error rather than hanging. This is the property that made the original fault diagnosable at
//    all, so it is asserted separately and must survive even if (1) is one day deleted as obsolete.
//
// Neither test needs Snowflake credentials or a reachable account.
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import type { ConnectionConfig } from "@based/core";

// A separate script file (not `bun -e`): multiline -e scripts break Windows argv quoting.
const CHILD_SCRIPT_PATH = join(import.meta.dir, "helpers", "snowflakeEnvChild.ts");

function snowflakeCfg(account: string): ConnectionConfig {
  return {
    id: "snowflake-connect-spec",
    name: "snowflake-connect-spec",
    server: "",
    database: "SPEC_DB",
    authType: "snowflake-password",
    engine: "snowflake",
    encrypt: true,
    trustServerCertificate: false,
    createdAt: "",
    updatedAt: "",
    settings: { account, username: "spec-user", schema: "PUBLIC" },
  } as ConnectionConfig;
}

describe("Snowflake connect", () => {
  test("BASED-SNOWFLAKE-AUTH: the driver never loads before platform detection is disabled", async () => {
    const proc = Bun.spawn(["bun", CHILD_SCRIPT_PATH], {
      cwd: import.meta.dir,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, err).toBe(0);
    // The driver logs its own JSON lines to stdout, so the report is picked out by its prefix.
    const line = out.split("\n").find((l) => l.startsWith("__REPORT__"));
    expect(line, out).toBeDefined();
    const report = JSON.parse(line!.slice("__REPORT__".length)) as {
      lazyOnImport: boolean;
      driverLoaded: boolean;
      env: string | null;
      settled: boolean;
      platforms: string[];
    };

    // Importing the adapter must not load the driver — that is what lets the env var be set in time.
    expect(report.lazyOnImport).toBe(true);
    expect(report.driverLoaded).toBe(true); // …and connecting must actually have loaded it
    expect(report.env).toBe("true");
    // The assertion that actually matters: the promise sf.js awaits before sending the login
    // request resolves. Set too late, this never settles and connect hangs forever with no error.
    expect(report.settled).toBe(true);
    expect(report.platforms).toEqual(["disabled"]);
  }, 60_000);

  test("BASED-CONN-TEST: probe on an unreachable account fails with an error instead of hanging", async () => {
    const { SnowflakeAdapter } = await import("@based/core/snowflake");
    // A syntactically valid but non-existent account: the host does not resolve, so this exercises
    // the failure path end to end without touching anyone's real Snowflake.
    const adapter = new SnowflakeAdapter(
      snowflakeCfg("based-spec-no-such-account-zzzz"),
      () => "not-a-real-password",
    );

    const started = Date.now();
    const result = await adapter.probe();
    const elapsed = Date.now() - started;

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.length).toBeGreaterThan(0);
    // The driver's own retry budget is 300s and cannot be lowered (connection_config clamps
    // retryTimeout to Math.max(300, yours)), so a pass here is the adapter's bound doing the work.
    expect(elapsed).toBeLessThan(60_000);
  }, 90_000);

  test("BASED-SNOWFLAKE-AUTH: a 404 from the login endpoint is reported as a bad account identifier", async () => {
    const { errMessage, snowflakeAccountNotFound } = await import("@based/core/snowflake");
    // Exactly what the driver hands back when the wildcard domain resolves but Snowflake's shared
    // load balancer hosts no such account — a legacy locator given without its region and cloud.
    const balancer404 = Object.assign(new Error("Request to Snowflake failed."), {
      code: 401002,
      response: { status: 404 },
    });

    expect(snowflakeAccountNotFound(balancer404)).toBe(true);
    const message = errMessage(balancer404);
    expect(message).toContain("account identifier");
    expect(message).toContain("us-east-2.aws");
    // The generic wording is what made this undiagnosable; it must not survive.
    expect(message).not.toContain("Request to Snowflake failed");

    // A real credential rejection reaches the same host and must keep its own message.
    const badPassword = Object.assign(new Error("Incorrect username or password was specified."), {
      code: "390100",
    });
    expect(snowflakeAccountNotFound(badPassword)).toBe(false);
    expect(errMessage(badPassword)).toContain("Incorrect username or password");
    // A 404 on some other request is not an account problem.
    expect(snowflakeAccountNotFound({ code: 401002 })).toBe(false);
    expect(snowflakeAccountNotFound({ code: "390100", response: { status: 404 } })).toBe(false);
  });
});
