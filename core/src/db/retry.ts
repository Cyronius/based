// Traces: BASED-RECONNECT-RETRY

/** Retryable = the connection died underneath us (expired Entra token, closed/reset socket) — not SQL errors. */
export function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; message?: string; originalError?: unknown };
  const code = e.code ?? "";
  const message = e.message ?? "";
  if (code === "ESOCKET" || code === "ECONNCLOSED" || code === "ECONNRESET" || code === "EPIPE") return true;
  if (/token (is )?expired|access token.*expired/i.test(message)) return true;
  if (code === "ELOGIN" && /token|expired/i.test(message)) return true;
  if (/connection (is |was )?closed/i.test(message)) return true;
  if (e.originalError && e.originalError !== err) return isRetryableError(e.originalError);
  return false;
}

export interface ReconnectOpts<T> {
  attempt: () => Promise<T>;
  /** Rebuild the underlying connection (re-mint token, new pool). */
  rebuild: () => Promise<void>;
  onReconnecting: () => void;
  isRetryable?: (e: unknown) => boolean;
}

/** Run attempt(); on a retryable failure, rebuild once (announcing "reconnecting") and retry exactly once. */
export async function withReconnect<T>(opts: ReconnectOpts<T>): Promise<T> {
  const retryable = opts.isRetryable ?? isRetryableError;
  try {
    return await opts.attempt();
  } catch (err) {
    if (!retryable(err)) throw err;
    opts.onReconnecting();
    await opts.rebuild();
    return await opts.attempt();
  }
}
