import { Message } from '@ag-ui/client';
import { SessionHandle } from './useAgentSession';
import { StreamHandle } from './useAgentStream';
import { ToolDefinition, ForwardedPropsBuilder } from './index';
export interface FrontendToolRunnerOptions {
    buildForwardedProps?: ForwardedPropsBuilder;
}
export interface FrontendToolExecution {
    /**
     * The `role: 'tool'` result message to submit back to the agent. Always
     * produced for a frontend tool call — including when arg parsing fails or
     * the handler throws — so the agent protocol stays whole (no dangling
     * tool_call) and the model receives a structured failure it can react to.
     */
    message: Message;
    /** Parsed tool args, or `undefined` when JSON parsing failed. */
    args: unknown;
    /** The handler's raw return value; `undefined` if the handler threw. */
    result: string | null | undefined;
    /** True when the handler ran to completion (did not throw). Gates `onResult`. */
    executed: boolean;
}
/**
 * Run one frontend tool call and build its result message. Pure with respect to
 * control flow — it never throws: a JSON-parse failure or a handler exception is
 * caught and turned into an `{ ok: false, error }` tool-result message, mirroring
 * the existing invalid-args path. This is what guarantees a thrown handler is
 * surfaced to the model as a real tool result (and counted by any failure
 * circuit breaker) instead of leaking out as a stray assistant message with no
 * result submitted for the call.
 *
 * The handler's return is `await`ed, so a handler may be synchronous
 * (`string | null`) or asynchronous (`Promise<string | null>`) — both flow
 * through the same path (`await` on a non-Promise resolves to the value). A
 * rejected Promise is caught exactly like a synchronous throw. Hence this
 * function is async and returns a Promise.
 *
 * Side effects (dispatching the message, invoking `onResult`) are left to the
 * caller so this stays unit-testable. `nowMs` is injected for a deterministic id.
 */
export declare function executeFrontendToolCall(tool: ToolDefinition | undefined, toolName: string, argsJson: string | null, toolCallId: string, ctx: {
    updateState: (toolName: string, data: unknown) => void;
    getState: (toolName?: string) => unknown;
    stopAfterToolCall: () => void;
}, nowMs: number): Promise<FrontendToolExecution>;
/**
 * Effect-only hook. Subscribes to stream.onRunFinished and, for each pending
 * tool call that has a frontend handler, executes it, dispatches the tool
 * message, and submits the batched tool results back to the agent.
 */
export declare function useFrontendToolRunner(stream: StreamHandle, session: SessionHandle, tools: Record<string, ToolDefinition>, options?: FrontendToolRunnerOptions): void;
