// Traces: BASED-AGENT-TRANSCRIPT
// Render a chat thread as markdown. Lives in core rather than the UI so ONE implementation serves
// both paths that produce a transcript: the save_chat_transcript tool (messages recalled from agent
// memory via mapDbMessagesToAgui) and the chat header's download button (messages posted straight
// off the live AgentClient). Both speak the same AG-UI Message shape, which is what makes that
// sharing possible — and what stops the two exports from drifting into different-looking files.
//
// Prose only: tool calls and their results are deliberately not rendered. A transcript is what the
// conversation *said*; the mechanics of how an answer was reached are already in the audit log, and
// inlining JSON payloads makes the document unreadable for its actual purpose (sharing, pasting
// into a ticket, keeping a record).
import type { Message } from "@ag-ui/core";

const DEFAULT_TITLE = "based — chat transcript";

const HEADING: Record<string, string> = { user: "You", assistant: "Capi" };

export interface TranscriptOptions {
  /** Document heading — the originating tab's title makes a good one. */
  title?: string;
  /** ISO timestamp; injected by tests so the output is deterministic. */
  generatedAt?: string;
}

/** Format a thread's visible turns as a markdown document. Always ends in a single newline. */
export function transcriptMarkdown(messages: Message[], opts?: TranscriptOptions): string {
  const title = opts?.title?.trim() || DEFAULT_TITLE;
  const parts: string[] = [`# ${title}`, `_Generated ${opts?.generatedAt ?? new Date().toISOString()}_`];

  let lastRole: string | null = null;
  for (const m of messages ?? []) {
    const heading = HEADING[m.role];
    if (!heading) continue; // system/tool are not part of the visible conversation
    const text = typeof m.content === "string" ? m.content.trim() : "";
    // An assistant turn carrying only toolCalls has nothing to say — emitting its heading would
    // leave a run of empty "## Capi" sections between the question and the answer.
    if (!text) continue;
    if (m.role !== lastRole) {
      parts.push(`## ${heading}`);
      lastRole = m.role;
    }
    parts.push(text);
  }
  return `${parts.join("\n\n")}\n`;
}

/** Default file name for a saved transcript: `based-chat-<yyyymmddhhmmss>.md`. */
export function defaultTranscriptFileName(now = new Date()): string {
  return `based-chat-${now.toISOString().replace(/[-:T]/g, "").slice(0, 14)}.md`;
}
