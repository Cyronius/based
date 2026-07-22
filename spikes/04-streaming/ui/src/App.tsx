// Phase 0 spike #4 UI — lm-ag-ui useAgent against the Bun.serve AG-UI endpoint,
// Streamdown rendering assistant markdown (SQL highlighting + mermaid), and the
// confirm_mutation approval-card round-trip.
import { useState } from "react";
import { useAgent, AgentProvider, useAgentContext } from "@itkennel/lm-ag-ui";
import type { Message } from "@ag-ui/client";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { mermaid } from "@streamdown/mermaid";
import "streamdown/styles.css";
import { tools } from "./tools";

const TOKEN = "spike-launch-token-1f88"; // per-launch token (fixed for the spike)

function Markdown({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <Streamdown animated plugins={{ code, mermaid }} isAnimating={!!streaming}>
      {text}
    </Streamdown>
  );
}

function ChatUI() {
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
  const [input, setInput] = useState("Who are our top customers? Flag them too.");

  const send = async () => {
    if (!input.trim() || isStreaming) return;
    const userMsg: Message = { id: `msg_${Date.now()}`, role: "user", content: input };
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
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-lg font-bold mb-1">based — spike 4: streaming path</h1>
      <p className="text-sm text-gray-500 mb-4">
        Mastra (mock model) → AG-UI bridge → Bun.serve SSE → lm-ag-ui → Streamdown
      </p>
      <div data-testid="messages" className="space-y-3 mb-4">
        {messages.map((m) => {
          const toolCalls = (m as any).toolCalls as any[] | undefined;
          if (m.role === "assistant" && toolCalls?.length) {
            return toolCalls.map((tc) => {
              const name = tc.function?.name ?? getToolNameFromCallId(tc.id);
              const tool = name ? toolDefs[name] : undefined;
              if (!tool?.renderer) return null;
              const resultMsg = messages.find(
                (x) => x.role === "tool" && (x as any).toolCallId === tc.id,
              );
              let args: any = {};
              try {
                args = JSON.parse(tc.function?.arguments || "{}");
              } catch {}
              return (
                <div key={tc.id}>
                  {typeof m.content === "string" && m.content && (
                    <div className="bg-gray-50 border border-gray-200 rounded-lg p-3" data-testid="assistant-md">
                      <Markdown text={m.content} />
                    </div>
                  )}
                  {tool.renderer(args, (resultMsg?.content as string) ?? "", () => {}, () => undefined, tool.configJson)}
                </div>
              );
            });
          }
          if (m.role === "tool") return null; // rendered with its call above
          if (m.role === "user") {
            return (
              <div key={m.id} className="text-right">
                <span className="inline-block bg-blue-600 text-white rounded-lg px-3 py-2 text-sm">
                  {typeof m.content === "string" ? m.content : "[attachment]"}
                </span>
              </div>
            );
          }
          return (
            <div key={m.id} className="bg-gray-50 border border-gray-200 rounded-lg p-3" data-testid="assistant-md">
              <Markdown text={typeof m.content === "string" ? m.content : ""} />
            </div>
          );
        })}
        {isStreaming && currentMessage && (
          <div className="bg-gray-50 border border-blue-200 rounded-lg p-3" data-testid="streaming-md">
            <Markdown text={currentMessage} streaming />
          </div>
        )}
      </div>
      <div className="flex gap-2">
        <input
          data-testid="chat-input"
          className="flex-1 border border-gray-300 rounded-lg px-3 py-2 text-sm"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          disabled={isStreaming}
        />
        <button
          data-testid="send-btn"
          className="bg-blue-600 text-white rounded-lg px-4 py-2 text-sm disabled:opacity-50"
          onClick={send}
          disabled={isStreaming}
        >
          Send
        </button>
      </div>
      <div data-testid="status" className="text-xs text-gray-400 mt-2">
        {isStreaming ? "streaming…" : "idle"}
      </div>
    </div>
  );
}

export default function App() {
  const agent = useAgent({
    baseUrl: "http://127.0.0.1:3100",
    agentId: "spike",
    tools,
    tokenProvider: async () => TOKEN,
    sendFullHistory: true, // spike server is stateless (no Mastra Memory)
    debug: true,
  });
  return (
    <AgentProvider value={agent}>
      <ChatUI />
    </AgentProvider>
  );
}
