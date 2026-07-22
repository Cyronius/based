export interface BufferedSegment {
    messageId: string;
    text: string;
}
export interface RunFinishedDecision {
    commit: BufferedSegment[];
    dropped: BufferedSegment[];
}
/**
 * State machine for `suppressIntermediateAssistantMessages`. When enabled, only
 * the first and final assistant text segments of a user turn are committed to
 * the message list; intermediate narration during agentic chains is dropped.
 *
 * A "turn" begins on a fresh user-initiated `RunStarted` and continues across
 * any `RunStarted` events that follow a frontend-tool-result submission
 * (signalled by `markChainedRun()`). Within a turn:
 *   - The first text segment streams live (caller passes through to the reducer).
 *   - Subsequent segments are buffered until `RunFinished`.
 *   - At `RunFinished` the buffer is committed if no tool calls fired in the
 *     run (i.e. this was the final run of the turn) or dropped otherwise.
 */
export declare class IntermediateMessageSuppressor {
    private _enabled;
    private firstTextEmittedThisTurn;
    private chainedRunPending;
    private bufferedSegments;
    private bufferedMessageIds;
    constructor(_enabled: boolean);
    setEnabled(v: boolean): void;
    get enabled(): boolean;
    /** Called by the frontend tool runner immediately before submitting tool results. */
    markChainedRun(): void;
    /** Defensive: called when a fresh user-initiated run is about to start, so a
     *  pending chain flag from a prior turn cannot bleed into this one. */
    clearPendingChain(): void;
    /** Called on RUN_STARTED. Returns 'fresh' (turn-scoped state was reset) or
     *  'chained' (turn-scoped state preserved). */
    onRunStarted(): 'fresh' | 'chained';
    /** Called on TEXT_MESSAGE_START. Returns 'stream' (let the caller forward
     *  the segment to the reducer) or 'buffer' (the suppressor will hold the
     *  segment until RUN_FINISHED). */
    onTextMessageStart(messageId: string): 'stream' | 'buffer';
    isBuffered(messageId: string): boolean;
    appendToBuffer(messageId: string, delta: string): void;
    getBufferedText(messageId: string): string | undefined;
    /** Called on RUN_FINISHED, BEFORE any tool buffers are cleared. Caller passes
     *  whether the just-finished run had any unflushed tool calls. Returns the
     *  segments to commit (final-run case) and segments to drop (intermediate-run case). */
    onRunFinished(hasUnflushedToolCall: boolean): RunFinishedDecision;
    /** Called on RUN_ERROR. Clears all turn-scoped state including the pending
     *  chain flag — the turn is aborted. */
    reset(): void;
}
