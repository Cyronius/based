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
  /** Delay before the (attempt+1)th try. Injectable so tests stay instant; defaults to real backoff. */
  delay?: (attempt: number) => Promise<void>;
}

/** Total attempts (1 initial + retries) before a retryable failure is allowed to propagate. */
export const MAX_RECONNECT_ATTEMPTS = 6;

const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 8000;

function defaultDelay(attempt: number): Promise<void> {
  const ms = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_MAX_MS);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run attempt(); on a retryable failure, rebuild (announcing "reconnecting") and retry with bounded
 *  exponential backoff, up to MAX_RECONNECT_ATTEMPTS total tries. A non-retryable error never retries.
 *  Exhausting the cap propagates the last error — brief blips self-heal, a genuinely dead connection
 *  still surfaces. */
export async function withReconnect<T>(opts: ReconnectOpts<T>): Promise<T> {
  const retryable = opts.isRetryable ?? isRetryableError;
  const delay = opts.delay ?? defaultDelay;
  for (let attempt = 1; ; attempt++) {
    try {
      return await opts.attempt();
    } catch (err) {
      if (!retryable(err) || attempt >= MAX_RECONNECT_ATTEMPTS) throw err;
      opts.onReconnecting();
      await delay(attempt);
      await opts.rebuild();
    }
  }
}
