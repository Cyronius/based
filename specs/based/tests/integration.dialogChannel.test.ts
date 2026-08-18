// Traces: BASED-DIALOG-CHANNEL, BASED-DIALOG-OPEN-FILE, BASED-FILE-OPEN-SQL (dialog half),
//         BASED-LANCE-FOLDER-BROWSE (dialog half)
//
// Exercises both ends of the loopback dialog channel with a fake shell: this file plays the part
// tauri-plugin-dialog plays in the real app, so everything except the picker widget itself is
// covered here rather than by hand. What is NOT covered, and stays manual, is whether the native
// picker actually appears — that is BASED-PACKAGE-{WIN,MAC,LINUX}'s on-hardware checklist.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync } from "node:fs";
import { startServer } from "@based/core";

const TOKEN = "spec-dialog-token";
const scratch = mkdtempSync(join(tmpdir(), "based-spec-dialog-"));
const server = startServer({ token: TOKEN, dbPath: join(scratch, "app.db") });
const base = server.url;

afterAll(async () => {
  await server.stop();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

interface DialogRequest {
  id: string;
  kind: string;
  filters?: Array<{ name: string; extensions: string[] }>;
  defaultName?: string;
  startingFolder?: string;
  path?: string;
}

/** The shell half: take the next request off the channel. */
async function takeRequest(): Promise<DialogRequest> {
  const r = await api("/api/shell/dialog/next");
  expect(r.status).toBe(200);
  return (await r.json()) as DialogRequest;
}

/** The shell half: answer one. `null` is a cancel. */
function answer(id: string, path: string | null): Promise<Response> {
  return api("/api/shell/dialog/result", { method: "POST", body: JSON.stringify({ id, path }) });
}

describe("BASED-DIALOG-CHANNEL: native dialogs are drawn by the shell", () => {
  // MUST be the first test in this file. The broker counts a shell as attached for 60 s after any
  // poll, so every later test leaves one attached and this assertion could never be made again.
  // Bun runs tests within a file in declaration order.
  test("with no shell attached, a dialog request fails with a named error rather than hanging", async () => {
    const r = await api("/api/dialog/open-file", { method: "POST", body: JSON.stringify({ kind: "csv" }) });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { error: string };
    expect(body.error).toMatch(/no based shell is attached/i);
    // The message has to point at the way out, because this is what a `dev:core` + browser session
    // hits and the endpoints all accept an explicit path.
    expect(body.error).toMatch(/explicit path/i);
  });

  test("an idle poll answers 204, and marks the shell attached", async () => {
    const r = await api("/api/shell/dialog/next?holdMs=50");
    expect(r.status).toBe(204);
  });

  // From here on a shell is attached, so request and poll can be issued in either order: a request
  // raised first waits in the queue, and one raised second goes straight to the parked poll.
  test("open-file carries the per-kind filters and returns the chosen path", async () => {
    const dialog = api("/api/dialog/open-file", { method: "POST", body: JSON.stringify({ kind: "csv" }) });
    const request = await takeRequest();
    expect(request.kind).toBe("open-file");
    expect(request.filters).toEqual([
      { name: "CSV files", extensions: ["csv"] },
      { name: "All files", extensions: ["*"] },
    ]);

    await answer(request.id, "/tmp/imported.csv");
    expect(await (await dialog).json()).toEqual({ path: "/tmp/imported.csv" });
  });

  test("a cancel comes back as path null, not as an error", async () => {
    const dialog = api("/api/dialog/open-file", { method: "POST", body: JSON.stringify({ kind: "sql" }) });
    const request = await takeRequest();
    expect(request.filters?.[0]).toEqual({ name: "SQL files", extensions: ["sql"] });

    await answer(request.id, null);
    expect(await (await dialog).json()).toEqual({ path: null });
  });

  test("the folder picker forwards the starting folder", async () => {
    const dialog = api("/api/dialog/folder", {
      method: "POST",
      body: JSON.stringify({ startingFolder: "/data/lance" }),
    });
    const request = await takeRequest();
    expect(request.kind).toBe("open-folder");
    expect(request.startingFolder).toBe("/data/lance");

    await answer(request.id, "/data/lance/vectors");
    expect(await (await dialog).json()).toEqual({ path: "/data/lance/vectors" });
  });

  // Traces: BASED-FILE-OPEN-SQL — the save half: the picker supplies the path, then core writes.
  test("save-sql asks for a save dialog with its default name, then writes to the chosen path", async () => {
    const target = join(scratch, "chosen.sql");
    const dialog = api("/api/file/save-sql", {
      method: "POST",
      body: JSON.stringify({ content: "select 1;", defaultName: "query.sql" }),
    });
    const request = await takeRequest();
    expect(request.kind).toBe("save-file");
    expect(request.defaultName).toBe("query.sql");

    await answer(request.id, target);
    expect(await (await dialog).json()).toEqual({ path: target });
    expect(readFileSync(target, "utf8")).toBe("select 1;");
  });

  test("a cancelled save writes nothing", async () => {
    const dialog = api("/api/file/save-sql", {
      method: "POST",
      body: JSON.stringify({ content: "select 2;", defaultName: "unwritten.sql" }),
    });
    const request = await takeRequest();
    await answer(request.id, null);
    expect(await (await dialog).json()).toEqual({ path: null });
  });

  // openWithDefaultApp is the one kind with no waiting caller — the agent's export tools call it
  // after a successful write and must not fail because the handoff did. So it is dispatched and
  // forgotten, and the shell posts no result.
  test("export with openAfter hands the written file to the shell as a fire-and-forget open-path", async () => {
    const exported = api("/api/export", {
      method: "POST",
      body: JSON.stringify({
        format: "csv",
        columns: [{ name: "id", type: "int" }],
        rows: [[1]],
        openAfter: true,
      }),
    });
    const request = await takeRequest();
    expect(request.kind).toBe("open-path");
    expect(request.path).toMatch(/based-results-\d+\.csv$/);

    // The export answered on its own; nothing was posted back for this request.
    const { path: written } = (await (await exported).json()) as { path: string };
    expect(request.path).toBe(written);
    expect(readFileSync(written, "utf8")).toContain("id");
  });

  // Regression: the route read `holdMs` unconditionally, and `Number(null)` is 0 — so a poll that
  // omits it (which is every poll the real shell makes) became a 0 ms hold. That is both a spin
  // loop and a correctness bug: a request raised a tick later missed the poll entirely.
  test("a poll that omits holdMs holds open, rather than answering 204 immediately", async () => {
    const poll = api("/api/shell/dialog/next");
    await Bun.sleep(150); // long enough that a 0 ms hold would have answered 204 by now
    const dialog = api("/api/dialog/open-file", { method: "POST", body: JSON.stringify({ kind: "sql" }) });

    const r = await poll;
    expect(r.status).toBe(200);
    const request = (await r.json()) as DialogRequest;
    await answer(request.id, "/tmp/late.sql");
    expect(await (await dialog).json()).toEqual({ path: "/tmp/late.sql" });
  });

  test("a result for an unknown or already-answered id is ignored, not an error", async () => {
    expect((await answer("no-such-request-id", "/tmp/whatever.csv")).status).toBe(200);

    const dialog = api("/api/dialog/open-file", { method: "POST", body: JSON.stringify({ kind: "xlsx" }) });
    const request = await takeRequest();
    await answer(request.id, "/tmp/first.xlsx");
    expect(await (await dialog).json()).toEqual({ path: "/tmp/first.xlsx" });
    // A duplicate answer (shell retried, or two shells raced) must not throw or clobber anything.
    expect((await answer(request.id, "/tmp/second.xlsx")).status).toBe(200);
  });

  test("a result with no id is refused", async () => {
    const r = await api("/api/shell/dialog/result", { method: "POST", body: JSON.stringify({ path: "/tmp/x" }) });
    expect(r.status).toBe(400);
  });

  test("the channel is behind the same token auth as everything else", async () => {
    expect((await fetch(`${base}/api/shell/dialog/next`)).status).toBe(401);
    expect(
      (
        await fetch(`${base}/api/shell/dialog/result`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id: "x", path: null }),
        })
      ).status,
    ).toBe(401);
  });
});
