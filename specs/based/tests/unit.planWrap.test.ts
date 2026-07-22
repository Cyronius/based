// Traces: BASED-EXEC-PLAN, BASED-CLIENT-STATS
import { describe, expect, test } from "bun:test";
import { skipsWrap, wrapBatch } from "@based/core";

describe("BASED-EXEC-PLAN, BASED-CLIENT-STATS: wrapBatch", () => {
  test("neither flag set: only the defensive OFF prefix is added", () => {
    const wrapped = wrapBatch("SELECT 1", {});
    expect(wrapped).toBe("SET STATISTICS XML OFF;\nSET STATISTICS IO, TIME OFF;\nSELECT 1");
  });

  test("capturePlan: adds SET STATISTICS XML ON wrapped in TRY/CATCH with trailing OFF", () => {
    const wrapped = wrapBatch("SELECT 1", { capturePlan: true });
    expect(wrapped).toContain("SET STATISTICS XML ON;");
    expect(wrapped).not.toContain("SET STATISTICS IO, TIME ON;");
    expect(wrapped).toContain("BEGIN TRY\nSELECT 1\nEND TRY");
    expect(wrapped).toContain("BEGIN CATCH");
    expect(wrapped).toContain("THROW;");
    // trailing OFF after the TRY/CATCH so success paths clean up too
    expect(wrapped.trim().endsWith("SET STATISTICS XML OFF;\nSET STATISTICS IO, TIME OFF;")).toBe(true);
  });

  test("captureStats: adds SET STATISTICS IO, TIME ON without SET STATISTICS XML ON", () => {
    const wrapped = wrapBatch("SELECT 1", { captureStats: true });
    expect(wrapped).toContain("SET STATISTICS IO, TIME ON;");
    expect(wrapped).not.toContain("SET STATISTICS XML ON;");
  });

  test("both flags: both ON statements present", () => {
    const wrapped = wrapBatch("SELECT 1", { capturePlan: true, captureStats: true });
    expect(wrapped).toContain("SET STATISTICS XML ON;");
    expect(wrapped).toContain("SET STATISTICS IO, TIME ON;");
  });

  test("CREATE-first batch skips the wrap even with capture requested", () => {
    const sql = "CREATE PROCEDURE dbo.foo AS SELECT 1";
    const wrapped = wrapBatch(sql, { capturePlan: true, captureStats: true });
    expect(wrapped).toBe(`SET STATISTICS XML OFF;\nSET STATISTICS IO, TIME OFF;\n${sql}`);
    expect(wrapped).not.toContain("BEGIN TRY");
  });

  test("skipsWrap: true for CREATE, false for SELECT/INSERT/UPDATE/DELETE/EXEC", () => {
    expect(skipsWrap("CREATE TABLE t (id int)")).toBe(true);
    expect(skipsWrap("  -- comment\nCREATE VIEW v AS SELECT 1")).toBe(true);
    expect(skipsWrap("SELECT 1")).toBe(false);
    expect(skipsWrap("INSERT INTO t VALUES (1)")).toBe(false);
    expect(skipsWrap("EXEC dbo.foo")).toBe(false);
  });
});
