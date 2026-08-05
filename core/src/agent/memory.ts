// Traces: BASED-AGENT-THREADS
// Mastra agent memory backed by LibSQL, in its own agent.db (kept separate from the bun:sqlite
// app.db so the two SQLite clients never share a file). Threads are keyed per connection via the
// resourceId passed at run time.
import { join } from "node:path";
import { Memory } from "@mastra/memory";
import { LibSQLStore } from "@mastra/libsql";
import { dataDir } from "../storage/db";

/** Turns of history replayed into each request. Traces: BASED-AGENT-CONTEXT-RECOVERY — an unbounded
 *  recall means one oversized tool result is re-sent forever, so a thread that overflowed the
 *  context window once can never recover on its own. 40 messages is far more than any real chat
 *  needs and still a hard ceiling on how far back a bad payload can reach. */
export const MEMORY_LAST_MESSAGES = 40;

export function createAgentMemory(dbPath?: string): Memory {
  const url = dbPath ? `file:${dbPath}` : `file:${join(dataDir(), "agent.db")}`;
  // `as any`: @mastra/libsql and @mastra/memory each resolve their own @mastra/core copy, so the
  // structurally-identical store types are nominally unrelated. Runtime-compatible (spike-proven).
  const storage = new LibSQLStore({ id: "based-agent", url }) as unknown;
  return new Memory({ storage: storage as never, options: { lastMessages: MEMORY_LAST_MESSAGES } });
}
