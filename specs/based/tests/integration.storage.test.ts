// Traces: BASED-CONN-STORE, BASED-TABSTORE
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { openDb, ConnectionStore, TabStore, HistoryStore } from "@based/core";
import type { ConnectionInput } from "@based/core";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "based-spec-")), "app.db");
}

const input: ConnectionInput = {
  name: "dev",
  server: "example.database.windows.net",
  database: "mydb",
  authType: "azure-cli",
  encrypt: true,
  trustServerCertificate: false,
  secret: "super-secret-should-not-persist",
};

describe("BASED-CONN-STORE: connection metadata persistence", () => {
  test("create → list → survives reopen; update in place; delete removes; no secret material", () => {
    const path = tempDbPath();
    let db = openDb(path);
    let store = new ConnectionStore(db);

    const saved = store.save(input);
    expect(saved.id).toBeTruthy();
    expect(store.list().map((c) => c.name)).toEqual(["dev"]);

    // reopen
    db.close();
    db = openDb(path);
    store = new ConnectionStore(db);
    const listed = store.get(saved.id)!;
    expect(listed.server).toBe(input.server);

    // no secret anywhere in the stored json
    const raw = db.query<{ json: string }, []>("SELECT json FROM connections").all();
    expect(raw.some((r) => r.json.includes("super-secret"))).toBe(false);
    expect((listed as Record<string, unknown>).secret).toBeUndefined();

    // update in place
    const updated = store.save({ ...input, id: saved.id, name: "dev-renamed" });
    expect(updated.id).toBe(saved.id);
    expect(updated.createdAt).toBe(saved.createdAt);
    expect(store.list().map((c) => c.name)).toEqual(["dev-renamed"]);

    // delete
    store.delete(saved.id);
    expect(store.list()).toEqual([]);
    db.close();
  });
});

describe("BASED-TABSTORE: tab persistence", () => {
  test("upsert, ordering, per-connection scoping, survives reopen, delete", () => {
    const path = tempDbPath();
    let db = openDb(path);
    let tabs = new TabStore(db);

    tabs.upsert({ id: "t1", connectionId: "c1", title: "Query 1", content: "SELECT 1", filePath: null, position: 0 });
    tabs.upsert({ id: "t2", connectionId: "c1", title: "Query 2", content: "SELECT 2", filePath: "c:\\x\\a.sql", position: 1 });
    tabs.upsert({ id: "t3", connectionId: "c2", title: "Other", content: "SELECT 3", filePath: null, position: 0 });

    db.close();
    db = openDb(path);
    tabs = new TabStore(db);

    const c1 = tabs.list("c1");
    expect(c1.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(c1[0]!.content).toBe("SELECT 1");
    expect(c1[1]!.filePath).toBe("c:\\x\\a.sql");
    expect(tabs.list("c2").length).toBe(1);

    tabs.delete("t1");
    expect(tabs.list("c1").map((t) => t.id)).toEqual(["t2"]);
    db.close();
  });
});

describe("history store (supports BASED-HISTORY)", () => {
  test("add + list most-recent-first", () => {
    const db = openDb(tempDbPath());
    const history = new HistoryStore(db);
    history.add({ connectionId: "c1", database: "d", sql: "SELECT 1", startedAt: "2026-01-01T00:00:00Z", durationMs: 5, status: "ok", error: null });
    history.add({ connectionId: "c1", database: "d", sql: "SELEC 1", startedAt: "2026-01-01T00:01:00Z", durationMs: 2, status: "error", error: "syntax" });
    const list = history.list("c1");
    expect(list.map((h) => h.sql)).toEqual(["SELEC 1", "SELECT 1"]);
    expect(list[0]!.status).toBe("error");
    db.close();
  });
});
