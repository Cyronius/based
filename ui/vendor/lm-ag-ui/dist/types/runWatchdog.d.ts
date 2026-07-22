/**
 * A React-free watchdog for an in-flight agent run.
 *
 * Two independent timers:
 *  - an *idle* timer that is reset every time the run makes progress
 *    (`kick()`), so a run stays alive as long as events keep arriving; and
 *  - an *absolute* max-run cap that never resets — a hard backstop against a
 *    run that keeps trickling events forever.
 *
 * Whichever fires first calls `onExpire(reason)` exactly once (the watchdog
 * disarms itself before invoking the callback).
 */
export interface RunWatchdogOptions {
    /** Idle window in ms. Reset on every `kick()`; fires `onExpire('idle')` if no kick lands in time. */
    idleMs: number;
    /** Absolute run cap in ms. Never reset; fires `onExpire('max')` regardless of kicks. */
    maxMs: number;
    onExpire: (reason: 'idle' | 'max') => void;
}
export interface RunWatchdog {
    /** Clears any existing timers, then arms both the idle and absolute timers. */
    start(): void;
    /** Resets the idle timer only. No-op if not currently running. */
    kick(): void;
    /** Clears both timers; the watchdog is inert until `start()` is called again. */
    stop(): void;
}
export declare function createRunWatchdog(opts: RunWatchdogOptions): RunWatchdog;
