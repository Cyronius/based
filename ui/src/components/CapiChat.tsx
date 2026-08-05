// Traces: BASED-CHAT-UI
// The Capi chat conversation surface. Renders the lm-ag-ui thread with Streamdown, extracts SQL
// blocks into Insert/Run affordances, and hosts the run_mutation approval card via the tool renderer.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useAgentContext } from "@itkennel/lm-ag-ui";
import type { Message } from "@ag-ui/client";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import "streamdown/styles.css";
import { useStore } from "../store";
import { useActivity } from "../agent/activityStore";
import {
  activeProfileMaxToolSteps,
  activeProfileTimeoutSeconds,
  resolveAiTimeouts,
} from "../agent/aiTimeouts";
import { parseSqlBlocks } from "../lib/sqlBlocks";
import { CapiAvatar } from "./CapiAvatar";

function SendIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M22 2 11 13" />
      <path d="M22 2 15 22l-4-9-9-4 20-7Z" />
    </svg>
  );
}

function Spinner({ className }: { className?: string }) {
  return (
    <svg className={`spin ${className ?? ""}`} width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}

function ToolIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-6 6a2 2 0 1 0 3 3l6-6a4 4 0 0 0 5.4-5.4l-2.6 2.6-2-2 2.6-2.6Z" />
    </svg>
  );
}

// Backend tool names are snake_case; render them as readable labels without shouting (project UI
// rule: no uppercasing).
function friendlyToolName(name: string): string {
  return name.replace(/[_-]+/g, " ").trim();
}

