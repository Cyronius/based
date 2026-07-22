var K = Object.defineProperty;
var Q = (t, e, s) => e in t ? K(t, e, { enumerable: !0, configurable: !0, writable: !0, value: s }) : t[e] = s;
var E = (t, e, s) => Q(t, typeof e != "symbol" ? e + "" : e, s);
import { HttpAgent as Z, transformHttpEventStream as ee } from "@ag-ui/client";
import { defer as te, from as V, switchMap as W, throwError as z, Observable as ne } from "rxjs";
import { jsx as se } from "react/jsx-runtime";
import j, { createContext as re, useContext as oe, useState as v, useEffect as k, useCallback as M, useRef as B, useMemo as J } from "react";
class ae extends Z {
  constructor(s, n) {
    super(s);
    E(this, "_handler");
    this._handler = n;
  }
  run(s) {
    const n = this.requestInit(s), o = le(this.url, n, this._handler);
    return ee(o);
  }
}
function le(t, e, s) {
  return te(() => V(s(t, e))).pipe(
    W((n) => {
      if (!n.ok) {
        const a = n.headers.get("content-type") || "";
        return V(n.text()).pipe(
          W((l) => {
            let u = l;
            if (a.includes("application/json"))
              try {
                u = JSON.parse(l);
              } catch {
              }
            const d = new Error(
              `HTTP ${n.status}: ${typeof u == "string" ? u : JSON.stringify(u)}`
            );
            return d.status = n.status, d.payload = u, z(() => d);
          })
        );
      }
      const o = {
        type: "headers",
        status: n.status,
        headers: n.headers
      }, i = n.body?.getReader();
      return i ? new ne((a) => (a.next(o), (async () => {
        try {
          for (; ; ) {
            const { done: l, value: u } = await i.read();
            if (l) break;
            a.next({ type: "data", data: u });
          }
          a.complete();
        } catch (l) {
          a.error(l);
        }
      })(), () => {
        i.cancel().catch((l) => {
          if (l?.name !== "AbortError") throw l;
        });
      })) : z(() => new Error("Failed to getReader() from response"));
    })
  );
}
const _ = [];
for (let t = 0; t < 256; ++t)
  _.push((t + 256).toString(16).slice(1));
