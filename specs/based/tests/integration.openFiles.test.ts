// Traces: BASED-SQL-OPEN-TARGET (canonical spec: specs/based/spec.md)
// The core relay half of current-window file opens: the shell POSTs {sid, paths}, and the batch
// reaches that window as an `open-files` SSE event — live when the stream is attached, or buffered
// and flushed exactly once when it attaches (a restored window's page may not have booted when the
// shell dispatches). The shell's batching/dispatch half is manual (see the spec procedure).
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startServer } from "@based/core";

const TOKEN = "spec-token";
const server = startServer({ token: TOKEN, dbPath: join(mkdtempSync(join(tmpdir(), "based-spec-open-")), "app.db") });
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

/** Attach an SSE reader for a sid and collect parsed events until `until` matches or timeout. */
async function readEvents(
  sid: string,
  opts: { until?: (e: Record<string, unknown>) => boolean; timeoutMs?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(`${base}/api/events?token=${TOKEN}&sid=${sid}`);
  expect(res.status).toBe(200);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<Record<string, unknown>> = [];
  const deadline = Date.now() + (opts.timeoutMs ?? 2000);
  let buffer = "";
  try {
    while (Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), Math.max(1, deadline - Date.now()))),
      ]);
      if (chunk === null || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = frame
          .split("\n")
          .filter((l) => l.startsWith("data: "))
          .map((l) => l.slice(6))
          .join("");
        if (data) events.push(JSON.parse(data) as Record<string, unknown>);
      }
      if (opts.until && events.some(opts.until)) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return events;
}

const isOpen = (e: Record<string, unknown>) => e.type === "open-files";

describe("BASED-SQL-OPEN-TARGET: /api/open-files relay", () => {
  test("empty or missing paths is a 400", async () => {
    for (const body of [{}, { sid: "w1", paths: [] }, { sid: "w1", paths: [42] }]) {
      const res = await api("/api/open-files", { method: "POST", body: JSON.stringify(body) });
      expect(res.status).toBe(400);
    }
  });

  test("an attached stream gets the event live; another sid's stream sees nothing", async () => {
    const sidA = "open-live-a";
    const sidB = "open-live-b";
    const [eventsA, eventsB] = await Promise.all([
      readEvents(sidA, { until: isOpen }),
      readEvents(sidB, { timeoutMs: 1200 }),
      (async () => {
        await new Promise((r) => setTimeout(r, 150)); // let both streams attach
        const res = await api("/api/open-files", {
          method: "POST",
          body: JSON.stringify({ sid: sidA, paths: ["C:/x/a.sql", "C:/x/b.sql"] }),
        });
        expect(res.status).toBe(200);
        expect(((await res.json()) as { delivered: boolean }).delivered).toBe(true);
      })(),
    ]);
    const open = eventsA.find(isOpen);
    expect(open?.paths).toEqual(["C:/x/a.sql", "C:/x/b.sql"]);
    expect(eventsB.some(isOpen)).toBe(false);
  });

  test("with no stream attached the batch buffers, flushes once on attach, and only once", async () => {
    const sid = "open-buffered";
    const first = await api("/api/open-files", { method: "POST", body: JSON.stringify({ sid, paths: ["C:/x/c.sql"] }) });
    expect(((await first.json()) as { delivered: boolean }).delivered).toBe(false);
    // A second POST before attach merges (deduped) into the same buffer.
    await api("/api/open-files", { method: "POST", body: JSON.stringify({ sid, paths: ["C:/x/c.sql", "C:/x/d.sql"] }) });

    const attached = await readEvents(sid, { until: isOpen });
    expect(attached.find(isOpen)?.paths).toEqual(["C:/x/c.sql", "C:/x/d.sql"]);

    // A re-attach gets nothing — the buffer was consumed.
    const again = await readEvents(sid, { timeoutMs: 800 });
    expect(again.some(isOpen)).toBe(false);
  });
});
