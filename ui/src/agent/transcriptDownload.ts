// Traces: BASED-CHAT-TRANSCRIPT-UI
// Save the rail's conversation to a file the user picks. The messages travel to the server and the
// server renders them (core's transcriptMarkdown) rather than the UI formatting a string here —
// that keeps ONE transcript format shared with the save_chat_transcript agent tool, so the file you
// get from the button and the file you get by asking Capi are the same document.
//
// The client sends what it is *rendering*, which is a beat ahead of agent.db: the assistant's
// just-finished reply is in `agent.messages` before Mastra has flushed the turn to memory. That's
// the one thing this path has that the agent-side tool structurally cannot.
import type { Message } from "@ag-ui/client";
import { api } from "../api/client";

function stamp(): string {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

/** Pops the native Save As dialog. Resolves to the written path, or null if the user cancelled. */
export async function downloadTranscript(messages: Message[], title?: string): Promise<string | null> {
  const res = await api<{ path: string | null }>("/api/file/save-transcript", {
    method: "POST",
    body: JSON.stringify({
      messages,
      title: title?.trim() || undefined,
      defaultName: `based-chat-${stamp()}.md`,
    }),
  });
  return res.path;
}
