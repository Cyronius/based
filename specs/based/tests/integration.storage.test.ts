// Traces: BASED-CONN-STORE, BASED-TABSTORE
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { openDb, ConnectionStore, TabStore, WindowStateStore, HistoryStore, settingStr } from "@based/core";
import type { ConnectionInput } from "@based/core";

function tempDbPath(): string {
  return join(mkdtempSync(join(tmpdir(), "based-spec-")), "app.db");
}

// Traces: BASED-CONN-SETTINGS-BAG — written in the LEGACY flat shape on purpose: engine-specific
// fields used to be top-level, and every connection saved before the bag existed still looks like
// this on disk. The store must lift them on read without the caller doing anything.
const input = {
  name: "dev",
  server: "example.database.windows.net",
  database: "mydb",
  authType: "azure-cli",
  encrypt: true,
  trustServerCertificate: false,
  secret: "super-secret-should-not-persist",
} as unknown as ConnectionInput;

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
    // The legacy top-level field is now addressed through the bag…
    expect(listed.settings.server).toBe("example.database.windows.net");
    expect(settingStr(listed, "server")).toBe("example.database.windows.net");
    expect(settingStr(listed, "encrypt")).toBeUndefined(); // booleans aren't strings
    expect(listed.settings.encrypt).toBe(true);
    // …and no longer duplicated at the top level, so there is one place to read it from.
    expect((listed as unknown as Record<string, unknown>).server).toBeUndefined();
    // Cross-engine fields stay where they were.
    expect(listed.database).toBe("mydb");
    expect(listed.authType).toBe("azure-cli");

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

// Traces: BASED-LANCE-CONN-DEFAULT-PROFILES — the search profiles a LanceDB connection defaults to
// live on the connection itself (not app-global), so two datasets built by different embedding
// pipelines can never borrow each other's model.
describe("BASED-LANCE-CONN-DEFAULT-PROFILES: per-connection default search profiles", () => {
  const lanceInput: ConnectionInput = {
    name: "vectors",
    server: "",
    database: "lancedb",
    engine: "lancedb",
    authType: "lancedb-local",
    uri: "C:\\data\\my-lancedb",
    encrypt: false,
    trustServerCertificate: false,
  };

  test("the two profile ids persist, round-trip, and clear back to null", () => {
    const path = tempDbPath();
    let db = openDb(path);
    let store = new ConnectionStore(db);

    const saved = store.save({ ...lanceInput, defaultEmbeddingProfileId: "emb-1", defaultRerankerProfileId: "rrk-1" });

    db.close();
    db = openDb(path);
    store = new ConnectionStore(db);

    const reloaded = store.get(saved.id)!;
    expect(reloaded.defaultEmbeddingProfileId).toBe("emb-1");
    expect(reloaded.defaultRerankerProfileId).toBe("rrk-1");

    // "None" in the dialog → explicit null, not a stale id
    const cleared = store.save({ ...lanceInput, id: saved.id, defaultEmbeddingProfileId: null, defaultRerankerProfileId: null });
    expect(cleared.defaultEmbeddingProfileId).toBeNull();
    expect(store.get(saved.id)!.defaultRerankerProfileId).toBeNull();

    // A connection saved without the fields (every pre-existing config) reads back undefined, not a throw.
    const legacy = store.save(input);
    expect(store.get(legacy.id)!.defaultEmbeddingProfileId ?? null).toBeNull();
    db.close();
  });

  test("clearSearchProfileRefs sweeps a deleted profile off every connection that named it", () => {
    const db = openDb(tempDbPath());
    const store = new ConnectionStore(db);

    const a = store.save({ ...lanceInput, name: "a", defaultEmbeddingProfileId: "emb-1", defaultRerankerProfileId: "rrk-1" });
    const b = store.save({ ...lanceInput, name: "b", defaultEmbeddingProfileId: "emb-1" });
    const c = store.save({ ...lanceInput, name: "c", defaultEmbeddingProfileId: "emb-2", defaultRerankerProfileId: "rrk-1" });

    store.clearSearchProfileRefs("emb-1");

    expect(store.get(a.id)!.defaultEmbeddingProfileId).toBeNull();
    expect(store.get(b.id)!.defaultEmbeddingProfileId).toBeNull();
    // untouched: a different embedding profile, and every reranker reference
    expect(store.get(c.id)!.defaultEmbeddingProfileId).toBe("emb-2");
    expect(store.get(a.id)!.defaultRerankerProfileId).toBe("rrk-1");
    expect(store.get(c.id)!.defaultRerankerProfileId).toBe("rrk-1");

    // the same sweep covers reranker references (ids are unique across both stores)
    store.clearSearchProfileRefs("rrk-1");
    expect(store.get(a.id)!.defaultRerankerProfileId).toBeNull();
    expect(store.get(c.id)!.defaultRerankerProfileId).toBeNull();

    // updatedAt-only churn on unrelated rows is fine, but the sweep must not invent connections
    expect(store.list().length).toBe(3);
    db.close();
  });
});

