// Traces: BASED-UI-LAYOUT, BASED-CHAT-UI, BASED-AGENT-TAB-TOOLS, BASED-AGENT-THREADS,
//         BASED-CHAT-HISTORY-PICKER
// The right-hand rail hosts Ask Capi. Chat is PER-WINDOW: the window holds an active-conversation
// pointer per connection (store.capiThreads), so switching tabs never touches the conversation.
// The chat session remounts keyed on the pointed-at thread id — the AgentClient's threadId is
// fixed at construction (initialThreadId), so a keyed remount IS the thread switch; it happens on
// a connection switch, "New chat" (fresh id, old conversation becomes history) or a history-picker
// reactivation. In-session switches restore from a module-level message cache; cold starts seed
// from the server's thread-history endpoint. A switch during a streaming run is deferred (banner)
// until the run finishes — never kill an in-flight run. AI provider setup and agent instructions
// live in the gear-icon settings popover (BASED-AI-PROVIDER-PROFILES).
import { useEffect, useRef, useState } from "react";
import { useAgent, AgentProvider } from "@itkennel/lm-ag-ui";
import { useStore } from "../store";
import { useActivity } from "../agent/activityStore";
import { token, sessionId, AGENT_BASE_URL } from "../api/client";
import { capiToolsFor } from "../agent/capiTools";
import { WATCHDOG_BACKSTOP_MS } from "../agent/aiTimeouts";
import { buildTabContext } from "../agent/tabContext";
import {
  fetchThreadHistory,
  fetchThreadList,
  newChatThreadId,
  pruneRestored,
  threadMessageCache,
  type ChatThreadSummary,
} from "../agent/threads";
import { downloadTranscript } from "../agent/transcriptDownload";
import { CapiAvatar } from "./CapiAvatar";
import { CapiChat } from "./CapiChat";
import { relativeTime } from "./HistoryPanel";
import { IconButton } from "./IconButton";
import { DownloadIcon, HistoryIcon } from "./icons";

const WIDTH_KEY = "based:rightRailWidth";
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 384;

function loadWidth(): number {
  const stored = Number(localStorage.getItem(WIDTH_KEY));
  return Number.isFinite(stored) && stored >= MIN_WIDTH && stored <= MAX_WIDTH ? stored : DEFAULT_WIDTH;
}

function NewChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  );
}

function CapiHeader({
  toggle,
  onNewChat,
  newChatDisabled,
  onDownload,
  downloadDisabled,
  onHistory,
  historyDisabled,
}: {
  toggle: () => void;
  onNewChat?: () => void;
  newChatDisabled?: boolean;
  onDownload?: () => void;
  downloadDisabled?: boolean;
  onHistory?: () => void;
  historyDisabled?: boolean;
}) {
  return (
    <header className="flex items-center gap-3 border-b border-line-soft pl-3 pr-4 py-4">
      <button
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-lg text-faint hover:bg-ink-800 hover:text-brass"
        title="Collapse Capi (Ctrl+J)"
        onClick={toggle}
      >
        <span>›</span>
      </button>
      <span className="font-sans text-[length:var(--fs-md)] font-semibold text-faint">Ask Capi</span>
      {/* One trailing group with the auto margin on the wrapper: `ml-auto` on each button would put
          an auto gap BETWEEN them and push them apart instead of grouping them at the right edge. */}
      <div className="ml-auto flex items-center gap-1">
        {/* Traces: BASED-CHAT-HISTORY-PICKER — browse this connection's recent conversations. The
            marker span lets the popover's outside-mousedown handler skip the toggle button, so
            clicking it while open closes rather than close-and-reopen. */}
        {onHistory && (
          <span data-history-toggle>
            <IconButton
              className="text-faint hover:text-brass"
              title="Chat history"
              aria-label="Chat history"
              onClick={onHistory}
              disabled={historyDisabled}
            >
              <HistoryIcon />
            </IconButton>
          </span>
        )}
        {/* Traces: BASED-CHAT-TRANSCRIPT-UI — the user shouldn't have to ask the agent to save their
            own conversation, and this path also catches the reply the agent-side tool can't see yet. */}
        {onDownload && (
          <IconButton
            className="text-faint hover:text-brass"
            title="Download transcript"
            aria-label="Download transcript"
            onClick={onDownload}
            disabled={downloadDisabled}
          >
            <DownloadIcon />
          </IconButton>
        )}
        {onNewChat && (
          <IconButton
            className="text-faint hover:text-brass"
            title="New chat"
            aria-label="New chat"
            onClick={onNewChat}
            disabled={newChatDisabled}
          >
            <NewChatIcon />
          </IconButton>
        )}
      </div>
    </header>
  );
}

