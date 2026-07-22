import { Dispatch } from 'react';
import { AgentSubscriber, Message } from '@ag-ui/client';
import { AgentState, AgentAction } from './agentReducer';
import { AgentClient } from './AgentClient';
import { ToolDefinition, UseAgentOptions } from './index';
import { getFrontEndTools } from './toolUtils';
export interface PendingToolCall {
    toolCallId: string;
    name: string;
    argsBuffer: string;
}
export interface RunFinishedPayload {
    finalMessages: Message[];
    pendingToolCalls: PendingToolCall[];
    stateSnapshot: AgentState;
}
export interface StreamHandle {
    state: AgentState;
    stateRef: React.MutableRefObject<AgentState>;
    dispatch: Dispatch<AgentAction>;
    subscriber: AgentSubscriber;
    onRunFinished: (cb: (p: RunFinishedPayload) => void) => () => void;
    /**
     * Marks the next `RunStarted` event as a chained continuation of the
     * current user turn rather than a fresh user-initiated run. Called by
     * `useFrontendToolRunner` immediately before `submitToolResults`. Drives
     * first/final-message preservation when `suppressIntermediateAssistantMessages`
     * is on; a no-op when the flag is off.
     */
    markChainedRun: () => void;
    /**
     * Defensive clear: callers about to start a fresh user-initiated run
     * (e.g. user typed a message) should call this so a stale chained-run
     * marker from a prior turn cannot bleed in. `useAgent.invokeToolByName`
     * calls this automatically; consumers calling `agentClient.runAgent`
     * directly while `suppressIntermediateAssistantMessages` is enabled
     * should call it themselves.
     */
    clearPendingChain: () => void;
}
type StreamOptions = Pick<UseAgentOptions, 'onLifecycleEvent' | 'onError' | 'safetyTimeoutMs' | 'idleTimeoutMs' | 'suppressIntermediateAssistantMessages'> & {
    tools?: Record<string, ToolDefinition>;
};
/**
 * Subscribes to AG-UI events, runs the reducer, and exposes a RunFinished
 * event to consumers. No AgentClient mutation beyond receiving it for the
 * safety-timeout abort, and no tool execution logic.
 */
export declare function useAgentStream(client: AgentClient, sessionIsActive: boolean, options: StreamOptions): StreamHandle;
export { getFrontEndTools };
