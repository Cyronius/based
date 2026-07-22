import { Message } from '@ag-ui/client';
export interface ToolCallBuffer {
    name: string;
    argsBuffer: string;
    parentMessageId?: string;
    resultReceived?: boolean;
}
export interface AgentState {
    messages: Message[];
    streamingText: string;
    streamingMessageId: string | null;
    toolCallBuffers: Map<string, ToolCallBuffer>;
    toolCallIdToName: Map<string, string>;
    flushedToolCallIds: Set<string>;
    lastAnnouncedAssistantText: string | null;
    isAborted: boolean;
    globalState: Record<string, unknown>;
    preRunMessageCount: number;
}
export declare const initialAgentState: AgentState;
export type AgentAction = {
    type: 'ADD_MESSAGE';
    message: Message;
} | {
    type: 'SET_MESSAGES';
    messages: Message[];
} | {
    type: 'CLEAR_MESSAGES';
} | {
    type: 'SNAPSHOT_PRE_RUN';
} | {
    type: 'CLEAR_STREAMING';
} | {
    type: 'FINALIZE_TURN';
} | {
    type: 'TEXT_DELTA';
    messageId: string;
    delta: string;
} | {
    type: 'TOOL_CALL_START';
    toolCallId: string;
    name: string;
    parentMessageId?: string;
} | {
    type: 'TOOL_CALL_ARGS';
    toolCallId: string;
    delta: string;
} | {
    type: 'TOOL_CALL_RESULT';
    toolCallId: string;
    message: Message;
} | {
    type: 'CLEAR_TOOL_BUFFERS';
} | {
    type: 'SET_ABORTED';
    value: boolean;
} | {
    type: 'TERMINATE';
} | {
    type: 'UPDATE_TOOL_STATE';
    toolName: string;
    data: unknown;
} | {
    type: 'PATCH_GLOBAL_STATE';
    patch: Record<string, unknown>;
} | {
    type: 'MERGE_STATE_SNAPSHOT';
    snapshot: Record<string, unknown>;
};
export declare function agentReducer(state: AgentState, action: AgentAction): AgentState;
