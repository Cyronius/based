// Traces: BASED-SAVE-FILE-WRITER, BASED-AGENT-SAVE-FILE — the filename whitelist and the
// non-clobbering writer, in isolation (no tool, no adapter, no dialogs). The tool path that uses
// them is covered in integration.saveFile.
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_SAVE_FILE_BYTES, SAVE_FILE_EXTENSIONS, sanitizeSaveFileName, writeTextFileUnique } from "@based/core";

const dir = mkdtempSync(join(tmpdir(), "based-savefile-"));

describe("BASED-SAVE-FILE-WRITER: sanitizeSaveFileName", () => {
  test("rejects directories, traversal, and empty names", () => {
    expect(() => sanitizeSaveFileName("a/b.txt")).toThrow();
    expect(() => sanitizeSaveFileName("a\\b.txt")).toThrow();
    expect(() => sanitizeSaveFileName("../b.txt")).toThrow();
    expect(() => sanitizeSaveFileName("..secret.txt")).toThrow();
    expect(() => sanitizeSaveFileName("   ")).toThrow();
    expect(() => sanitizeSaveFileName("")).toThrow();
  });

  test("refuses every extension outside the whitelist — executables above all", () => {
    // Whitelist, not blacklist: the failure mode is the agent dropping something runnable into the
    // user's Downloads folder, so an unlisted extension is refused even if it looks harmless.
    for (const bad of ["evil.exe", "run.ps1", "go.bat", "go.cmd", "x.js", "x.vbs", "s.lnk", "k.reg", "a.msi", "z.dll"]) {
      expect(() => sanitizeSaveFileName(bad)).toThrow();
    }
    expect(() => sanitizeSaveFileName("noextension")).toThrow();
    expect(() => sanitizeSaveFileName("archive.tar.gz")).toThrow(); // only the last segment counts
  });

  test("accepts the document formats and preserves the name's case", () => {
    expect(sanitizeSaveFileName("report.html")).toBe("report.html");
    expect(sanitizeSaveFileName("  Notes.MD  ")).toBe("Notes.MD");
    expect(sanitizeSaveFileName("Query.SQL")).toBe("Query.SQL");
    for (const ext of SAVE_FILE_EXTENSIONS) {
      expect(sanitizeSaveFileName(`f.${ext}`)).toBe(`f.${ext}`);
    }
  });

  test("defaultExt fills in a missing extension but never overrides a valid one", () => {
    expect(sanitizeSaveFileName("notes", "md")).toBe("notes.md");
    expect(sanitizeSaveFileName("notes.txt", "md")).toBe("notes.txt");
    // An unlisted extension is still a rejection, not a silent rename.
    expect(() => sanitizeSaveFileName("notes.exe", "md")).toThrow();
  });

  test("the size cap is a real number the tool can enforce", () => {
    expect(MAX_SAVE_FILE_BYTES).toBeGreaterThan(0);
  });
});

describe("BASED-SAVE-FILE-WRITER: writeTextFileUnique", () => {
  test("never clobbers — a repeat name gets a -2, -3 suffix and the real path comes back", async () => {
    // export_data can overwrite safely because its default names are timestamped; here the MODEL
    // picks the name, so "report.html" is a plausible collision with a file the user already had.
    const first = await writeTextFileUnique(dir, "report.html", "<h1>one</h1>");
    const second = await writeTextFileUnique(dir, "report.html", "<h1>two</h1>");
    const third = await writeTextFileUnique(dir, "report.html", "<h1>three</h1>");

    expect(first.path).toBe(join(dir, "report.html"));
    expect(second.path).toBe(join(dir, "report-2.html"));
    expect(third.path).toBe(join(dir, "report-3.html"));
    expect(readFileSync(first.path, "utf8")).toBe("<h1>one</h1>");
    expect(readFileSync(second.path, "utf8")).toBe("<h1>two</h1>");
  });

  test("reports the byte length actually written, not the character count", async () => {
    const { path, bytes } = await writeTextFileUnique(dir, "utf8.txt", "café — ok");
    expect(existsSync(path)).toBe(true);
    expect(bytes).toBe(Buffer.byteLength("café — ok", "utf8"));
    expect(bytes).toBeGreaterThan("café — ok".length);
  });
});
