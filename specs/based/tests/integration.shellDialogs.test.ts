// Traces: BASED-DIALOG-OPEN-FILE (canonical spec: specs/based/spec.md)
// The shell-dialog relay end-to-end against a real server: a fake shell subscribes to
// /api/shell/dialogs, dialog endpoints publish requests onto that stream, and the answer POSTed to
// /api/shell/dialog-result resolves the original endpoint call. Also the detach contract: a
// vanished shell resolves in-flight dialogs as cancelled instead of hanging them forever.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "@based/core";

const appDir = mkdtempSync(join(tmpdir(), "based-shelldialog-"));
const TOKEN = "shell-dialog-spec-token";
const server = startServer({ token: TOKEN, dbPath: join(appDir, "app.db"), agentDbPath: join(appDir, "agent.db") });
const base = server.url;
const auth = { authorization: `Bearer ${TOKEN}` };

afterAll(async () => {
  await server.stop();
});

interface DialogRequest {
  id: string;
  kind: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  defaultName?: string;
  startingFolder?: string;
}

/** A fake Tauri shell: one subscription to the dialog stream, parsed into request objects. */
async function attachFakeShell(): Promise<{
  next: () => Promise<DialogRequest>;
  detach: () => void;
}> {
  const abort = new AbortController();
  const res = await fetch(`${base}/api/shell/dialogs`, { headers: auth, signal: abort.signal });
  expect(res.ok).toBe(true);
  expect(res.headers.get("content-type")).toBe("text/event-stream");
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  return {
    async next() {
      for (;;) {
        const dataEnd = buffer.indexOf("\n\n");
        if (dataEnd >= 0) {
          const frame = buffer.slice(0, dataEnd);
          buffer = buffer.slice(dataEnd + 2);
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data: "))
            .map((l) => l.slice(6))
            .join("");
          if (data) return JSON.parse(data) as DialogRequest;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) throw new Error("dialog stream ended");
        buffer += decoder.decode(value, { stream: true });
      }
    },
    detach() {
      abort.abort();
    },
  };
}

function answer(id: string, path: string | null): Promise<Response> {
  return fetch(`${base}/api/shell/dialog-result`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ id, path }),
  });
}

describe("shell dialog relay", () => {
  test("open-file request rides the stream and the shell's answer resolves the endpoint", async () => {
    const shell = await attachFakeShell();
    const call = fetch(`${base}/api/dialog/open-file`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ kind: "csv" }),
    });
    const req = await shell.next();
    expect(req.kind).toBe("open-file");
    expect(req.id).toBeTruthy();
    // The typed filter arrives structured — the shell renders it, no WinForms string on the wire.
    expect(req.filters?.[0]).toEqual({ name: "CSV files", extensions: ["csv"] });
    expect(req.filters?.at(-1)).toEqual({ name: "All files", extensions: ["*"] });

    await answer(req.id, "C:\\data\\rows.csv");
    expect(await (await call).json()).toEqual({ path: "C:\\data\\rows.csv" });
    shell.detach();
  });

  test("a null answer (user cancelled) surfaces as { path: null }", async () => {
    const shell = await attachFakeShell();
    const call = fetch(`${base}/api/dialog/folder`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ startingFolder: "C:\\seeds" }),
    });
    const req = await shell.next();
    expect(req.kind).toBe("folder");
    expect(req.startingFolder).toBe("C:\\seeds");
    await answer(req.id, null);
    expect(await (await call).json()).toEqual({ path: null });
    shell.detach();
  });

  test("save dialog carries the default file name", async () => {
    const shell = await attachFakeShell();
    const target = join(appDir, "saved.sql");
    const call = fetch(`${base}/api/file/save-sql`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ content: "select 1", defaultName: "report.sql" }),
    });
    const req = await shell.next();
    expect(req.kind).toBe("save-file");
    expect(req.defaultName).toBe("report.sql");
    await answer(req.id, target);
    expect(await (await call).json()).toEqual({ path: target });
    expect(await Bun.file(target).text()).toBe("select 1");
    shell.detach();
  });

  test("shell detach cancels an in-flight dialog instead of hanging it", async () => {
    const shell = await attachFakeShell();
    const call = fetch(`${base}/api/dialog/open-file`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ kind: "sql" }),
    });
    await shell.next(); // request is in flight at the broker
    shell.detach();
    expect(await (await call).json()).toEqual({ path: null });
  });

  test("an unknown result id is ignored, not a crash", async () => {
    const res = await answer("no-such-dialog", "C:\\x.txt");
    expect(res.ok).toBe(true);
  });
});
