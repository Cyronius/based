// Traces: BASED-SNOWFLAKE-AUTH
// snowflake-sdk 3.1.0 runs cloud-platform detection at module load (telemetry/platform_detection.js:
// a Promise.all over 11 detectors) and services/sf.js awaits it before building the login payload.
// One of those detectors, hasAwsIdentity, calls @aws-sdk/client-sts STSClient.send(); under Bun
// that call never settles and ignores its abort signal, so the Promise.all never resolves, the login
// POST is never sent, and connectAsync hangs forever with no error and no log line after
// "authentication successful using: SNOWFLAKE" (which is emitted before any network call). Measured
// on Bun 1.3.14: getDetectedPlatforms() never resolves; the same import resolves in ~1s under Node 24.
//
// The detected value is telemetry only — it lands in CLIENT_ENVIRONMENT.PLATFORM on the login
// request — so turning it off costs nothing functional.
//
// This is a *function*, not a module side effect, because the SDK reads the variable at module-load
// time and Bun does not guarantee that a side-effect `import` ordered above `import "snowflake-sdk"`
// is evaluated first (verified: it is not). Its one caller is loadSdk() in snowflakeAdapter.ts,
// which is the only place the driver's value is loaded — that is what makes "in time" checkable
// rather than hopeful. `??=` so an explicitly-set environment still wins.
//
// Revisit once Bun settles or aborts that STS call, or once the SDK's own isBun branch in
// platform_detection.js covers the AWS path as well as the fetch one.
export function disableSdkPlatformDetection(): void {
  process.env.SNOWFLAKE_DISABLE_PLATFORM_DETECTION ??= "true";
}