// Wall-clock for the just-completed turn: sub-minute reads as seconds (one decimal), longer as m:ss.
function formatTurnTime(ms: number): string {
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s - m * 60)}s`;
}

// One-line hint for a collapsed tool row: the first non-empty string argument, whitespace-collapsed.
function argSummary(args: Record<string, unknown>): string {
  const first = Object.values(args).find((v) => typeof v === "string" && v.trim());
  return typeof first === "string" ? first.replace(/\s+/g, " ").trim().slice(0, 100) : "";
}

// An expandable row for a settled tool call (backend tools have no bespoke renderer). Collapsed:
// name + a one-line arg hint. Open: full args and the tool result.
function ToolActivityRow({ name, args, result }: { name: string; args: Record<string, unknown>; result: string }) {
  const summary = argSummary(args);
  return (
    <details className="group my-1 rounded-md border border-line-soft bg-ink-900/40">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-2 py-1.5 text-[length:var(--fs-sm)] text-muted hover:text-paper">
        <ToolIcon />
        <span className="font-semibold text-faint shrink-0">{friendlyToolName(name)}</span>
        {summary && <span className="min-w-0 truncate text-faint/70">{summary}</span>}
        <span className="ml-auto shrink-0 text-faint transition-transform group-open:rotate-90">›</span>
      </summary>
      <div className="space-y-1.5 border-t border-line-soft px-2 py-1.5">
        <pre className="overflow-x-auto rounded bg-ink-950 p-1.5 text-[length:var(--fs-sm)] font-mono text-paper-dim">{JSON.stringify(args, null, 2)}</pre>
        {result && (
          <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded bg-ink-950 p-1.5 text-[length:var(--fs-sm)] font-mono text-paper-dim">
            {result}
          </pre>
        )}
      </div>
    </details>
  );
}

// The live abbreviated event feed for the in-flight run: each thinking/tool step, spinner on the
// active (last) one, checks on the settled ones. Cleared/reset per run by the activity store.
function LiveActivity() {
  const steps = useActivity((s) => s.steps);
  const { currentMessage } = useAgentContext();
  // Once the answer is streaming, a trailing "Thinking" placeholder is redundant with the text below.
  const visible =
    currentMessage && steps.length && steps[steps.length - 1].kind === "thinking" ? steps.slice(0, -1) : steps;
  if (visible.length === 0) {
    // Busy but no event yet (and no text streaming) — keep a spinner on screen.
    if (currentMessage) return null;
    return (
      <div className="flex items-center gap-2 text-[length:var(--fs-sm)] fade-up">
        <Spinner className="shrink-0 text-brass" />
        <span className="font-semibold text-faint pulse-soft">Working…</span>
      </div>
    );
  }
  return (
    <div className="space-y-1 fade-up">
      {visible.map((st, i) => {
        const active = i === visible.length - 1;
        return (
          <div key={st.id} className="flex items-center gap-2 text-[length:var(--fs-sm)]">
            {active ? <Spinner className="shrink-0 text-brass" /> : <span className="shrink-0 text-ok">✓</span>}
            <span className="font-semibold text-faint">{st.kind === "tool" ? friendlyToolName(st.label) : st.label}</span>
            {active && <span className="text-faint pulse-soft">…</span>}
          </div>
        );
      })}
    </div>
  );
}

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown animated plugins={{ code, mermaid }} isAnimating={!!streaming}>
      {text}
    </Streamdown>
  );
}

function SqlActions({ text }: { text: string }) {
  const insert = useStore((s) => s.insertSqlIntoEditor);
  const run = useStore((s) => s.runSqlInNewTab);
  const blocks = parseSqlBlocks(text);
  if (blocks.length === 0) return null;
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {blocks.map((b, i) => (
        <div key={i} className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="ledger-label text-faint min-w-0 truncate">
              {b.label ?? `sql ${blocks.length > 1 ? i + 1 : ""}`.trim()}
            </span>
            <button className="text-[length:var(--fs-sm)] text-brass hover:underline shrink-0" onClick={() => insert(b.sql)}>
              Insert
            </button>
            <button className="text-[length:var(--fs-sm)] text-brass hover:underline shrink-0" onClick={() => void run(b.sql)}>
              Run
            </button>
          </div>
          <div className="font-mono text-[length:var(--fs-sm)] text-faint truncate">{b.firstLine}</div>
        </div>
      ))}
    </div>
  );
}

export function CapiChat() {
  const {
    messages,
    currentMessage,
    isStreaming,
    addMessage,
    agentClient,
    agentSubscriber,
    tools: toolDefs,
    getForwardedProps,
    getToolNameFromCallId,
    terminateRun,
  } = useAgentContext();
  const [input, setInput] = useState("");
  // Wall-clock of the most recently completed turn; cleared at the start of each new send so the
  // readout only ever belongs to the last answer.
  const [lastTurnMs, setLastTurnMs] = useState<number | null>(null);
  const open = useStore((s) => s.rightRailOpen);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // React state updates (isStreaming) aren't visible to a second `send()` call that
  // fires in the same tick (e.g. Enter racing a click) — this ref closes that window.
  const sendingRef = useRef(false);
  // Stick-to-bottom: follow new content while the user is parked at the bottom, but never
  // yank them back down once they've scrolled up to read history.
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stuckRef = useRef(true);

  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  };

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // A small slack so sub-pixel rounding and the last line's leading still count as "at bottom".
    stuckRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  // Any growth of the message content (streaming text, activity steps, late mermaid/code renders)
  // scrolls to the bottom — but only if the user hadn't scrolled away.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (stuckRef.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const sendText = async (text: string) => {
    if (isStreaming || sendingRef.current) return;
    sendingRef.current = true;
    setLastTurnMs(null);
    const startedAt = performance.now();
    try {
      const userMsg: Message = { id: `msg_${Date.now()}`, role: "user", content: text };
      // Sending is an explicit intent to see the reply — re-pin to the bottom.
      stuckRef.current = true;
      addMessage(userMsg);
      useActivity.getState().clear();
      agentClient.startNewRun();
      await agentClient.runAgent(
        [...messages, userMsg],
        Object.values(toolDefs).map((t) => t.definition),
        agentSubscriber,
        getForwardedProps(),
      );
      // runAgent resolves at turn end (after any chained tool runs) — wall-clock from send to answer.
      setLastTurnMs(performance.now() - startedAt);
    } finally {
      sendingRef.current = false;
    }
  };

  const send = async () => {
    const text = input.trim();
    if (!text || isStreaming || sendingRef.current) return;
    setInput("");
    await sendText(text);
  };

  // Traces: BASED-AGENT-CONTINUE-PROMPT — both caps ask instead of killing the run.
  //
  // Stall checkpoint: the profile's timeout window is measured against visible progress (streamed
  // text, finalized messages, activity steps). When it lapses, offer Keep waiting (re-arm the
  // window as if from 0) / Stop (terminateRun) rather than aborting outright — a slow local model
  // that needs 10 minutes but keeps producing is never interrupted at all.
  const stallMs = resolveAiTimeouts(useStore((s) => activeProfileTimeoutSeconds(s.aiProfiles, s.activeAiProfileId))).idleMs;
  const maxToolSteps = useStore((s) => activeProfileMaxToolSteps(s.aiProfiles, s.activeAiProfileId));
  const activitySteps = useActivity((s) => s.steps);
  const [stalled, setStalled] = useState(false);
  // Bumped by Keep waiting: re-runs the effect below, which re-arms a fresh window.
  const [stallExtensions, setStallExtensions] = useState(0);
  useEffect(() => {
    setStalled(false);
    if (!isStreaming) return;
    const t = setTimeout(() => setStalled(true), stallMs);
    return () => clearTimeout(t);
  }, [isStreaming, messages, currentMessage, activitySteps, stallMs, stallExtensions]);
  const stallLabel = stallMs >= 120_000 ? `${Math.round(stallMs / 60_000)} minutes` : `${Math.round(stallMs / 1000)} seconds`;

  // Step-cap checkpoint: a run that exhausts its tool budget ends tool-calls-last with no final
  // assistant text (Mastra stops the loop cold). That shape — indistinguishable from a model that
  // chose to end on a tool call, where continuing is equally the right offer — gets a "keep going?"
  // prompt whose Continue turn starts a fresh run and therefore a fresh step budget.
  const lastNonTool = [...messages].reverse().find((m) => m.role !== "tool");
  const lastToolCalls = (lastNonTool as { toolCalls?: unknown[] } | undefined)?.toolCalls;
  const endedOnToolCalls =
    !isStreaming &&
    lastNonTool?.role === "assistant" &&
    !!lastToolCalls?.length &&
    !(typeof lastNonTool.content === "string" && lastNonTool.content.trim());
  const [dismissedContinueId, setDismissedContinueId] = useState<string | null>(null);
  const showContinue = endedOnToolCalls && dismissedContinueId !== lastNonTool?.id;

  // Message ids are not unique. When a run interleaves tool calls, the Mastra bridge pins every
  // later text segment of that run to one continuation id (`<base>-agui-text`), the client re-emits
  // a text-message start after each tool round under that same id, and lm-ag-ui finalizes one
  // message per start — so several entries arrive sharing an id. React keys have to be unique among
  // siblings or the reconciler mismatches fibers and repeats whole blocks on screen, so number the
  // repeats here. First occurrence keeps the bare id: only genuine collisions get a new key, and an
  // append never re-keys what is already mounted.
  const rendered = useMemo(() => {
    const seen = new Map<string, number>();
    return messages.map((m) => {
      const n = (seen.get(m.id) ?? 0) + 1;
      seen.set(m.id, n);
      return { m, key: n === 1 ? m.id : `${m.id}#${n}` };
    });
  }, [messages]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div ref={scrollRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
        <div ref={contentRef} className="pl-3 pr-4 py-2 space-y-3">
        {messages.length === 0 && !isStreaming && (
          <p className="text-[length:var(--fs-base)] text-muted leading-relaxed break-words">
            Ask about your schema, generate SQL, or request a change. Answers stream here; SQL blocks
            get <span className="text-brass">Insert</span> / <span className="text-brass">Run</span> actions.
          </p>
        )}
        {rendered.map(({ m, key }) => {
          const toolCalls = (m as unknown as { toolCalls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> }).toolCalls;
          if (m.role === "assistant" && toolCalls?.length) {
            // A single assistant turn can carry both narration text and its tool calls
            // (FINALIZE_TURN bundles them when a backend tool resolves mid-run and the
            // agent writes its answer in the same turn) — render the text once for the
            // message, not once per tool call.
            return (
              <div key={key} className="fade-up">
                {typeof m.content === "string" && m.content && (
                  <div className="text-[length:var(--fs-md)] leading-relaxed break-words">
                    <Markdown text={m.content} />
                  </div>
                )}
                {toolCalls.map((tc) => {
                  const name = tc.function?.name ?? getToolNameFromCallId(tc.id);
                  const tool = name ? toolDefs[name] : undefined;
                  let args: Record<string, unknown> = {};
                  try {
                    args = JSON.parse(tc.function?.arguments || "{}");
                  } catch {
                    // partial/streaming args — render with what we have
                  }
                  const resultMsg = messages.find((x) => x.role === "tool" && (x as unknown as { toolCallId?: string }).toolCallId === tc.id);
                  const result = (resultMsg?.content as string) ?? "";
                  return (
                    <div key={tc.id}>
                      {tool?.renderer
                        ? ((tool.renderer(args, result, () => {}, () => undefined, tool.configJson) as unknown as ReactNode) ?? null)
                        : name && <ToolActivityRow name={name} args={args} result={result} />}
                    </div>
                  );
                })}
              </div>
            );
          }
          if (m.role === "tool") return null; // rendered next to its call
          if (m.role === "user") {
            return (
              <div key={key} className="text-right">
                <span className="inline-block max-w-full rounded-md bg-ink-800 px-2.5 py-1.5 text-[length:var(--fs-base)] text-paper-dim break-words">
                  {typeof m.content === "string" ? m.content : "[attachment]"}
                </span>
              </div>
            );
          }
          const content = typeof m.content === "string" ? m.content : "";
          return (
            <div key={key} className="fade-up text-[length:var(--fs-md)] leading-relaxed break-words">
              <Markdown text={content} />
              <SqlActions text={content} />
            </div>
          );
        })}
        {isStreaming && <LiveActivity />}
        {isStreaming && currentMessage && (
          <div className="text-[length:var(--fs-md)] leading-relaxed break-words">
            <Markdown text={currentMessage} streaming />
          </div>
        )}
        {isStreaming && stalled && (
          <div className="fade-up rounded-md border border-brass/30 bg-brass/10 px-2.5 py-2 text-[length:var(--fs-sm)]">
            <div className="text-paper-dim">No response from the model for {stallLabel}.</div>
            <div className="mt-1.5 flex gap-2">
              <button
                className="rounded border border-brass/40 px-2 py-0.5 font-semibold text-brass hover:bg-brass/10"
                onClick={() => setStallExtensions((n) => n + 1)}
              >
                Keep waiting
              </button>
              <button
                className="rounded border border-line px-2 py-0.5 text-muted hover:text-paper"
                onClick={() => terminateRun()}
              >
                Stop
              </button>
            </div>
          </div>
        )}
        {!isStreaming && lastTurnMs != null && messages.length > 0 && (
          <div className="text-[length:var(--fs-sm)] text-faint">{formatTurnTime(lastTurnMs)}</div>
        )}
        {showContinue && (
          <div className="fade-up rounded-md border border-brass/30 bg-brass/10 px-2.5 py-2 text-[length:var(--fs-sm)]">
            <div className="text-paper-dim">
              Capi stopped without a final answer — it may have hit the tool call limit ({maxToolSteps}).
            </div>
            <div className="mt-1.5 flex gap-2">
              <button
                className="rounded border border-brass/40 px-2 py-0.5 font-semibold text-brass hover:bg-brass/10"
                onClick={() => void sendText("Continue.")}
              >
                Keep going
              </button>
              <button
                className="rounded border border-line px-2 py-0.5 text-muted hover:text-paper"
                onClick={() => setDismissedContinueId(lastNonTool?.id ?? null)}
              >
                Dismiss
              </button>
            </div>
          </div>
        )}
        </div>
      </div>
      <div className="border-t border-line-soft pl-2 pr-3 py-2">
        <div className="flex items-stretch gap-2">
          <div className="flex w-24 shrink-0 items-center justify-center">
            <CapiAvatar className="h-24 w-auto" />
          </div>
          <div className="relative flex-1 min-w-0">
            <textarea
              ref={inputRef}
              className="h-full w-full resize-none rounded-md border border-line bg-ink-800 px-2 py-1.5 pr-9 text-[length:var(--fs-md)] text-paper placeholder:text-faint focus:border-brass-soft focus:outline-none"
              rows={2}
              placeholder="Ask about the database…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              disabled={isStreaming}
            />
            <button
              className="absolute right-1.5 bottom-1.5 rounded p-1 text-brass hover:text-brass-soft disabled:opacity-40"
              title="Send"
              onClick={() => void send()}
              disabled={isStreaming || !input.trim()}
            >
              <SendIcon />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
