// Traces: BASED-SETTINGS (canonical spec: specs/based/spec.md)
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { startServer, SettingsStore, DEFAULT_SETTINGS, openDb } from "@based/core";

const TOKEN = "spec-token";
const dbPath = join(mkdtempSync(join(tmpdir(), "based-spec-settings-")), "app.db");
const server = startServer({ token: TOKEN, dbPath });
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

describe("BASED-SETTINGS: app settings persistence", () => {
  test("fresh store returns defaults over the API", async () => {
    const s = (await (await api("/api/settings")).json()) as { theme: string; rowPageSize: number };
    expect(s.theme).toBe("ledger");
    expect(s.rowPageSize).toBe(500);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  test("POST persists a theme and a later GET (reopened store) still returns it", async () => {
    const saved = (await (await api("/api/settings", { method: "POST", body: JSON.stringify({ theme: "chillwave" }) })).json()) as {
      theme: string;
    };
    expect(saved.theme).toBe("chillwave");

    const again = (await (await api("/api/settings")).json()) as { theme: string };
    expect(again.theme).toBe("chillwave");

    // Reopen the underlying db independently — the row is durable, not just in-memory.
    const db = openDb(dbPath);
    expect(new SettingsStore(db).get().theme).toBe("chillwave");
    db.close();
  });

  test("POST persists rowPageSize independently of theme", async () => {
    const saved = (await (await api("/api/settings", { method: "POST", body: JSON.stringify({ rowPageSize: 1000 }) })).json()) as {
      theme: string;
      rowPageSize: number;
    };
    expect(saved.rowPageSize).toBe(1000);
    expect(saved.theme).toBe("chillwave"); // set by the previous test — untouched by this patch

    const db = openDb(dbPath);
    expect(new SettingsStore(db).get().rowPageSize).toBe(1000);
    db.close();
  });

  // Traces: BASED-EXPLORER-ACTION — the double-click action keys ride the same merge-over-defaults row.
  test("explorer double-click actions default to details and round-trip", async () => {
    const fresh = (await (await api("/api/settings")).json()) as {
      explorerTableAction: string;
      explorerRoutineAction: string;
    };
    expect(fresh.explorerTableAction).toBe("details");
    expect(fresh.explorerRoutineAction).toBe("details");

    const saved = (await (
      await api("/api/settings", { method: "POST", body: JSON.stringify({ explorerTableAction: "data", explorerRoutineAction: "script-create" }) })
    ).json()) as { explorerTableAction: string; explorerRoutineAction: string; rowPageSize: number };
    expect(saved.explorerTableAction).toBe("data");
    expect(saved.explorerRoutineAction).toBe("script-create");
    expect(saved.rowPageSize).toBe(1000); // prior test's value — untouched by this patch

    const db = openDb(dbPath);
    expect(new SettingsStore(db).get().explorerTableAction).toBe("data");
    db.close();
  });

  // Traces: BASED-EDITOR-VIM — the keymap choice is a settings key like any other; the modal editing
  // it switches on is verified manually (manual.ui.test.ts).
  test("editor keymap defaults to default and round-trips", async () => {
    const fresh = (await (await api("/api/settings")).json()) as { editorKeymap: string };
    expect(fresh.editorKeymap).toBe("default");

    const saved = (await (
      await api("/api/settings", { method: "POST", body: JSON.stringify({ editorKeymap: "vim" }) })
    ).json()) as { editorKeymap: string; explorerTableAction: string };
    expect(saved.editorKeymap).toBe("vim");
    expect(saved.explorerTableAction).toBe("data"); // prior test's value — untouched by this patch

    const db = openDb(dbPath);
    expect(new SettingsStore(db).get().editorKeymap).toBe("vim");
    db.close();
  });

  // Traces: BASED-SQL-OPEN-TARGET — the file-open target rides the same merge-over-defaults row;
  // the shell reads it fresh per batch, so this round-trip is the whole settings half.
  test("sqlFileOpenTarget defaults to current-window and round-trips", async () => {
    const fresh = (await (await api("/api/settings")).json()) as { sqlFileOpenTarget: string };
    expect(fresh.sqlFileOpenTarget).toBe("current-window");

    const saved = (await (
      await api("/api/settings", { method: "POST", body: JSON.stringify({ sqlFileOpenTarget: "new-window" }) })
    ).json()) as { sqlFileOpenTarget: string; editorKeymap: string };
    expect(saved.sqlFileOpenTarget).toBe("new-window");
    expect(saved.editorKeymap).toBe("vim"); // prior test's value — untouched by this patch

    const db = openDb(dbPath);
    expect(new SettingsStore(db).get().sqlFileOpenTarget).toBe("new-window");
    db.close();
  });

  test("a partial patch merges over existing settings", () => {
    const db = openDb(dbPath);
    const store = new SettingsStore(db);
    store.save({ theme: "porcelain" });
    // Saving an unrelated (future) key must not drop the theme.
    const merged = store.save({ ...({} as Record<string, never>) });
    expect(merged.theme).toBe("porcelain");
    db.close();
  });
});