function ie(t, e = 0) {
  return (_[t[e + 0]] + _[t[e + 1]] + _[t[e + 2]] + _[t[e + 3]] + "-" + _[t[e + 4]] + _[t[e + 5]] + "-" + _[t[e + 6]] + _[t[e + 7]] + "-" + _[t[e + 8]] + _[t[e + 9]] + "-" + _[t[e + 10]] + _[t[e + 11]] + _[t[e + 12]] + _[t[e + 13]] + _[t[e + 14]] + _[t[e + 15]]).toLowerCase();
}
let q;
const ue = new Uint8Array(16);
function ce() {
  if (!q) {
    if (typeof crypto > "u" || !crypto.getRandomValues)
      throw new Error("crypto.getRandomValues() not supported. See https://github.com/uuidjs/uuid#getrandomvalues-not-supported");
    q = crypto.getRandomValues.bind(crypto);
  }
  return q(ue);
}
const de = typeof crypto < "u" && crypto.randomUUID && crypto.randomUUID.bind(crypto), X = { randomUUID: de };
function N(t, e, s) {
  if (X.randomUUID && !t)
    return X.randomUUID();
  t = t || {};
  const n = t.random ?? t.rng?.() ?? ce();
  if (n.length < 16)
    throw new Error("Random bytes length must be >= 16");
  return n[6] = n[6] & 15 | 64, n[8] = n[8] & 63 | 128, ie(n);
}
const ge = 3e5;
class fe {
  constructor(e = "http://localhost:8000", s, n) {
    E(this, "agent");
    E(this, "baseUrl");
    E(this, "agentId");
    E(this, "timeout");
    E(this, "tokenProvider");
    E(this, "requestHandler");
    E(this, "_session");
    E(this, "_debug");
    E(this, "_sendFullHistory");
    E(this, "_systemContextBuilder");
    E(this, "_pruneOutboundMessages");
    E(this, "_configParams");
    // Tracks the last rendered system-context content we injected for each thread,
    // so identical content isn't re-sent on subsequent runs in the same thread.
    // Cleared per-thread on endSession().
    E(this, "_injectedContextByThread", /* @__PURE__ */ new Map());
    // Wall-clock start of the current agentic run (set in startNewRun, cleared in endRun).
    // Spans the full chain of LLM turns + tool round-trips, not just one runAgent call.
    E(this, "_runStartedAt", null);
    // Session change callback for React integration
    E(this, "onSessionChange");
    if (!s || s.trim().length === 0)
      throw new Error("AgentClient: agentId is required and cannot be empty");
    if (!e || e.trim().length === 0)
      throw new Error("AgentClient: baseUrl is required and cannot be empty");
    if (n?.timeout !== void 0 && (typeof n.timeout != "number" || n.timeout <= 0))
      throw new Error("AgentClient: timeout must be a positive number");
    this.baseUrl = e, this.agentId = s, this.timeout = n?.timeout ?? ge, this.tokenProvider = n?.tokenProvider, this.requestHandler = n?.requestHandler, this._sendFullHistory = n?.sendFullHistory ?? !1, this._systemContextBuilder = n?.systemContextBuilder, this._pruneOutboundMessages = n?.pruneOutboundMessages, this._configParams = n?.configParams, this._debug = n?.debug ?? !1, console.info("[AG-UI] AgentClient constructed:", {
      agentId: s,
      sendFullHistory: this._sendFullHistory,
      hasPruneOutboundMessages: !!this._pruneOutboundMessages
    }), this.agent = this.createAgent(), this._session = {
      threadId: n?.initialThreadId ?? null,
      runId: null,
      isActive: !1
    };
  }
  // Build agent URL with optional debug + configParams query string.
  // configParams array values become repeated keys (?kbIds=a&kbIds=b) so the
  // backend reads them as a list (MOBI-KB-TOOL).
  buildAgentUrl() {
    const e = `${this.baseUrl}/agent/${this.agentId}`, s = new URLSearchParams();
    if (this._debug && s.append("debug", "true"), this._configParams)
      for (const [o, i] of Object.entries(this._configParams))
        if (Array.isArray(i))
          for (const a of i) s.append(o, a);
        else
          s.append(o, i);
    const n = s.toString();
    return n ? `${e}?${n}` : e;
  }
  // Create the appropriate HttpAgent (custom or standard)
  createAgent() {
    const e = {
      url: this.buildAgentUrl(),
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream"
      }
    };
    return this.requestHandler ? new ae(e, this.requestHandler) : new Z(e);
  }
  // Debug mode getter
  get debug() {
    return this._debug;
  }
  // Session getter
  get session() {
    return { ...this._session };
  }
  // Internal method to update session and notify React
  updateSession(e) {
    this._session = { ...this._session, ...e }, this.onSessionChange?.(this.session);
  }
  // Set the callback for session changes (used by React context)
  setSessionChangeCallback(e) {
    this.onSessionChange = e;
  }
  // Session management methods
  startNewRun() {
    const e = this.generateRunId(), n = {
      threadId: this._session.threadId || this.generateThreadId(),
      runId: e,
      isActive: !0
    };
    return this._runStartedAt == null && (this._runStartedAt = Date.now()), this.updateSession(n), this.session;
  }
  endRun() {
    const e = this._runStartedAt;
    this.updateSession({
      runId: null,
      isActive: !1
    }), e != null && queueMicrotask(() => {
      if (this._session.isActive || this._runStartedAt !== e) return;
      const s = Date.now() - e;
      console.info("[AG-UI] agentic run complete", {
        threadId: this._session.threadId,
        elapsedMs: s,
        elapsedSec: +(s / 1e3).toFixed(2)
      }), this._runStartedAt = null;
    });
  }
  abortRun() {
    this.agent.abortRun(), this.agent.abortController = new AbortController(), this.endRun();
  }
  endSession() {
    const e = this._session.threadId;
    e && this._injectedContextByThread.delete(e), this.updateSession({
      threadId: null,
      runId: null,
      isActive: !1
    });
  }
  /**
   * Render the system-context string using the configured builder.
   * Returns null when no builder is configured or the builder returns empty.
   * Independent of `forwardedProps`.
   */
  renderSystemContext() {
    if (!this._systemContextBuilder) return null;
    const e = this._systemContextBuilder();
    return e && e.length > 0 ? e : null;
  }
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
  maybeBuildContextMessage(e) {
    const s = this.renderSystemContext();
    return !s || !this._sendFullHistory && this._injectedContextByThread.get(e) === s ? null : (this._injectedContextByThread.set(e, s), {
      id: `system_context_${Date.now()}`,
      role: "system",
      content: s
    });
  }
  // Apply auth token to agent headers if a tokenProvider is configured
  async applyAuthHeaders() {
    if (this.tokenProvider) {
      const e = await this.tokenProvider();
      e && (this.agent.headers.Authorization = `Bearer ${e}`);
    }
  }
  // Agent communication methods
  async runAgent(e, s, n, o = {}) {
    const i = this._session.threadId || this.generateThreadId(), a = this._session.runId || this.generateRunId();
    try {
      await this.applyAuthHeaders(), this.agent.threadId = i;
      const l = this.maybeBuildContextMessage(i), u = this._sendFullHistory ? l ? [l, ...e] : e : [l, e[e.length - 1]].filter(Boolean), d = this._pruneOutboundMessages ? this._pruneOutboundMessages(u) : u;
      return this.agent.setMessages(d), console.info("[AG-UI] RunAgent start:", {
        threadId: i,
        runId: a,
        stopAfterToolCall: o?.stopAfterToolCall === !0,
        outgoingCount: d.length
      }), await this.agent.runAgent({
        runId: a,
        tools: s,
        context: [],
        forwardedProps: o
      }, n);
    } catch (l) {
      throw console.error("Agent execution error:", l), this._session.isActive && this.endRun(), l;
    }
  }
  setState(e) {
    this.agent.setState(e);
  }
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
  async submitToolResults(e, s, n = [], o = {}) {
    if (!this._session.threadId)
      throw new Error("Thread ID is required for tool result submission");
    const i = this.generateRunId();
    try {
      await this.applyAuthHeaders(), this.agent.threadId = this._session.threadId;
      const a = this.maybeBuildContextMessage(this._session.threadId), l = this._sendFullHistory ? a ? [a, ...e] : e : a ? [a, ...e.filter((C) => C.role === "tool")] : e.filter((C) => C.role === "tool"), u = this._pruneOutboundMessages ? this._pruneOutboundMessages(l) : l;
      return this.agent.setMessages(u), console.info("[AG-UI] RunAgent start (tool results):", {
        threadId: this._session.threadId,
        runId: i,
        toolMessageCount: e.length,
        stopAfterToolCall: o?.stopAfterToolCall === !0,
        outgoingCount: u.length
      }), await this.agent.runAgent({
        runId: i,
        tools: n,
        context: [],
        forwardedProps: o
      }, s);
    } catch (a) {
      throw console.error("Tool result submission error:", a), this.endRun(), a;
    }
  }
  // Utility methods
  generateRunId() {
    return `run_${Date.now()}_${N().slice(0, 8)}`;
  }
  generateThreadId() {
    return `thread_${Date.now()}_${N().slice(0, 8)}`;
  }
  getConfig() {
    return {
      baseUrl: this.baseUrl,
      agentId: this.agentId,
      timeout: this.timeout
    };
  }
}
const Y = re(null);
function he({ value: t, children: e }) {
  return /* @__PURE__ */ se(Y.Provider, { value: t, children: e });
}
function Fe() {
  const t = oe(Y);
  if (!t)
    throw new Error("useAgentContext must be used within an AgentProvider");
  return t;
}
function me(t) {
  const {
    baseUrl: e,
    agentId: s,
    tokenProvider: n,
    requestHandler: o,
    timeout: i,
    sendFullHistory: a,
    initialThreadId: l,
    systemContextBuilder: u,
    debug: d,
    pruneOutboundMessages: C,
    configParams: m
  } = t, [T] = v(
    () => new fe(e, s, {
      tokenProvider: n,
      requestHandler: o,
      timeout: i,
      sendFullHistory: a,
      initialThreadId: l,
      systemContextBuilder: u,
      debug: d,
      pruneOutboundMessages: C,
      configParams: m
    })
  ), [f, c] = v(T.session), [h, g] = v(!1);
  k(() => {
    T.setSessionChangeCallback(c), g(T.session.isActive);
  }, [T]), k(() => {
    g(f.isActive);
  }, [f.isActive]);
  const I = M(() => {
    T.startNewRun();
  }, [T]), x = M(() => {
    T.endRun();
  }, [T]), L = M(() => {
    T.abortRun();
  }, [T]);
  return { client: T, session: f, isStreaming: h, startNewRun: I, endRun: x, abortRun: L };
}
function Te(t) {
  for (let e = t.length - 1; e >= 0; e--) {
    const s = t[e];
    if (s.role !== "tool") {
      if (s.role === "assistant") {
        if (typeof s.content == "string" && s.content.trim().length > 0) return s.content.trim();
        continue;
      }
      return null;
    }
  }
  return null;
}
function pe(t) {
  const { finalText: e, toolCalls: s, existingMessages: n, streamingMessageId: o } = t, i = !!e, a = s.length > 0;
  if (!i && !a)
    return { messages: n, suppressedDuplicate: !1, announcedAssistantText: null };
  const l = i ? Te(n) : null, u = i && l === e;
  if (u && !a)
    return { messages: n, suppressedDuplicate: !0, announcedAssistantText: null };
  const d = {
    id: o || `msg_${Date.now()}`,
    role: "assistant"
  };
  i && !u && (d.content = e), a && (d.toolCalls = s);
  const C = new Set(s.map((f) => f.id));
  let m = n.length;
  for (; m > 0 && n[m - 1].role === "tool" && C.has(n[m - 1].toolCallId ?? ""); )
    m--;
  return {
    messages: [
      ...n.slice(0, m),
      d,
      ...n.slice(m)
    ],
    suppressedDuplicate: u,
    announcedAssistantText: i && !u ? e : null
  };
}
const Ae = {
  messages: [],
  streamingText: "",
  streamingMessageId: null,
  toolCallBuffers: /* @__PURE__ */ new Map(),
  toolCallIdToName: /* @__PURE__ */ new Map(),
  flushedToolCallIds: /* @__PURE__ */ new Set(),
  lastAnnouncedAssistantText: null,
  isAborted: !1,
  globalState: {},
  preRunMessageCount: 0
};
function Se(t, e) {
  switch (e.type) {
    case "ADD_MESSAGE":
      return { ...t, messages: [...t.messages, e.message] };
    case "SET_MESSAGES":
      return { ...t, messages: e.messages };
    case "CLEAR_MESSAGES":
      return { ...t, messages: [] };
    case "SNAPSHOT_PRE_RUN":
      return {
        ...t,
        preRunMessageCount: Math.max(0, t.messages.length - 1),
        streamingText: "",
        streamingMessageId: null,
        flushedToolCallIds: /* @__PURE__ */ new Set(),
        lastAnnouncedAssistantText: null
      };
    case "CLEAR_STREAMING":
      return { ...t, streamingText: "", streamingMessageId: null };
    case "FINALIZE_TURN": {
      const s = t.streamingText.trim(), n = [];
      for (const [a, l] of t.toolCallBuffers.entries())
        t.flushedToolCallIds.has(a) || n.push({
          id: a,
          type: "function",
          function: { name: l.name, arguments: l.argsBuffer || "{}" }
        });
      if (!s && n.length === 0)
        return {
          ...t,
          streamingText: "",
          streamingMessageId: null,
          lastAnnouncedAssistantText: null
        };
      const o = pe({
        finalText: s,
        toolCalls: n,
        existingMessages: t.messages,
        streamingMessageId: t.streamingMessageId
      }), i = new Set(t.flushedToolCallIds);
      for (const a of n) i.add(a.id);
      return {
        ...t,
        messages: o.messages,
        streamingText: "",
        streamingMessageId: null,
        flushedToolCallIds: i,
        lastAnnouncedAssistantText: o.announcedAssistantText
      };
    }
    case "TEXT_DELTA":
      return {
        ...t,
        streamingText: t.streamingText + e.delta,
        streamingMessageId: e.messageId
      };
    case "TOOL_CALL_START": {
      const s = new Map(t.toolCallBuffers);
      s.set(e.toolCallId, {
        name: e.name,
        argsBuffer: "",
        parentMessageId: e.parentMessageId
      });
      const n = new Map(t.toolCallIdToName);
      return n.set(e.toolCallId, e.name), { ...t, toolCallBuffers: s, toolCallIdToName: n };
    }
    case "TOOL_CALL_ARGS": {
      const s = t.toolCallBuffers.get(e.toolCallId);
      if (!s) return t;
      const n = new Map(t.toolCallBuffers);
      return n.set(e.toolCallId, {
        ...s,
        argsBuffer: s.argsBuffer + e.delta
      }), { ...t, toolCallBuffers: n };
    }
    case "TOOL_CALL_RESULT": {
      const s = t.toolCallBuffers.get(e.toolCallId), n = new Map(t.toolCallBuffers);
      return s && n.set(e.toolCallId, { ...s, resultReceived: !0 }), {
        ...t,
        messages: [...t.messages, e.message],
        toolCallBuffers: n
      };
    }
    case "CLEAR_TOOL_BUFFERS":
      return { ...t, toolCallBuffers: /* @__PURE__ */ new Map() };
    case "SET_ABORTED":
      return { ...t, isAborted: e.value };
    case "TERMINATE":
      return {
        ...t,
        isAborted: !0,
        streamingText: "",
        streamingMessageId: null,
        toolCallBuffers: /* @__PURE__ */ new Map(),
        toolCallIdToName: /* @__PURE__ */ new Map(),
        flushedToolCallIds: /* @__PURE__ */ new Set(),
        lastAnnouncedAssistantText: null,
        messages: t.messages.slice(0, t.preRunMessageCount)
      };
    case "UPDATE_TOOL_STATE":
      return {
        ...t,
        globalState: { ...t.globalState, [e.toolName]: e.data }
      };
    case "PATCH_GLOBAL_STATE":
      return { ...t, globalState: { ...t.globalState, ...e.patch } };
    case "MERGE_STATE_SNAPSHOT": {
      const s = { ...t.globalState, ...e.snapshot };
      for (const n of Object.keys(t.globalState))
        n.startsWith("_") && (s[n] = t.globalState[n]);
      return { ...t, globalState: s };
    }
    default:
      return t;
  }
}
function Pe(t) {
  return Object.values(t).map((e) => e.definition);
}
function Ge(t) {
  return Object.values(t).filter((e) => e.isFrontend).map((e) => e.definition);
}
function ke(t) {
  return Object.values(t).filter((e) => !e.isFrontend).map((e) => e.definition);
}
function Ce(t) {
  const e = {};
  return Object.entries(t).forEach(([s, n]) => {
    n.isFrontend && (e[s] = n);
  }), e;
}
function Ee(t, e) {
  const s = {};
  if (!t) return s;
  for (const n of t) {
    const o = e[n.name] ?? {}, i = {
      name: n.name,
      description: n.description ?? "",
      parameters: n.parameters ?? {
        type: "object",
        properties: {},
        required: []
      }
    };
    s[n.name] = {
      definition: i,
      handler: o.handler,
      renderer: o.renderer,
      onResult: o.onResult,
      isFrontend: o.isFrontend ?? n.isFrontend ?? !1,
      configJson: o.configJson ?? n.configJson
    };
  }
  return s;
}
function Ne(t) {
  const e = {};
  return Object.entries(t).forEach(([s, n]) => {
    n.renderer && (e[s] = n.renderer);
  }), e;
}
class Ie {
  constructor(e) {
    E(this, "firstTextEmittedThisTurn", !1);
    E(this, "chainedRunPending", !1);
    E(this, "bufferedSegments", []);
    E(this, "bufferedMessageIds", /* @__PURE__ */ new Set());
    this._enabled = e;
  }
  setEnabled(e) {
    this._enabled = e;
  }
  get enabled() {
    return this._enabled;
  }
  /** Called by the frontend tool runner immediately before submitting tool results. */
  markChainedRun() {
    this.chainedRunPending = !0;
  }
  /** Defensive: called when a fresh user-initiated run is about to start, so a
   *  pending chain flag from a prior turn cannot bleed into this one. */
  clearPendingChain() {
    this.chainedRunPending = !1;
  }
  /** Called on RUN_STARTED. Returns 'fresh' (turn-scoped state was reset) or
   *  'chained' (turn-scoped state preserved). */
  onRunStarted() {
    return this._enabled ? this.chainedRunPending ? (this.chainedRunPending = !1, "chained") : (this.firstTextEmittedThisTurn = !1, this.bufferedSegments = [], this.bufferedMessageIds.clear(), "fresh") : "fresh";
  }
  /** Called on TEXT_MESSAGE_START. Returns 'stream' (let the caller forward
   *  the segment to the reducer) or 'buffer' (the suppressor will hold the
   *  segment until RUN_FINISHED). */
  onTextMessageStart(e) {
    return this._enabled ? this.firstTextEmittedThisTurn ? (this.bufferedMessageIds.add(e), this.bufferedSegments.push({ messageId: e, text: "" }), "buffer") : (this.firstTextEmittedThisTurn = !0, "stream") : "stream";
  }
  isBuffered(e) {
    return this.bufferedMessageIds.has(e);
  }
  appendToBuffer(e, s) {
    const n = this.bufferedSegments.find((o) => o.messageId === e);
    n && (n.text += s);
  }
  getBufferedText(e) {
    return this.bufferedSegments.find((s) => s.messageId === e)?.text;
  }
  /** Called on RUN_FINISHED, BEFORE any tool buffers are cleared. Caller passes
   *  whether the just-finished run had any unflushed tool calls. Returns the
   *  segments to commit (final-run case) and segments to drop (intermediate-run case). */
  onRunFinished(e) {
    if (this.bufferedSegments.length === 0) return { commit: [], dropped: [] };
    const s = e ? { commit: [], dropped: this.bufferedSegments } : { commit: this.bufferedSegments, dropped: [] };
    return this.bufferedSegments = [], this.bufferedMessageIds.clear(), s;
  }
  /** Called on RUN_ERROR. Clears all turn-scoped state including the pending
   *  chain flag — the turn is aborted. */
  reset() {
    this.firstTextEmittedThisTurn = !1, this.chainedRunPending = !1, this.bufferedSegments = [], this.bufferedMessageIds.clear();
  }
}
function ye(t) {
  const { idleMs: e, maxMs: s, onExpire: n } = t;
  let o = null, i = null;
  const a = () => {
    o !== null && (clearTimeout(o), o = null), i !== null && (clearTimeout(i), i = null);
  }, l = (m) => {
    a(), n(m);
  }, u = () => {
    o !== null && clearTimeout(o), o = setTimeout(() => l("idle"), e);
  };
  return { start: () => {
    a(), i = setTimeout(() => l("max"), s), u();
  }, kick: () => {
    i !== null && u();
  }, stop: a };
}
function be(t, e, s) {
  const { onLifecycleEvent: n, onError: o, safetyTimeoutMs: i, idleTimeoutMs: a, suppressIntermediateAssistantMessages: l, tools: u = {} } = s, d = i ?? 9e5, C = a ?? 18e4, [m, T] = v(Ae), f = B(m), c = M((r) => {
    const p = Se(f.current, r);
    p !== f.current && (f.current = p, T(p));
  }, []), h = B(
    new Ie(!!l)
  );
  h.current.setEnabled(!!l);
  const g = M(() => {
    h.current.markChainedRun();
  }, []), I = M(() => {
    h.current.clearPendingChain();
  }, []), x = B(/* @__PURE__ */ new Set()), L = M((r) => (x.current.add(r), () => {
    x.current.delete(r);
  }), []), A = B(() => {
  });
  A.current = (r) => {
    console.warn(`[AG-UI] ${r === "idle" ? "Idle" : "Max-run"} timeout: forcing run end`), c({ type: "CLEAR_STREAMING" }), c({ type: "CLEAR_TOOL_BUFFERS" }), c({ type: "SET_ABORTED", value: !0 }), t.abortRun(), o?.({
      code: "timeout",
      message: r === "idle" ? `Run idle for ${C}ms with no events` : `Run exceeded max duration of ${d}ms`
    }), c({
      type: "ADD_MESSAGE",
      message: {
        id: `timeout_${Date.now()}`,
        role: "assistant",
        content: "The request timed out. Please try again."
      }
    });
  };
  const S = B(null);
  k(() => {
    if (!e) return;
    const r = ye({
      idleMs: C,
      maxMs: d,
      onExpire: (p) => A.current(p)
    });
    return S.current = r, r.start(), () => {
      r.stop(), S.current = null;
    };
  }, [e, C, d]);
  const O = B(u);
  O.current = u;
  const w = M((r) => {
    c({
      type: "ADD_MESSAGE",
      message: { id: N(), role: "assistant", content: `${r}` }
    });
  }, [c]), b = B({
    onEvent: () => {
    },
    onRunStartedEvent: () => {
    },
    onTextMessageStartEvent: () => {
    },
    onTextMessageContentEvent: () => {
    },
    onTextMessageEndEvent: () => {
    },
    onStateSnapshotEvent: () => {
    },
    onRunFinishedEvent: () => {
    },
    onRunErrorEvent: () => {
    },
    onToolCallStartEvent: () => {
    },
    onToolCallArgsEvent: () => {
    },
    onToolCallEndEvent: () => {
    },
    onToolCallResultEvent: () => {
    }
  });
  b.current.onEvent = () => {
    S.current?.kick();
  }, b.current.onRunStartedEvent = ({ event: r }) => {
    console.info("[AG-UI] RunStarted:", {
      threadId: r.threadId,
      runId: r.runId,
      message: f.current.messages.slice(-1)[0]?.content
    }), h.current.onRunStarted(), n?.({ type: "run_started" }), c({ type: "SNAPSHOT_PRE_RUN" });
  };
  const D = () => {
    const r = f.current, p = Array.from(r.toolCallBuffers.entries()).some(
      ([F, $]) => !r.flushedToolCallIds.has(F) && !$.resultReceived
    );
    if (!r.streamingText.trim() && !p) return;
    c({ type: "FINALIZE_TURN" });
    const R = f.current.lastAnnouncedAssistantText;
    R && (console.info("[AG-UI] TextMessage: ", R), n?.({ type: "message_added", role: "assistant", content: R }));
  };
  return b.current.onTextMessageStartEvent = ({ event: r }) => {
    h.current.onTextMessageStart(r.messageId) !== "buffer" && (console.info("[AG-UI] TextMessageStart:", { messageId: r.messageId, role: r.role }), D());
  }, b.current.onTextMessageContentEvent = ({ event: r }) => {
    if (h.current.isBuffered(r.messageId)) {
      h.current.appendToBuffer(r.messageId, r.delta);
      return;
    }
    c({ type: "TEXT_DELTA", messageId: r.messageId, delta: r.delta });
  }, b.current.onTextMessageEndEvent = ({ event: r }) => {
    if (h.current.isBuffered(r.messageId)) {
      const p = h.current.getBufferedText(r.messageId) ?? "";
      console.debug("[AG-UI] AssistantMessage (suppressed):", { messageId: r.messageId, content: p });
      return;
    }
    console.debug("[AG-UI] AssistantMessage:", { messageId: r.messageId, content: f.current.streamingText }), console.info("[AG-UI] TextMessageEnd:", { messageId: r.messageId });
  }, b.current.onStateSnapshotEvent = ({ event: r }) => {
    console.info("[AG-UI] StateSnapshot:", { snapshot: r.snapshot }), c({ type: "MERGE_STATE_SNAPSHOT", snapshot: r.snapshot });
  }, b.current.onRunFinishedEvent = ({ event: r }) => {
    console.info("[AG-UI] RunFinished:", { event: r });
    const p = f.current, R = Array.from(p.toolCallBuffers.entries()).some(
      ([y, U]) => !p.flushedToolCallIds.has(y) && !U.resultReceived
    ), { commit: F, dropped: $ } = h.current.onRunFinished(R);
    $.length > 0 && console.info("[AG-UI] Dropped intermediate narration:", $.map((y) => y.text));
    for (const y of F)
      y.text.trim() && (c({
        type: "ADD_MESSAGE",
        message: { id: y.messageId, role: "assistant", content: y.text }
      }), n?.({ type: "message_added", role: "assistant", content: y.text }));
    try {
      D();
    } catch (y) {
      console.error("Error creating assistant message:", y);
      const U = y instanceof Error ? y.message : String(y);
      w(`Error processing assistant response: ${U}`);
    } finally {
      c({ type: "CLEAR_STREAMING" }), t.endRun();
    }
    const G = f.current, H = [];
    for (const [y, U] of G.toolCallBuffers.entries())
      U.resultReceived || H.push({ toolCallId: y, name: U.name, argsBuffer: U.argsBuffer });
    const P = {
      finalMessages: G.messages,
      pendingToolCalls: H,
      stateSnapshot: G
    };
    for (const y of x.current)
      try {
        y(P);
      } catch (U) {
        console.error("RunFinished listener error:", U);
      }
  }, b.current.onRunErrorEvent = ({ event: r }) => {
    if (console.info("[AG-UI] RunError:", { message: r.message }), f.current.isAborted) {
      c({ type: "SET_ABORTED", value: !1 }), console.info("[AG-UI] Run aborted by user"), o?.({ code: "aborted", message: r.message, raw: r });
      return;
    }
    c({ type: "CLEAR_STREAMING" }), h.current.reset(), c({
      type: "ADD_MESSAGE",
      message: { id: `error_${Date.now()}`, role: "assistant", content: `Error: ${r.message}` }
    }), o?.({ code: "run_error", message: r.message, raw: r }), t.endRun();
  }, b.current.onToolCallStartEvent = ({ event: r }) => {
    console.info("[AG-UI] ToolCallStart:", {
      toolCallId: r.toolCallId,
      toolCallName: r.toolCallName,
      parentMessageId: r.parentMessageId
    }), n?.({ type: "tool_used", toolName: r.toolCallName }), c({
      type: "TOOL_CALL_START",
      toolCallId: r.toolCallId,
      name: r.toolCallName,
      parentMessageId: r.parentMessageId
    });
  }, b.current.onToolCallArgsEvent = ({ event: r }) => {
    console.info("[AG-UI] ToolCallArgs:", { toolCallId: r.toolCallId, delta: r.delta }), c({ type: "TOOL_CALL_ARGS", toolCallId: r.toolCallId, delta: r.delta });
  }, b.current.onToolCallEndEvent = ({ event: r }) => {
    console.info("[AG-UI] ToolCallEnd:", { toolCallId: r.toolCallId });
  }, b.current.onToolCallResultEvent = ({ event: r }) => {
    console.info("[AG-UI] ToolCallResult:", { toolCallId: r.toolCallId, content: r.content });
    try {
      const p = {
        id: `tool_result_${r.toolCallId}_${Date.now()}`,
        role: "tool",
        content: r.content || "",
        toolCallId: r.toolCallId
      };
      c({ type: "TOOL_CALL_RESULT", toolCallId: r.toolCallId, message: p });
      const R = f.current.toolCallBuffers.get(r.toolCallId);
      if (R) {
        const F = O.current[R.name];
        if (F?.onResult)
          try {
            const $ = JSON.parse(R.argsBuffer || "{}"), G = (P, y) => c({ type: "UPDATE_TOOL_STATE", toolName: P, data: y }), H = (P) => P ? f.current.globalState[P] : f.current.globalState;
            F.onResult($, r.content || "", G, H);
          } catch ($) {
            console.error(`Error calling onResult for tool ${R.name}:`, $);
          }
      }
    } catch (p) {
      console.error("Error creating tool result message:", p);
      const R = p instanceof Error ? p.message : String(p);
      w(`Error processing tool result: ${R}`);
    }
  }, {
    state: m,
    stateRef: f,
    dispatch: c,
    subscriber: b.current,
    onRunFinished: L,
    markChainedRun: g,
    clearPendingChain: I
  };
}
async function _e(t, e, s, n, o, i) {
  const a = (u) => ({
    id: `tool_${n}_${i}`,
    role: "tool",
    content: u,
    toolCallId: n
  });
  let l;
  try {
    l = s ? JSON.parse(s) : null;
  } catch (u) {
    const d = u instanceof Error ? u.message : String(u);
    return console.error(`Invalid JSON args for tool ${e}:`, u, { raw: s }), {
      message: a(JSON.stringify({ ok: !1, error: "invalid_tool_args", message: d, raw: s })),
      args: void 0,
      result: void 0,
      executed: !1
    };
  }
  try {
    const u = {
      toolCallId: n,
      toolName: e,
      stopAfterToolCall: o.stopAfterToolCall
    }, d = await t?.handler?.(l, o.updateState, o.getState, t.configJson, u);
    return { message: a(d || "{}"), args: l, result: d, executed: !0 };
  } catch (u) {
    console.error(`Tool execution error for ${e}:`, u);
    const d = u instanceof Error ? u.message : String(u);
    return {
      message: a(JSON.stringify({ ok: !1, error: "tool_execution_error", message: d })),
      args: l,
      result: void 0,
      executed: !1
    };
  }
}
function Re(t, e, s, n = {}) {
  const { buildForwardedProps: o } = n, i = J(() => Ce(s), [s]), a = B(s), l = B(i), u = B(o);
  a.current = s, l.current = i, u.current = o;
  const d = B(!1);
  k(() => {
    return t.onRunFinished((T) => {
      m().catch((f) => {
        t.dispatch({ type: "ADD_MESSAGE", message: { id: N(), role: "assistant", content: `${f}` } });
      });
    });
    async function m() {
      if (d.current) return;
      d.current = !0;
      let T = !1;
      const f = [], c = t.dispatch, h = t.stateRef, g = (A) => {
        c({ type: "ADD_MESSAGE", message: { id: N(), role: "assistant", content: `${A}` } });
      }, I = (A, S) => c({ type: "UPDATE_TOOL_STATE", toolName: A, data: S }), x = (A) => A ? h.current.globalState[A] : h.current.globalState, L = async (A, S, O) => {
        const w = l.current[A], { message: b, args: D, result: r, executed: p } = await _e(
          w,
          A,
          S,
          O,
          { updateState: I, getState: x, stopAfterToolCall: () => {
            T = !0;
          } },
          Date.now()
        );
        if (c({ type: "ADD_MESSAGE", message: b }), p && w.onResult)
          try {
            w.onResult(D, r || "", I, x);
          } catch (R) {
            console.error(`Error calling onResult for tool ${A}:`, R);
          }
        return b;
      };
      try {
        for (const [A, S] of h.current.toolCallBuffers.entries()) {
          if (S.resultReceived) continue;
          let O = null;
          l.current[S.name] ? O = await L(S.name, S.argsBuffer, A) : console.warn(`[AG-UI] Tool '${S.name}' is not a frontend tool and has no backend result — skipping`), O && f.push(O);
        }
      } catch (A) {
        g(A);
      } finally {
        if (c({ type: "CLEAR_TOOL_BUFFERS" }), f.length > 0) {
          const A = Object.values(a.current).map((w) => w.definition);
          e.client.startNewRun();
          const O = {
            ...u.current?.() ?? {},
            ...T ? { stopAfterToolCall: !0 } : {}
          };
          t.markChainedRun(), e.client.submitToolResults(
            h.current.messages,
            t.subscriber,
            A,
            O
          ).catch((w) => {
            console.error("Tool result submission failed:", w), e.client.endRun(), g(`Failed to submit tool results: ${w}`);
          });
        }
        d.current = !1;
      }
    }
  }, [t, e]);
}
function Me(t) {
  const { tools: e = {}, buildForwardedProps: s } = t, n = me(t), o = be(n.client, n.session.isActive, {
    onLifecycleEvent: t.onLifecycleEvent,
    onError: t.onError,
    safetyTimeoutMs: t.safetyTimeoutMs,
    idleTimeoutMs: t.idleTimeoutMs,
    suppressIntermediateAssistantMessages: t.suppressIntermediateAssistantMessages,
    tools: e
  });
  Re(o, n, e, { buildForwardedProps: s });
  const { state: i, stateRef: a, dispatch: l } = o, u = M((g, I) => {
    l({ type: "UPDATE_TOOL_STATE", toolName: g, data: I });
  }, [l]);
  M((g) => g ? a.current.globalState[g] : a.current.globalState, [a]);
  const d = M((g) => {
    l({ type: "ADD_MESSAGE", message: g });
  }, [l]), C = M((g) => {
    l({ type: "SET_MESSAGES", messages: g });
  }, [l]), m = M(() => {
    l({ type: "CLEAR_MESSAGES" });
  }, [l]), T = M(() => {
    n.client.abortRun(), l({ type: "TERMINATE" });
  }, [n, l]), f = M((g) => ({ ...s?.() ?? {}, ...g }), [s]), c = M(async (g, I, x) => {
    const L = e[g];
    if (!L) {
      console.error(`Tool ${g} not found`), d({
        id: `error_${Date.now()}`,
        role: "assistant",
        content: `Error: Tool '${g}' not found`
      });
      return;
    }
    const A = {
      id: `user_${Date.now()}`,
      role: "user",
      content: `invoke the ${g} tool. Parameters=${JSON.stringify(I || {})}`
    };
    o.clearPendingChain(), n.client.startNewRun();
    try {
      x && (l({ type: "PATCH_GLOBAL_STATE", patch: x }), n.client.setState({
        ...a.current.globalState,
        ...x
      }));
      const S = f(I);
      await n.client.runAgent(
        [...a.current.messages, A],
        [L.definition],
        o.subscriber,
        S
      );
    } catch (S) {
      throw console.error("Agent execution failed:", S), d({
        id: `error_${Date.now()}`,
        role: "assistant",
        content: `Error executing tool '${g}': ${S instanceof Error ? S.message : String(S)}`
      }), S;
    }
  }, [n, o.subscriber, e, d, f, l, a]), h = o.clearPendingChain;
  return J(() => ({
    agentClient: n.client,
    session: n.session,
    tools: e,
    globalState: i.globalState,
    messages: i.messages,
    addMessage: d,
    setMessages: C,
    clearMessages: m,
    updateState: u,
    currentMessage: i.streamingText,
    currentMessageId: i.streamingMessageId,
    isStreaming: n.isStreaming,
    getToolNameFromCallId: (g) => a.current.toolCallIdToName.get(g),
    agentSubscriber: o.subscriber,
    invokeToolByName: c,
    terminateRun: T,
    debug: n.client.debug,
    getForwardedProps: f,
    clearPendingChain: h
  }), [
    n.client,
    n.session,
    n.isStreaming,
    e,
    i.globalState,
    i.messages,
    i.streamingText,
    i.streamingMessageId,
    o.subscriber,
    a,
    d,
    C,
    m,
    u,
    c,
    T,
    f,
    h
  ]);
}
async function He(t) {
  return Promise.all(t.map((e) => xe(e)));
}
function xe(t) {
  return new Promise((e, s) => {
    const n = new FileReader();
    n.onload = () => {
      const i = n.result.split(",")[1];
      e({
        type: "binary",
        mimeType: t.type || "application/octet-stream",
        data: i,
        filename: t.name
      });
    }, n.onerror = () => s(n.error), n.readAsDataURL(t);
  });
}
const we = 3e4;
async function Oe(t, e, s, n, o = we, i) {
  let a = `${t}/agent/${e}`;
  if (i && Object.keys(i).length > 0) {
    const c = new URLSearchParams();
    for (const [h, g] of Object.entries(i))
      if (Array.isArray(g))
        for (const I of g) c.append(h, I);
      else
        c.append(h, g);
    a += `?${c.toString()}`;
  }
  const l = { "Content-Type": "application/json" };
  if (s) {
    const c = await s();
    c && (l.Authorization = `Bearer ${c}`);
  }
  const u = new AbortController(), d = setTimeout(() => u.abort(), o), C = n ?? fetch;
  let m;
  try {
    m = await C(a, {
      method: "GET",
      headers: l,
      signal: u.signal
    });
  } catch (c) {
    throw clearTimeout(d), c instanceof DOMException && c.name === "AbortError" ? new Error(`Config loading timed out after ${o}ms for agent '${e}'`) : c;
  } finally {
    clearTimeout(d);
  }
  if (!m.ok) {
    let c = "";
    try {
      const g = await m.text();
      g && (c = `: ${g}`);
    } catch {
    }
    const h = m.status >= 500 ? `Failed to load agent from backend server (HTTP ${m.status})${c}` : `Failed to load configuration for agent '${e}' (HTTP ${m.status})${c}`;
    throw console.error(`[ConfigService] ${h}`), new Error(h);
  }
  const T = await m.json(), f = T.suggestions.map((c) => ({
    suggestion: c.suggestion,
    isPriority: c.isPriority ?? !1
  }));
  return {
    toolConfigs: T.tools,
    suggestions: f,
    config: T.config || {}
  };
}
function je({
  baseUrl: t,
  agentId: e,
  tokenProvider: s,
  requestHandler: n,
  timeout: o,
  safetyTimeoutMs: i,
  idleTimeoutMs: a,
  tools: l,
  buildForwardedProps: u,
  systemContextBuilder: d,
  debug: C,
  sendFullHistory: m,
  pruneOutboundMessages: T,
  suppressIntermediateAssistantMessages: f,
  frontendToolImpls: c,
  onConfigLoaded: h,
  configParams: g
}) {
  const [I, x] = v(null), [L, A] = v(!0), [S, O] = v(null), w = !!t && !!e;
  k(() => {
    if (!w) return;
    let D = !1;
    return A(!0), O(null), Oe(t, e, s, n, void 0, g).then((r) => {
      if (D) return;
      c && !r.tools && (r.tools = Ee(r.toolConfigs, c));
      const p = h ? h(r) : r;
      x(p);
    }).catch((r) => {
      D || O(r);
    }).finally(() => {
      D || A(!1);
    }), () => {
      D = !0;
    };
  }, [w, t, e, s, n, g]);
  const b = J(() => {
    if (!I || !t)
      return ({ children: p }) => j.createElement(j.Fragment, null, p);
    const D = {
      baseUrl: t,
      agentId: e,
      tokenProvider: s,
      requestHandler: n,
      timeout: o,
      safetyTimeoutMs: i,
      idleTimeoutMs: a,
      tools: l ?? I.tools ?? {},
      buildForwardedProps: u,
      systemContextBuilder: d,
      debug: C,
      sendFullHistory: m,
      pruneOutboundMessages: T,
      suppressIntermediateAssistantMessages: f,
      configParams: g
    }, r = ({ children: p }) => {
      const R = Me(D);
      return j.createElement(he, { value: R, children: p });
    };
    return r.displayName = "AgentLayer", r;
  }, [I, t, e, s, n, o, i, a, l, u, d, C, m, T, f, g]);
  return { config: I, isLoading: L, error: S, AgentLayer: b };
}
const De = "|";
function qe(t) {
  const e = [], s = /* @__PURE__ */ new Map();
  for (const n of t ?? []) {
    const o = n?.suggestion;
    if (typeof o != "string") continue;
    const i = o.indexOf(De);
    if (i === -1) continue;
    const a = o.slice(0, i).trim(), l = o.slice(i + 1).trim();
    if (!a || !l) continue;
    let u = s.get(a);
    u || (u = { category: a, suggestions: [] }, s.set(a, u), e.push(u)), u.suggestions.push({ text: l, isPriority: !!n.isPriority });
  }
  return e;
}
export {
  fe as AgentClient,
  he as AgentProvider,
  De as SUGGESTION_CATEGORY_SEPARATOR,
  He as filesToBinaryContent,
  Pe as getAllToolDefinitions,
  ke as getBackendToolDefinitions,
  Ce as getFrontEndTools,
  Ge as getFrontendToolDefinitions,
  Ne as getToolRenderers,
  qe as groupSuggestionsByCategory,
  Ee as hydrateToolConfigs,
  Oe as loadAgentConfig,
  Me as useAgent,
  Fe as useAgentContext,
  me as useAgentSession,
  je as useAgentSetup,
  be as useAgentStream,
  Re as useFrontendToolRunner
};
//# sourceMappingURL=index.js.map