// Traces: BASED-CHAT-HISTORY-PICKER — the connection's last 15 conversations, newest first,
// server-titled (deterministic first-words titles). Clicking a row moves the window's pointer;
// the keyed remount plus the message cache / history fetch do the rest.
function ChatHistoryPopover({
  connectionId,
  activeThreadId,
  onClose,
}: {
  connectionId: string;
  activeThreadId: string;
  onClose: () => void;
}) {
  const [threads, setThreads] = useState<ChatThreadSummary[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetchThreadList(connectionId).then(setThreads);
  }, [connectionId]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (ref.current && !ref.current.contains(e.target as Node) && !t?.closest?.("[data-history-toggle]")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="absolute right-2 top-14 z-30 w-72 max-h-80 overflow-y-auto rounded border border-line bg-ink-850 shadow-xl shadow-black/40 fade-up py-1"
    >
      {threads === null ? (
        <div className="px-3 py-2 text-[length:var(--fs-sm)] text-muted pulse-soft">Loading…</div>
      ) : threads.length === 0 ? (
        <div className="px-3 py-2 text-[length:var(--fs-sm)] text-muted">No previous chats on this connection.</div>
      ) : (
        threads.map((t) => (
          <button
            key={t.id}
            className={`block w-full text-left px-3 py-1.5 hover:bg-ink-900 ${t.id === activeThreadId ? "text-brass" : "text-paper-dim"}`}
            onClick={() => {
              useStore.getState().setCapiThread(connectionId, t.id);
              onClose();
            }}
          >
            <div className="truncate text-[length:var(--fs-base)]">{t.title}</div>
            <div className="text-[length:var(--fs-sm)] text-faint">{relativeTime(t.updatedAt)}</div>
          </button>
        ))
      )}
    </div>
  );
}

