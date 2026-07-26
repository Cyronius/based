// Traces: BASED-AI-PROFILE-TIMEOUT
// Mirror of core/src/agent/provider.ts's timeout resolution. The UI doesn't import @based/core
// (ui/src/api/types.ts duplicates the core shapes by the same convention), so the constants and the
// fallback rule live here too — keep the two in step.
import type { AiProfile } from "../api/types";

/** Default no-activity window for an AI request, in seconds. Sized for slow local backends. */
export const DEFAULT_AI_TIMEOUT_SECONDS = 900;

/** A whole agent run gets this multiple of the idle window as an absolute backstop. */
export const AI_RUN_TIMEOUT_MULTIPLIER = 4;

export interface AiTimeouts {
  /** No-activity window in ms — the chat client's idle timer. */
  idleMs: number;
  /** Absolute cap on a whole agent run in ms; never reset by activity. */
  runMs: number;
}

/** Absent, non-finite or non-positive → the default, so a blank field means "default", not "none". */
export function resolveAiTimeouts(timeoutSeconds: number | null | undefined): AiTimeouts {
  const seconds =
    typeof timeoutSeconds === "number" && Number.isFinite(timeoutSeconds) && timeoutSeconds > 0
      ? Math.floor(timeoutSeconds)
      : DEFAULT_AI_TIMEOUT_SECONDS;
  const idleMs = seconds * 1000;
  return { idleMs, runMs: idleMs * AI_RUN_TIMEOUT_MULTIPLIER };
}

/**
 * The timeout the running agent uses: the active profile's, falling back to the first profile the
 * same way the server's `activeAiProfile()` does when nothing is marked active.
 */
export function activeProfileTimeoutSeconds(profiles: AiProfile[], activeId: string | null): number | undefined {
  return (profiles.find((p) => p.id === activeId) ?? profiles[0])?.timeoutSeconds;
}
