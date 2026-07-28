// Traces: BASED-SNOWFLAKE-AUTH, BASED-LAZY-ENGINES — child probe run by
// integration.snowflakeConnect.test.ts in a fresh bun process.
//
// snowflake-sdk reads SNOWFLAKE_DISABLE_PLATFORM_DETECTION at module-load time, and its detection
// promise never settles under Bun (see core/src/db/snowflakeEnv.ts), which is what made connect hang
// forever. So the property under test is an ordering one: whichever path first loads the driver must
// have set the variable already. A fresh process is what makes it meaningful — in the shared test
// process another suite may already have loaded the driver.
import { createRequire } from "node:module";
import type { ConnectionConfig } from "@based/core";

const driverLoaded = (): boolean =>
  Object.keys(require.cache).some((k) => /[\\/]node_modules[\\/].*snowflake-sdk/i.test(k));

const { SnowflakeAdapter } = await import("@based/core/snowflake");
// Importing the adapter must not pull the driver in (the value import is lazy); the env var is
// therefore still untouched at this point, which is exactly why it can't be a module side effect.
const lazyOnImport = !driverLoaded();

const cfg = {
  id: "snowflake-env-child",
  name: "snowflake-env-child",
  server: "",
  database: "SPEC_DB",
  authType: "snowflake-password",
  engine: "snowflake",
  encrypt: true,
  trustServerCertificate: false,
  createdAt: "",
  updatedAt: "",
  settings: { account: "based-spec-no-such-account-zzzz", username: "spec-user" },
} as ConnectionConfig;

// Kick off a connect to force the lazy load, then wait for the driver to appear. The probe itself
// is left running; its result is irrelevant here and process.exit below discards it.
void new SnowflakeAdapter(cfg, () => "not-a-real-password").probe().catch(() => {});
for (let i = 0; i < 150 && !driverLoaded(); i++) await Bun.sleep(100);

// snowflake-sdk is a dependency of core, not of specs, so resolve it from the adapter module rather
// than from here — no path arithmetic to rot. It is CJS, so this returns the very module instance
// the driver itself is holding: the real detection result, not a second run of it.
const pd = createRequire(import.meta.resolve("@based/core/snowflake"))(
  "snowflake-sdk/dist/lib/telemetry/platform_detection",
) as { getDetectedPlatforms: () => Promise<string[]> };

const settled = await Promise.race([
  pd.getDetectedPlatforms().then((platforms) => ({ settled: true, platforms })),
  new Promise<{ settled: boolean; platforms: string[] }>((resolve) =>
    setTimeout(() => resolve({ settled: false, platforms: [] }), 10_000),
  ),
]);

// Prefixed because the driver writes its own JSON log lines to stdout and would otherwise be
// indistinguishable from this report.
console.log(
  "__REPORT__" +
    JSON.stringify({
      lazyOnImport,
      driverLoaded: driverLoaded(),
      env: process.env.SNOWFLAKE_DISABLE_PLATFORM_DETECTION ?? null,
      ...settled,
    }),
);
process.exit(0);
