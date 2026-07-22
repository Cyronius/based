import { default as React } from 'react';
import { AgentConfig, UseAgentOptions, ToolDefinition } from './index';
export interface UseAgentSetupOptions {
    baseUrl?: string;
    agentId: string;
    tokenProvider?: UseAgentOptions['tokenProvider'];
    requestHandler?: UseAgentOptions['requestHandler'];
    timeout?: number;
    /**
     * Absolute hard cap in ms for a whole run, forwarded to the underlying agent
     * run. Never reset. On expiry the run is forcibly aborted and a timeout message
     * is added. See `UseAgentOptions.safetyTimeoutMs`. Default: 900_000 (15 min).
     */
    safetyTimeoutMs?: UseAgentOptions['safetyTimeoutMs'];
    /**
     * Idle window in ms, forwarded to the underlying agent run. Reset on every
     * AG-UI event, so only a genuine stall trips it. See
     * `UseAgentOptions.idleTimeoutMs`. Default: 180_000 (3 min).
     */
    idleTimeoutMs?: UseAgentOptions['idleTimeoutMs'];
    tools?: UseAgentOptions['tools'];
    buildForwardedProps?: UseAgentOptions['buildForwardedProps'];
    systemContextBuilder?: UseAgentOptions['systemContextBuilder'];
    debug?: boolean;
    /**
     * When true, runAgent ships the full caller-provided messages array on every
     * call (frontend-controlled history). When false (default), only the newest
     * turn is sent and the backend rehydrates prior history from threadId.
     * Must match the backend contract — see AgentClient.submitToolResults docs.
     */
    sendFullHistory?: boolean;
    /**
     * Optional outbound-message transformer applied by AgentClient on every wire send
     * (runAgent + submitToolResults). See AgentClientOptions.pruneOutboundMessages.
     */
    pruneOutboundMessages?: UseAgentOptions['pruneOutboundMessages'];
    /**
     * When true, suppress intermediate assistant narration during an agentic
     * chain. See `UseAgentOptions.suppressIntermediateAssistantMessages` for full
     * semantics. Sticky for the lifetime of the AgentLayer.
     */
    suppressIntermediateAssistantMessages?: UseAgentOptions['suppressIntermediateAssistantMessages'];
    /**
     * Optional frontend tool implementations keyed by tool name. When provided,
     * backend tool configs are automatically joined with these implementations via
     * `hydrateToolConfigs`, and the result is assigned to `config.tools` before
     * `onConfigLoaded` runs. Use this for the common case where you just want to
     * attach handlers to backend-declared tools without writing a custom merge.
     *
     * If you need full control (e.g., conditional tool registration), omit this
     * and use `onConfigLoaded` to build `tools` yourself.
     */
    frontendToolImpls?: Record<string, Partial<ToolDefinition>>;
    /** Called after config loads from the backend. Use this to transform toolConfigs into tools, extract settings, etc. */
    onConfigLoaded?: (config: AgentConfig) => AgentConfig;
    /**
     * Optional extra query params appended to the config-init GET
     * (`GET /agent/{agentId}`). Array values are sent as repeated keys
     * (`?kbIds=a&kbIds=b`). Read when config loads; pass a stable reference
     * (memoized object) — a new identity per render re-triggers the config
     * fetch, like tokenProvider/requestHandler.
     */
    configParams?: Record<string, string | string[]>;
}
export interface UseAgentSetupResult {
    config: AgentConfig | null;
    isLoading: boolean;
    error: Error | null;
    /** Wrapper component — renders AgentProvider only when config is loaded. Passthrough otherwise. */
    AgentLayer: React.FC<{
        children: React.ReactNode;
    }>;
}
/**
 * Combined hook that handles async config loading + useAgent initialization.
 *
 * Solves the problem where useAgent captures baseUrl/agentId in a useState
 * initializer (once), so calling it before config is ready creates a broken client.
 *
 * The returned AgentLayer component conditionally mounts useAgent only after
 * config has loaded, ensuring AgentClient is created with valid values.
 */
export declare function useAgentSetup({ baseUrl, agentId, tokenProvider, requestHandler, timeout, safetyTimeoutMs, idleTimeoutMs, tools, buildForwardedProps, systemContextBuilder, debug, sendFullHistory, pruneOutboundMessages, suppressIntermediateAssistantMessages, frontendToolImpls, onConfigLoaded, configParams }: UseAgentSetupOptions): UseAgentSetupResult;
