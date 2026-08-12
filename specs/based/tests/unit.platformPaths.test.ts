// Traces: BASED-PLATFORM-PATHS
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, existsSync } from "node:fs";
import { appDataRoot, dataDir } from "@based/core";

/** Compare by path segments so these assertions hold on any build host, not just the one
 *  whose separator matches the platform under test. */
function seg(p: string): string[] {
  return p.split(/[\\/]/).filter(Boolean);
}

describe("BASED-PLATFORM-PATHS: per-platform app-data root", () => {
  test("darwin resolves under ~/Library/Application Support", () => {
    expect(seg(appDataRoot("darwin", { HOME: "/Users/ada" }))).toEqual([
      "Users",
      "ada",
      "Library",
      "Application Support",
    ]);
  });

  test("win32 uses %APPDATA% verbatim", () => {
    const appdata = "C:\\Users\\ada\\AppData\\Roaming";
    expect(appDataRoot("win32", { APPDATA: appdata })).toBe(appdata);
  });

  test("win32 with no APPDATA falls back to the cwd, not to a darwin path", () => {
    expect(appDataRoot("win32", {})).toBe(".");
  });

  test("darwin with no HOME still yields a Library/Application Support tail", () => {
    // homedir() backstops a missing HOME; only the tail is platform-asserted here.
    expect(seg(appDataRoot("darwin", {})).slice(-2)).toEqual(["Library", "Application Support"]);
  });

  test("BASED_DATA_DIR overrides the platform default and is created on demand", () => {
    const override = join(mkdtempSync(join(tmpdir(), "based-datadir-")), "nested");
    const prev = process.env.BASED_DATA_DIR;
    process.env.BASED_DATA_DIR = override;
    try {
      expect(dataDir()).toBe(override);
      expect(existsSync(override)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.BASED_DATA_DIR;
      else process.env.BASED_DATA_DIR = prev;
    }
  });
});
