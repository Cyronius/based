// TEMPORARY debug harness — deleted before commit.
import { appendFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "bun:test";
import { startServer } from "@based/core";

const LOG = "C:\\Users\\josha\\AppData\\Local\\Temp\\claude\\c--code-based\\97b50208-a954-4905-97f0-3154a50c86f0\\scratchpad\\zz-debug.log";
const mark = (m: string) => appendFileSync(LOG, `${Date.now()} ${m}\n`);

mark("module scope start");
const appDir = mkdtempSync(join(tmpdir(), "zz-dbg-"));
const TOKEN = "t";
const server = startServer({ token: TOKEN, dbPath: join(appDir, "app.db"), agentDbPath: join(appDir, "agent.db") });
mark(`server started ${server.url}`);

beforeAll(() => {
  mark("beforeAll ran");
});

describe("zz debug", () => {
  test("trivial", async () => {
    mark("test started");
    const res = await fetch(`${server.url}/api/health?token=${TOKEN}`);
    mark(`health ${res.status}`);
    expect(res.ok).toBe(true);
  });

  test("ws refused fires error", async () => {
    mark("ws test started");
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/api/lsp?sid=none&token=${TOKEN}`);
    const outcome = await new Promise<string>((resolve) => {
      ws.addEventListener("error", () => resolve("error"));
      ws.addEventListener("open", () => resolve("open"));
      setTimeout(() => resolve("timeout"), 5000);
    });
    mark(`ws outcome ${outcome}`);
    expect(outcome).toBe("error");
  });
});
