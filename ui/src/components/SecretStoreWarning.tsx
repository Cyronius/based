// Traces: BASED-SECRET-STORE — the pre-save plaintext warning (plans/plaintext-secret-fallback.md).
// Rendered above every secret input (profile editors, connection dialog). Null when the OS keyring
// works; when it doesn't, the user learns their key will be stored unencrypted BEFORE typing it,
// not from a log line after.
import { useEffect, useState } from "react";
import { getSecretStore } from "../api/client";

export function SecretStoreWarning() {
  const [status, setStatus] = useState<{ backend: "keyring" | "plaintext"; reason?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    getSecretStore().then((s) => alive && setStatus(s)).catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  if (status?.backend !== "plaintext") return null;
  return (
    <div className="rounded border border-warn/40 bg-warn/10 px-2 py-1 text-warn text-[length:var(--fs-sm)] leading-snug">
      The OS keyring is unavailable{status.reason ? ` (${status.reason})` : ""}. Secrets saved here are
      stored <strong>unencrypted</strong> in app.db.
    </div>
  );
}
