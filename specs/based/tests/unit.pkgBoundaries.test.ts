// Traces: BASED-PKG-BOUNDARIES
import { describe, expect, test } from "bun:test";
import { crossesBoundary } from "../../../scripts/check-boundaries";

describe("BASED-PKG-BOUNDARIES: core and ui never import each other", () => {
  test("ui reaching into core by relative path is a violation", () => {
    expect(crossesBoundary("ui/src/api/client.ts", "../../../core/src/db/types")).toBe(true);
  });

  test("ui importing the core package is a violation", () => {
    expect(crossesBoundary("ui/src/App.tsx", "@cyronius/based-core")).toBe(true);
  });

  test("core importing ui is a violation", () => {
    expect(crossesBoundary("core/src/server.ts", "@based/ui")).toBe(true);
    expect(crossesBoundary("core/src/server.ts", "../../ui/src/api/client")).toBe(true);
  });

  test("core or ui importing the shell is a violation", () => {
    expect(crossesBoundary("core/src/server.ts", "../../shell-tauri/core-child")).toBe(true);
    expect(crossesBoundary("ui/src/App.tsx", "@based/shell-tauri")).toBe(true);
  });

  test("relative imports inside a package are fine", () => {
    expect(crossesBoundary("ui/src/App.tsx", "./components/DataGrid")).toBe(false);
    expect(crossesBoundary("core/src/server.ts", "../db/types")).toBe(false);
    expect(crossesBoundary("core/src/agent/tools/mssql.ts", "../../db/types")).toBe(false);
  });

  test("the shell may import core, that is its job", () => {
    expect(crossesBoundary("shell-tauri/core-child.ts", "@cyronius/based-core")).toBe(false);
  });

  test("third-party packages are fine", () => {
    expect(crossesBoundary("ui/src/App.tsx", "react")).toBe(false);
    expect(crossesBoundary("core/src/server.ts", "@mastra/core")).toBe(false);
    expect(crossesBoundary("core/src/storage/db.ts", "bun:sqlite")).toBe(false);
  });

  test("windows separators are normalized", () => {
    expect(crossesBoundary("ui\\src\\App.tsx", "..\\..\\core\\src\\index")).toBe(true);
  });
});
