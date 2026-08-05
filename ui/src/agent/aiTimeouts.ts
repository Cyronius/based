// Traces: BASED-AI-PROFILE-TIMEOUT, BASED-AI-PROFILE-STEPCAP
// Mirror of core/src/agent/provider.ts's timeout resolution. The UI doesn't import @based/core
// (ui/src/api/types.ts duplicates the core shapes by the same convention), so the constants and the
// fallback rule live here too — keep the two in step.
import type { AiProfile } from "../api/types";

/** Default no-activity window for an AI request, in seconds. Drives the chat's ask-to-keep-waiting
 *  stall prompt (BASED-AGENT-CONTINUE-PROMPT), not a kill, so it can be short. */
export const DEFAULT_AI_TIMEOUT_SECONDS = 120;

/** Wall-clock caps get this multiple of the idle window (subagent tasks, hard backstops). */
export const AI_RUN_TIMEOUT_MULTIPLIER = 15;

/** Mirror of core's AGENT_MAX_STEPS: the tool-step budget when a profile sets none. */
export const DEFAULT_AGENT_MAX_STEPS = 30;

/** Passed as the vendored library's idle + safety timeouts. Its watchdog hard-codes an abort with
 *  "The request timed out." — the app-side stall prompt asks instead of killing, so the library
 *  timers are demoted to a last-resort leak guard for an unattended machine. */
export const WATCHDOG_BACKSTOP_MS = 6 * 60 * 60 * 1000;

export interface AiTimeouts {
  /** No-activity window in ms — the chat's stall-prompt timer. */
  idleMs: number;
  /** Wall-clock cap in ms for runs with no user in the loop (subagent tasks). */
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

/** The active profile's tool-step budget, resolved to a concrete number for the continue prompt. */
export function activeProfileMaxToolSteps(profiles: AiProfile[], activeId: string | null): number {
  const v = (profiles.find((p) => p.id === activeId) ?? profiles[0])?.maxToolSteps;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_AGENT_MAX_STEPS;
}