describe("BASED-TABSTORE: tab persistence", () => {
  test("upsert, ordering, per-connection scoping, survives reopen, delete", () => {
    const path = tempDbPath();
    let db = openDb(path);
    let tabs = new TabStore(db);

    tabs.upsert({ id: "t1", connectionId: "c1", title: "Query 1", content: "SELECT 1", filePath: null, position: 0, kind: "query", meta: null });
    tabs.upsert({
      id: "t2",
      connectionId: "c1",
      title: "Query 2",
      content: "SELECT 2",
      filePath: "c:\\x\\a.sql",
      position: 1,
      kind: "query",
      meta: null,
    });
    tabs.upsert({ id: "t3", connectionId: "c2", title: "Other", content: "SELECT 3", filePath: null, position: 0, kind: "query", meta: null });

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

  test("table and routine tabs round-trip their kind and meta", () => {
    const path = tempDbPath();
    let db = openDb(path);
    let tabs = new TabStore(db);

    tabs.upsert({
      id: "tbl1",
      connectionId: "c1",
      title: "dbo.Orders",
      content: "",
      filePath: null,
      position: 0,
      kind: "table",
      meta: { schema: "dbo", table: "Orders", objectType: "table", view: "data" },
    });
    tabs.upsert({
      id: "rt1",
      connectionId: "c1",
      title: "dbo.GetOrders",
      content: "",
      filePath: null,
      position: 1,
      kind: "routine",
      meta: { schema: "dbo", name: "GetOrders", routineType: "procedure" },
    });

    db.close();
    db = openDb(path);
    tabs = new TabStore(db);

    const list = tabs.list("c1");
    const tbl = list.find((t) => t.id === "tbl1")!;
    const rt = list.find((t) => t.id === "rt1")!;
    expect(tbl.kind).toBe("table");
    expect(tbl.meta).toEqual({ schema: "dbo", table: "Orders", objectType: "table", view: "data" });
    expect(rt.kind).toBe("routine");
    expect(rt.meta).toEqual({ schema: "dbo", name: "GetOrders", routineType: "procedure" });
    db.close();
  });

  test("replaceForConnection mirrors the open set: prunes absent tabs of any kind, keeps order, scopes per connection, clears on empty, survives reopen", () => {
    const path = tempDbPath();
    let db = openDb(path);
    let tabs = new TabStore(db);

    const q1 = { id: "q1", connectionId: "c1", title: "Query 1", content: "SELECT 1", filePath: null, position: 0, kind: "query" as const, meta: null };
    const tbl = { id: "tbl1", connectionId: "c1", title: "dbo.Orders", content: "", filePath: null, position: 1, kind: "table" as const, meta: { schema: "dbo", table: "Orders", objectType: "table", view: "data" } };
    const rt = { id: "rt1", connectionId: "c1", title: "dbo.GetOrders", content: "", filePath: null, position: 2, kind: "routine" as const, meta: { schema: "dbo", name: "GetOrders", routineType: "procedure" } };
    const other = { id: "o1", connectionId: "c2", title: "Other", content: "", filePath: null, position: 0, kind: "query" as const, meta: null };

    tabs.upsert(q1);
    tabs.upsert(tbl);
    tabs.upsert(rt);
    tabs.upsert(other);

    // Replace c1 with a subset that drops the table tab and reorders — table tab must be pruned
    // even though it is not a query tab (the bug: only query tabs were being deleted on close).
    tabs.replaceForConnection("c1", [
      { ...rt, position: 0 },
      { ...q1, position: 1 },
    ]);

    db.close();
    db = openDb(path);
    tabs = new TabStore(db);

    expect(tabs.list("c1").map((t) => t.id)).toEqual(["rt1", "q1"]);
    expect(tabs.list("c2").map((t) => t.id)).toEqual(["o1"]); // other connection untouched

    // Empty array clears the connection (closing every tab), leaving others intact.
    tabs.replaceForConnection("c1", []);
    expect(tabs.list("c1")).toEqual([]);
    expect(tabs.list("c2").length).toBe(1);
    db.close();
  });
});

describe("BASED-WINDOW-RESTORE: window state persistence", () => {
  test("save/get round-trip, list, delete, survives reopen", () => {
    const path = tempDbPath();
    let db = openDb(path);
    let windows = new WindowStateStore(db);

    windows.save("sid1", { connectionId: "c1", activeTabId: "t1", schemaFilter: "dbo" });
    windows.save("sid2", { connectionId: "c2" });

    db.close();
    db = openDb(path);
    windows = new WindowStateStore(db);

    expect(windows.get("sid1")).toMatchObject({ sid: "sid1", connectionId: "c1", activeTabId: "t1", schemaFilter: "dbo" });
    expect(windows.list().map((w) => w.sid).sort()).toEqual(["sid1", "sid2"]);

    // partial patch merges over the existing row
    windows.save("sid1", { activeTabId: "t2" });
    expect(windows.get("sid1")).toMatchObject({ connectionId: "c1", activeTabId: "t2", schemaFilter: "dbo" });

    windows.delete("sid2");
    expect(windows.get("sid2")).toBeNull();
    expect(windows.list().map((w) => w.sid)).toEqual(["sid1"]);
    db.close();
  });

  test("deleting a connection cascades to remove its window_state rows", () => {
    const db = openDb(tempDbPath());
    const windows = new WindowStateStore(db);
    windows.save("sidA", { connectionId: "c1" });
    windows.save("sidB", { connectionId: "c1" });
    windows.save("sidC", { connectionId: "c2" });

    windows.deleteByConnection("c1");

    expect(windows.list().map((w) => w.sid)).toEqual(["sidC"]);
    db.close();
  });

  test("the shared 'default' sid is never persisted or offered back for restore", () => {
    const db = openDb(tempDbPath());
    const windows = new WindowStateStore(db);

    windows.save("default", { connectionId: "unrelated-connection" });
    expect(windows.list()).toEqual([]);

    // even a pre-existing stray row (e.g. from before this fix) must not surface
    db.run(
      "INSERT INTO window_state (sid, connection_id, active_tab_id, schema_filter, updated_at) VALUES ('default', 'unrelated-connection', null, '', '2026-01-01T00:00:00Z')",
    );
    windows.save("sidD", { connectionId: "c3" });

    expect(windows.list().map((w) => w.sid)).toEqual(["sidD"]);
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
