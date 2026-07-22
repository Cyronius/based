import { default as React } from 'react';
import { AgentSubscriber, Message } from '@ag-ui/client';
import { AgentClient, TokenProvider, SystemContextBuilder } from './AgentClient';
import { RequestHandler } from './CustomHttpAgent';
import { AgentProvider, useAgentContext } from './AgentClientContext';
import { useAgent } from './useAgent';
export interface Session {
    threadId: string | null;
    runId: string | null;
    isActive: boolean;
}
export interface StandardTool {
    name: string;
    description: string;
    parameters: {
        type: "object";
        properties: Record<string, any>;
        required: string[];
    };
}
export interface ToolContext {
    readonly toolCallId: string;
    readonly toolName: string;
    stopAfterToolCall(): void;
}
export type ToolHandler = (args: any, updateState: (toolName: string, data: unknown) => void, getState: (toolName?: string) => unknown, configJson?: Record<string, unknown>, ctx?: ToolContext) => string | null | Promise<string | null>;
export type ToolRenderer = (args: any, result: string, updateState: (toolName: string, data: unknown) => void, getState: (toolName?: string) => unknown, configJson?: Record<string, unknown>) => React.ReactElement | void;
export type ToolOnResult = (args: any, result: string, updateState: (toolName: string, data: unknown) => void, getState: (toolName?: string) => unknown) => void;
export interface ToolDefinition {
    definition: StandardTool;
    handler?: ToolHandler;
    renderer?: ToolRenderer;
    onResult?: ToolOnResult;
    isFrontend: boolean;
    configJson?: Record<string, unknown>;
}
export interface AgentClientContextValue {
    agentClient: AgentClient;
    session: Session;
    tools: Record<string, ToolDefinition>;
    globalState: Record<string, unknown>;
    messages: Message[];
    addMessage: (message: Message) => void;
    setMessages: (messages: Message[]) => void;
    clearMessages: () => void;
    updateState: (toolName: string, data: unknown) => void;
    currentMessage: string;
    currentMessageId: string | null;
    isStreaming: boolean;
    getToolNameFromCallId: (toolCallId: string) => string | undefined;
    agentSubscriber: AgentSubscriber;
    invokeToolByName: (toolName: string, additionalForwardedProps?: Record<string, any>, stateUpdates?: Record<string, any>) => Promise<void>;
    terminateRun: () => void;
    debug: boolean;
    getForwardedProps: (extraProps?: Record<string, any>) => Record<string, any>;
    /**
     * Defensive: clears any pending chained-run marker. Consumers calling
     * `agentClient.runAgent` directly to start a fresh user-initiated run
     * while `suppressIntermediateAssistantMessages` is enabled should call
     * this first. `useAgent.invokeToolByName` calls it automatically.
     * No-op when `suppressIntermediateAssistantMessages` is off.
     */
    clearPendingChain: () => void;
}
export type ForwardedPropsBuilder = () => Record<string, any>;
export type AgentLifecycleEvent = {
    type: 'run_started';
} | {
    type: 'tool_used';
    toolName: string;
} | {
    type: 'message_added';
    role: string;
    content: string;
};
export interface UseAgentOptions {
    baseUrl?: string;
    agentId: string;
    tokenProvider?: TokenProvider;
    requestHandler?: RequestHandler;
    timeout?: number;
    tools?: Record<string, ToolDefinition>;
    buildForwardedProps?: ForwardedPropsBuilder;
    sendFullHistory?: boolean;
    initialThreadId?: string;
    /** Optional callback for observing agent lifecycle events (e.g., tracking, analytics) */
    onLifecycleEvent?: (event: AgentLifecycleEvent) => void;
    /** Optional zero-arg renderer for the system-context snapshot. When not provided,
     *  no system context is injected. Independent of `buildForwardedProps`. */
    systemContextBuilder?: SystemContextBuilder;
    /** Enable backend LLM-input capture by appending `?debug=true` to the agent URL.
     *  Set once at init (drive from env var or URL flag); not runtime-toggleable. */
    debug?: boolean;
    /** Called for run errors, timeouts, and aborts. Additive to the existing in-stream
     *  error-message behavior. */
    onError?: (err: {
        code: 'run_error' | 'timeout' | 'aborted';
        message: string;
        raw?: unknown;
    }) => void;
    /** Absolute hard cap in ms for a whole run. Never reset — a backstop against a run
     *  that keeps trickling events forever. On expiry the run is forcibly aborted and a
     *  timeout message is added. Default: 900_000 (15 min). */
    safetyTimeoutMs?: number;
    /** Idle window in ms. Reset every time an AG-UI event arrives, so a run that keeps
     *  making progress is never killed — only a genuine stall (no events for this long)
     *  trips it, with the same abort + timeout-message behavior as `safetyTimeoutMs`.
     *  Default: 180_000 (3 min). */
    idleTimeoutMs?: number;
    /** Optional outbound-message transformer applied by AgentClient on every wire send
     *  (runAgent + submitToolResults), immediately before agent.setMessages. Use for
     *  context shrinking such as tombstoning stale tool results. Must preserve
     *  ordering and tool-call/tool-result pairing — only `content` may change. */
    pruneOutboundMessages?: (messages: Message[]) => Message[];
    /** When true, suppress *intermediate* assistant narration during an agentic
     *  chain. The first text emitted in a user turn (the first TEXT_MESSAGE_*
     *  group seen since the user submitted) streams normally. The final text
     *  (text in the run that does not chain another tool call) is committed at
     *  RUN_FINISHED. Any text emitted in an intermediate run that chains
     *  another tool call after itself is dropped. FE-local — does not cross
     *  the wire. Default: false. */
    suppressIntermediateAssistantMessages?: boolean;
    /** Extra query params appended to BOTH the config-init GET and every run
     *  POST (`/agent/{agentId}`). Array values are sent as repeated keys
     *  (`?kbIds=a&kbIds=b`). Used for per-session backend tool selection such as
     *  course knowledge bases (MOBI-KB-TOOL): the config GET reports the tool and
     *  the run POST attaches it. Stable for the session. */
    configParams?: Record<string, string | string[]>;
}
export interface Suggestion {
    isPriority: boolean;
    suggestion: string;
}
export interface ToolConfigResponse {
    name: string;
    displayName?: string;
    description?: string;
    isFrontend?: boolean;
    configJson?: Record<string, any>;
    parameters?: {
        type: string;
        properties: Record<string, any>;
        required: string[];
    };
}
export interface AgentConfig {
    tools?: Record<string, ToolDefinition>;
    toolConfigs?: ToolConfigResponse[];
    suggestions: Suggestion[];
    defaultPlaceholder?: string;
    allowUpload?: boolean;
    config?: Record<string, string | null>;
}
export type { TokenProvider, SystemContextBuilder };
export type { RequestHandler };
export { AgentClient, AgentProvider, useAgentContext, useAgent };
/** @advanced Lower-level building block. Most consumers should use `useAgent`. */
export { useAgentSession } from './useAgentSession';
export type { SessionHandle } from './useAgentSession';
/** @advanced Lower-level building block. Most consumers should use `useAgent`. */
export { useAgentStream } from './useAgentStream';
export type { StreamHandle, RunFinishedPayload, PendingToolCall } from './useAgentStream';
/** @advanced Lower-level building block. Most consumers should use `useAgent`. */
export { useFrontendToolRunner } from './useFrontendToolRunner';
export type { FrontendToolRunnerOptions } from './useFrontendToolRunner';
export { filesToBinaryContent } from './fileUtils';
export { getAllToolDefinitions, getFrontendToolDefinitions, getBackendToolDefinitions, getFrontEndTools, getToolRenderers, hydrateToolConfigs } from './toolUtils';
export { loadAgentConfig } from './configService';
export { useAgentSetup } from './useAgentSetup';
export type { UseAgentSetupOptions, UseAgentSetupResult } from './useAgentSetup';
export { groupSuggestionsByCategory, SUGGESTION_CATEGORY_SEPARATOR } from './suggestionUtils';
export type { SuggestionGroup, CategorizedSuggestion } from './suggestionUtils';
