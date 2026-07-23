// Traces: BASED-CHAT-UI
// The Capi chat conversation surface. Renders the lm-ag-ui thread with Streamdown, extracts SQL
// blocks into Insert/Run affordances, and hosts the run_mutation approval card via the tool renderer.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useAgentContext } from "@itkennel/lm-ag-ui";
import type { Message } from "@ag-ui/client";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import "streamdown/styles.css";
import { useStore } from "../store";
import { parseSqlBlocks } from "../lib/sqlBlocks";

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
  } = useAgentContext();
  const [input, setInput] = useState("");
  const open = useStore((s) => s.rightRailOpen);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const send = async () => {
    const text = input.trim();
    if (!text || isStreaming) return;
    const userMsg: Message = { id: `msg_${Date.now()}`, role: "user", content: text };
    setInput("");
    addMessage(userMsg);
    agentClient.startNewRun();
    await agentClient.runAgent(
      [...messages, userMsg],
      Object.values(toolDefs).map((t) => t.definition),
      agentSubscriber,
      getForwardedProps(),
    );
  };

  return (
    <div className="flex flex-1 min-h-0 min-w-0 flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pl-3 pr-4 py-2 space-y-3">
        {messages.length === 0 && !isStreaming && (
          <p className="text-[length:var(--fs-base)] text-muted leading-relaxed break-words">
            Ask about your schema, generate SQL, or request a change. Answers stream here; SQL blocks
            get <span className="text-brass">Insert</span> / <span className="text-brass">Run</span> actions.
          </p>
        )}
        {messages.map((m) => {
          const toolCalls = (m as unknown as { toolCalls?: Array<{ id: string; function?: { name?: string; arguments?: string } }> }).toolCalls;
          if (m.role === "assistant" && toolCalls?.length) {
            return toolCalls.map((tc) => {
              const name = tc.function?.name ?? getToolNameFromCallId(tc.id);
              const tool = name ? toolDefs[name] : undefined;
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(tc.function?.arguments || "{}");
              } catch {
                // partial/streaming args — render with what we have
              }
              const resultMsg = messages.find((x) => x.role === "tool" && (x as unknown as { toolCallId?: string }).toolCallId === tc.id);
              return (
                <div key={tc.id} className="fade-up">
                  {typeof m.content === "string" && m.content && (
                    <div className="text-[length:var(--fs-md)] leading-relaxed break-words">
                      <Markdown text={m.content} />
                    </div>
                  )}
                  {(tool?.renderer?.(args, (resultMsg?.content as string) ?? "", () => {}, () => undefined, tool.configJson) as unknown as ReactNode) ?? null}
                </div>
              );
            });
          }
          if (m.role === "tool") return null; // rendered next to its call
          if (m.role === "user") {
            return (
              <div key={m.id} className="text-right">
                <span className="inline-block max-w-full rounded-md bg-ink-800 px-2.5 py-1.5 text-[length:var(--fs-base)] text-paper-dim break-words">
                  {typeof m.content === "string" ? m.content : "[attachment]"}
                </span>
              </div>
            );
          }
          const content = typeof m.content === "string" ? m.content : "";
          return (
            <div key={m.id} className="fade-up text-[length:var(--fs-md)] leading-relaxed break-words">
              <Markdown text={content} />
              <SqlActions text={content} />
            </div>
          );
        })}
        {isStreaming && currentMessage && (
          <div className="text-[length:var(--fs-md)] leading-relaxed break-words">
            <Markdown text={currentMessage} streaming />
          </div>
        )}
      </div>
      <div className="border-t border-line-soft pl-2 pr-3 py-2">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            className="flex-1 min-w-0 resize-none rounded-md border border-line bg-ink-800 px-2 py-1.5 text-[length:var(--fs-md)] text-paper placeholder:text-faint focus:border-brass-soft focus:outline-none"
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
            className="rounded-md bg-brass px-3 py-1.5 text-[length:var(--fs-base)] font-medium text-ink-950 disabled:opacity-40"
            onClick={() => void send()}
            disabled={isStreaming || !input.trim()}
          >
            {isStreaming ? "…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
