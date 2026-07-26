// Traces: BASED-AGENT-SAVE-FILE, BASED-AGENT-TRANSCRIPT
// The agent tools end to end: real surface, real tool schemas, real files on disk — into an
// injected scratch dir so a test run never touches the user's Downloads. No database is needed
// (neither tool reads the adapter), so unlike the other integration suites this one never skips.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentSurfaceFor, AuditStore, MAX_SAVE_FILE_BYTES, openDb, type ToolDeps } from "@based/core";
import type { EngineCapabilities } from "@based/core";
import type { Message } from "@ag-ui/core";

const MSSQL: EngineCapabilities = {
  sql: true,
  search: false,
  write: true,
  orderedBrowse: true,
  script: true,
  relations: true,
  engine: "mssql",
  variant: "mssql",
  containers: null,
  wherePredicate: false,
  structuredFilters: true,
  countRows: true,
  takeByKey: false,
  indexIntrospect: true,
};

const THREAD: Message[] = [
  { id: "1", role: "user", content: "how many orders?" },
  { id: "2", role: "assistant", content: "1,204 orders." },
] as Message[];

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "based-savetool-"));
}

function deps(dir: string, extra?: Partial<ToolDeps>): ToolDeps {
  return {
    getAdapter: () => {
      throw new Error("save_file must not touch the adapter");
    },
    connectionId: () => "c1",
    database: () => "d1",
    audit: new AuditStore(openDb(join(scratch(), "app.db"))),
    exportDir: () => dir,
    ...extra,
  };
}

function toolsFor(dir: string, extra?: Partial<ToolDeps>) {
  return agentSurfaceFor(MSSQL, deps(dir, extra)).tools;
}

describe("BASED-AGENT-SAVE-FILE: the save_file tool", () => {
  test("writes the exact content to the resolved directory and reports the path", async () => {
    const dir = scratch();
    const html = "<!doctype html><html><body><h1>Orders</h1></body></html>";
    const result = (await toolsFor(dir).save_file!.execute({ content: html, fileName: "orders.html" }, {} as never)) as {
      path: string;
      bytes: number;
      fileName: string;
    };
    expect(result.path).toBe(join(dir, "orders.html"));
    expect(result.fileName).toBe("orders.html");
    expect(result.bytes).toBe(Buffer.byteLength(html, "utf8"));
    expect(readFileSync(result.path, "utf8")).toBe(html);
  });

  test("a repeat file name lands beside the original instead of replacing it", async () => {
    const dir = scratch();
    const tools = toolsFor(dir);
    await tools.save_file!.execute({ content: "first", fileName: "notes.md" }, {} as never);
    const second = (await tools.save_file!.execute({ content: "second", fileName: "notes.md" }, {} as never)) as { path: string };
    expect(second.path).toBe(join(dir, "notes-2.md"));
    expect(readFileSync(join(dir, "notes.md"), "utf8")).toBe("first");
  });

  test("refuses a path that escapes the directory, and writes nothing", async () => {
    const dir = scratch();
    for (const fileName of ["../escape.txt", "sub/dir.txt", "..\\up.txt"]) {
      const out = (await toolsFor(dir).save_file!.execute({ content: "x", fileName }, {} as never)) as { error?: string };
      expect(out.error).toBeTruthy();
    }
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses an executable extension — the whole point of the whitelist", async () => {
    const dir = scratch();
    const out = (await toolsFor(dir).save_file!.execute({ content: "rm -rf /", fileName: "setup.ps1" }, {} as never)) as {
      error?: string;
    };
    expect(out.error).toContain("Unsupported file type");
    expect(readdirSync(dir)).toEqual([]);
  });

  test("refuses content over the size cap, and empty content", async () => {
    const dir = scratch();
    const tools = toolsFor(dir);
    const tooBig = (await tools.save_file!.execute({ content: "x".repeat(MAX_SAVE_FILE_BYTES + 1), fileName: "big.txt" }, {} as never)) as {
      error?: string;
    };
    expect(tooBig.error).toBeTruthy();
    const empty = (await tools.save_file!.execute({ content: "", fileName: "empty.txt" }, {} as never)) as { error?: string };
    expect(empty.error).toBeTruthy();
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("BASED-AGENT-TRANSCRIPT: the save_chat_transcript tool", () => {
  test("is absent unless the run's deps can read the thread", () => {
    // The subagent gate: a child run shares the thread id but gets no reader, so the tool is not on
    // its surface at all — not present-and-refusing.
    expect(toolsFor(scratch()).save_chat_transcript).toBeUndefined();
    expect(toolsFor(scratch(), { threadId: () => "t1", recallThread: async () => THREAD }).save_chat_transcript).toBeDefined();
  });

  test("writes the thread as markdown without the model retyping it", async () => {
    const dir = scratch();
    let asked: [string, string] | null = null;
    const tools = toolsFor(dir, {
      threadId: () => "tab:c1:xyz",
      recallThread: async (threadId, resourceId) => {
        asked = [threadId, resourceId];
        return THREAD;
      },
    });
    const out = (await tools.save_chat_transcript!.execute({ title: "Orders" }, {} as never)) as {
      path: string;
      messageCount: number;
      note: string;
    };
    // Recalled with the RUN's thread and the connection as the resource — the same pair the
    // history-restore route uses, so the file matches what the rail shows.
    expect(asked).toEqual(["tab:c1:xyz", "c1"]);
    expect(out.messageCount).toBe(2);
    expect(out.note).toContain("not included");
    const written = readFileSync(out.path, "utf8");
    expect(written.startsWith("# Orders\n")).toBe(true);
    expect(written).toContain("## You\n\nhow many orders?");
    expect(written).toContain("## Capi\n\n1,204 orders.");
  });

  test("defaults to a timestamped .md name and forces .md onto a bare one", async () => {
    const dir = scratch();
    const tools = toolsFor(dir, { threadId: () => "t1", recallThread: async () => THREAD });
    const auto = (await tools.save_chat_transcript!.execute({}, {} as never)) as { path: string };
    expect(auto.path).toMatch(/based-chat-\d{14}\.md$/);
    const named = (await tools.save_chat_transcript!.execute({ fileName: "orders-chat" }, {} as never)) as { path: string };
    expect(named.path).toBe(join(dir, "orders-chat.md"));
    expect(existsSync(named.path)).toBe(true);
  });

  test("a recall failure comes back as an error, not a throw", async () => {
    const dir = scratch();
    const tools = toolsFor(dir, {
      threadId: () => "t1",
      recallThread: async () => {
        throw new Error("storage is down");
      },
    });
    const out = (await tools.save_chat_transcript!.execute({}, {} as never)) as { error?: string };
    expect(out.error).toBe("storage is down");
    expect(readdirSync(dir)).toEqual([]);
  });
});