// One mounted chat session, pinned to a single thread id. Remounted (via key) to switch threads.
function ChatSession({
  toggle,
  threadId,
  connectionId,
  onStreamingChange,
  deferredNotice,
}: {
  toggle: () => void;
  threadId: string;
  connectionId: string;
  onStreamingChange: (streaming: boolean) => void;
  deferredNotice: string | null;
}) {
  const [err, setErr] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const capabilities = useStore((s) => s.capabilities);
  const agent = useAgent({
    baseUrl: AGENT_BASE_URL,
    agentId: "capi",
    // Traces: BASED-AGENT-SURFACE-VARIANT — the frontend half of capability-driven tool exposure.
    // These definitions ride RunAgentInput.tools straight into the model's tool list, so an
    // unfiltered map advertises run_mutation/import_csv on read-only connections.
    tools: capiToolsFor(capabilities),
    // Traces: BASED-AI-PROFILE-TIMEOUT, BASED-AGENT-CONTINUE-PROMPT — the library watchdog's expiry
    // hard-codes an abort + "The request timed out.", so it is demoted to a leak-guard backstop;
    // the profile's timeout instead drives CapiChat's ask-to-keep-waiting stall prompt.
    idleTimeoutMs: WATCHDOG_BACKSTOP_MS,
    safetyTimeoutMs: WATCHDOG_BACKSTOP_MS,
    tokenProvider: async () => token,
    sendFullHistory: false,
    initialThreadId: threadId,
    configParams: { sid: sessionId },
    // Traces: BASED-AGENT-TAB-CONTEXT — the workspace snapshot rides every send (runAgent AND the
    // frontend-tool-runner's chained submitToolResults), rendered server-side into instructions.
    buildForwardedProps: () => ({ tabContext: buildTabContext(useStore.getState()) }),
    // Restored-history messages stay off the wire — the server already has them under real ids.
    pruneOutboundMessages: pruneRestored,
    onError: (e) => setErr(e.message),
    onLifecycleEvent: (e) => useActivity.getState().onLifecycle(e),
  });

  const seededRef = useRef(false);
  // `useAgent` returns a fresh memo object whenever the messages change, so the mount-only effect
  // below closes over the mount-time snapshot (forever empty). Async guards must read this ref.
  const liveMessages = useRef(agent.messages);
  liveMessages.current = agent.messages;
  useEffect(() => {
    const cached = threadMessageCache.get(threadId);
    if (cached?.length) {
      agent.setMessages(cached);
      seededRef.current = true;
    } else {
      void fetchThreadHistory(threadId, connectionId).then((msgs) => {
        // Don't clobber a conversation the user already started while history was in flight — nor
        // one they cleared with New chat (fetchThreadHistory returns [] for a reset thread).
        if (msgs.length > 0 && !seededRef.current && liveMessages.current.length === 0) agent.setMessages(msgs);
        seededRef.current = true;
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only: the component is keyed by threadId
  }, []);

  // Mirror the live conversation into the cache so switching back to this thread is instant.
  useEffect(() => {
    if (agent.messages.length > 0) threadMessageCache.set(threadId, agent.messages);
  }, [agent.messages, threadId]);

  useEffect(() => {
    onStreamingChange(agent.isStreaming);
  }, [agent.isStreaming, onStreamingChange]);

  const newChat = () => {
    useActivity.getState().clear();
    // The old conversation becomes history (BASED-CHAT-HISTORY-PICKER): mint a fresh thread and
    // move the window's pointer — nothing is deleted. The pointer change remounts this session.
    useStore.getState().setCapiThread(connectionId, newChatThreadId());
  };

  // Traces: BASED-CHAT-TRANSCRIPT-UI — `agent.messages` is the transcript source, not the server's
  // copy: it already holds the reply that Mastra has not flushed to agent.db yet. The originating
  // tab's title becomes the document heading so a saved file says what it is about.
  const downloadChat = () => {
    const tabTitle = useStore.getState().tabs.find((t) => t.id === useStore.getState().activeTabId)?.title;
    setErr(null);
    void downloadTranscript(agent.messages, tabTitle).catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  };

  return (
    <AgentProvider value={agent}>
      <div className="relative flex flex-1 min-h-0 min-w-0 flex-col">
        <CapiHeader
          toggle={toggle}
          onNewChat={newChat}
          newChatDisabled={agent.isStreaming}
          onDownload={downloadChat}
          downloadDisabled={agent.messages.length === 0 || agent.isStreaming}
          onHistory={() => setHistoryOpen((o) => !o)}
          historyDisabled={agent.isStreaming}
        />
        {historyOpen && (
          <ChatHistoryPopover connectionId={connectionId} activeThreadId={threadId} onClose={() => setHistoryOpen(false)} />
        )}
        {deferredNotice && (
          <div className="border-b border-brass/30 bg-brass/10 pl-3 pr-4 py-2 text-[length:var(--fs-sm)] text-brass">
            Capi is finishing {deferredNotice} — the chat will follow when it's done.
          </div>
        )}
        {err && (
          <div className="flex items-start gap-2 border-b border-err/30 bg-err/10 pl-3 pr-4 py-2 text-[length:var(--fs-sm)] text-err">
            <span className="flex-1 font-mono break-words">{err}</span>
            <IconButton size="sm" title="Dismiss" aria-label="Dismiss error" className="text-muted hover:text-paper" onClick={() => setErr(null)}>
              ✕
            </IconButton>
          </div>
        )}
        <CapiChat />
      </div>
    </AgentProvider>
  );
}

function CapiRail({ toggle, connectionId }: { toggle: () => void; connectionId: string }) {
  const connections = useStore((s) => s.connections);
  // The window's active conversation for this connection — minted by connect()'s ensureCapiThread,
  // moved by "New chat" and the history picker (BASED-CHAT-HISTORY-PICKER).
  const desiredThreadId = useStore((s) => s.capiThreads[connectionId]);
  const [mounted, setMounted] = useState(() => ({ threadId: desiredThreadId, connectionId }));
  const [streaming, setStreaming] = useState(false);

  // Follow the pointer — but never mid-run: remounting would kill the stream, so a switch while
  // streaming (connection change, New chat, or a picker reactivation) is deferred until the run
  // settles. Tab switches never change the thread.
  useEffect(() => {
    if (!streaming && desiredThreadId && mounted.threadId !== desiredThreadId) setMounted({ threadId: desiredThreadId, connectionId });
  }, [streaming, desiredThreadId, connectionId, mounted.threadId]);

  if (!mounted.threadId) return null; // pointer is minted during connect; at most a frame away

  const deferredNotice =
    desiredThreadId && mounted.threadId !== desiredThreadId
      ? mounted.connectionId !== connectionId
        ? `a run on ${connections.find((c) => c.id === mounted.connectionId)?.name ?? "another connection"}`
        : "the current run"
      : null;

  return (
    <ChatSession
      key={mounted.threadId}
      threadId={mounted.threadId}
      connectionId={mounted.connectionId}
      toggle={toggle}
      onStreamingChange={setStreaming}
      deferredNotice={deferredNotice}
    />
  );
}

export function RightRail() {
  const open = useStore((s) => s.rightRailOpen);
  const toggle = useStore((s) => s.toggleRightRail);
  const connected = useStore((s) => s.activeConnectionId);
  const [width, setWidth] = useState(loadWidth);
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const next = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, window.innerWidth - e.clientX));
      setWidth(next);
      localStorage.setItem(WIDTH_KEY, String(next));
    };
    const onUp = () => setDragging(false);
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [dragging]);

  return (
    <aside
      className={`relative shrink-0 flex border-l border-line-soft bg-ink-950 ${dragging ? "" : "transition-[width]"}`}
      style={{ width: open ? width : 32 }}
    >
      {open && (
        <div
          className="absolute left-0 top-0 z-10 h-full w-1 -translate-x-1/2 cursor-ew-resize hover:bg-brass/40 active:bg-brass/50"
          title="Drag to resize"
          onMouseDown={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
        />
      )}
      {!open && (
        <button
          className="w-8 shrink-0 flex flex-col items-center pt-3 gap-2 text-faint hover:text-brass"
          title="Expand Capi (Ctrl+J)"
          onClick={toggle}
        >
          <span className="text-[length:var(--fs-sm)]">‹</span>
          <span className="ledger-label" style={{ writingMode: "vertical-rl", color: "var(--color-paper-dim)" }}>
            capi
          </span>
        </button>
      )}
      {/* Kept mounted while connected so the chat thread survives collapse; hidden when closed. */}
      {connected ? (
        <div className={open ? "flex flex-1 min-w-0" : "hidden"}>
          <CapiRail toggle={toggle} connectionId={connected} />
        </div>
      ) : (
        open && (
          <div className="flex flex-1 min-w-0 flex-col fade-up">
            <CapiHeader toggle={toggle} />
            <div className="p-4 pr-5">
              <CapiAvatar className="w-36 h-auto mb-3" />
              <div className="ledger-label mb-3">Capi</div>
              <p className="text-[length:var(--fs-base)] text-muted leading-relaxed break-words">Connect to a database to chat with the agent.</p>
            </div>
          </div>
        )
      )}
    </aside>
  );
}
