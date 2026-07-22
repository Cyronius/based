import { AgentSubscriber, Message, State, Tool, RunAgentResult } from '@ag-ui/client';
import { RequestHandler } from './CustomHttpAgent';
import { Session } from './index';
export type TokenProvider = () => Promise<string | null>;
/**
 * Produces the string content for the system message injected into the
 * thread. Zero-arg — the builder closes over whatever data it needs.
 * Return `null` (or empty string) to skip injection for this call.
 * Consumers should render only what the model needs to reason across
 * the session — omit large payloads. The returned string is compared to the
 * last-injected content for the thread; identical returns are NOT re-sent.
 * Independent of `forwardedProps`.
 */
export type SystemContextBuilder = () => string | null;
export interface AgentClientOptions {
    tokenProvider?: TokenProvider;
    requestHandler?: RequestHandler;
    timeout?: number;
    sendFullHistory?: boolean;
    initialThreadId?: string;
    /** Optional zero-arg renderer for the system-context snapshot. When not provided,
     *  no system context is injected. Independent of `forwardedProps`. */
    systemContextBuilder?: SystemContextBuilder;
    /** Appends `?debug=true` to the agent URL so the backend captures LLM input.
     *  Set once at construction — not runtime-toggleable. Drive from env/URL flag at app init. */
    debug?: boolean;
    /**
     * Optional outbound-message transformer. When set, every wire send
     * (`runAgent` and `submitToolResults`) passes the assembled message array
     * through this function immediately before `agent.setMessages`. Use this
     * for context shrinking (e.g. tombstoning stale tool results) without
     * needing each caller to remember to invoke it. Must preserve message
     * ordering and tool-call/tool-result pairing — only `content` may change.
     */
    pruneOutboundMessages?: (messages: Message[]) => Message[];
    /**
     * Extra query params appended to the agent URL (used for the run POST and,
     * via configService, the config-init GET). Array values are sent as repeated
     * keys (`?kbIds=a&kbIds=b`). Used for per-session backend tool selection such
     * as course knowledge bases (MOBI-KB-TOOL). Fixed at construction.
     */
    configParams?: Record<string, string | string[]>;
}
export declare class AgentClient {
    private agent;
    private baseUrl;
    private agentId;
    private timeout;
    private tokenProvider?;
    private requestHandler?;
    private _session;
    private _debug;
    private _sendFullHistory;
    private _systemContextBuilder?;
    private _pruneOutboundMessages?;
    private _configParams?;
    private _injectedContextByThread;
    private _runStartedAt;
    private onSessionChange?;
    constructor(baseUrl: string, agentId: string, options?: AgentClientOptions);
    private buildAgentUrl;
    private createAgent;
    get debug(): boolean;
    get session(): Session;
    private updateSession;
    setSessionChangeCallback(callback: (session: Session) => void): void;
    startNewRun(): Session;
    endRun(): void;
    abortRun(): void;
    endSession(): void;
    /**
     * Render the system-context string using the configured builder.
     * Returns null when no builder is configured or the builder returns empty.
     * Independent of `forwardedProps`.
     */
    private renderSystemContext;
    /**
     * Build a SystemMessage for the given thread.
     *
     * The per-thread dedup (skip re-sending an unchanged snapshot) is only safe
     * against a STATEFUL backend (`sendFullHistory: false`), which retains the
     * once-injected system message and rehydrates it on later turns. Under
     * `sendFullHistory: true` the backend is stateless and rehydrates nothing —
     * the client re-ships the whole transcript each turn — so the system context
     * must ride on EVERY send. Deduping it there strips the model's grounding on
     * every turn after the first (MOBI-CONTEXT-EVERY-TURN).
     *
     * Returns null when the content is empty, or (stateful backend only) when it
     * is unchanged since the last send for this thread.
     */
    private maybeBuildContextMessage;
    private applyAuthHeaders;
    runAgent(messages: Message[], tools: Tool[], subscriber: AgentSubscriber, forwardedProps?: Record<string, any>): Promise<RunAgentResult>;
    setState(state: State): void;
    /**
     * `sendFullHistory` (set at construction) determines what is shipped on each call:
     *  - `true`  — frontend-controlled / stateless backend. The caller-provided messages
     *              array is sent verbatim (with the optional system-context message
     *              prepended). The backend holds no per-thread state and can scale
     *              horizontally. The `threadId` is still forwarded for observability.
     *  - `false` — backend-controlled / stateful backend. Only the newest turn is sent;
     *              the backend rehydrates prior history against `threadId`. Tool-result
     *              submissions filter to tool-role messages only.
     *
     *  Mismatching this flag with the backend contract causes either context loss
     *  (`false` against a stateless backend) or duplicated history (`true` against a
     *  stateful backend that also stores it). See README § Architecture.
     */
    submitToolResults(toolMessages: Message[], subscriber: AgentSubscriber, tools?: Tool[], forwardedProps?: Record<string, any>): Promise<RunAgentResult>;
    private generateRunId;
    private generateThreadId;
    getConfig(): {
        baseUrl: string;
        agentId: string;
        timeout: number;
    };
}
