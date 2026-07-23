// Traces: BASED-EXEC-PLAN, BASED-CLIENT-STATS
import { firstKeyword } from "./classify";
import type { ExecuteOptions } from "./types";

const OFF = "SET STATISTICS XML OFF;\nSET STATISTICS IO, TIME OFF;";

/** CREATE PROCEDURE/VIEW/FUNCTION/TRIGGER must be the first statement in its batch — wrapping it in
 *  BEGIN TRY would break that. Batches starting with CREATE never get capture-wrapped. */
export function skipsWrap(batchSql: string): boolean {
  return firstKeyword(batchSql) === "CREATE";
}

/** Wraps a batch to capture an actual execution plan (SET STATISTICS XML ON) and/or client
 *  statistics (SET STATISTICS IO, TIME ON). Non-CREATE batches — capturing or not — get a defensive
 *  leading OFF, since a cancelled capture-enabled batch can leave the setting ON on its pooled
 *  connection (TRY/CATCH doesn't run on a TDS ATTENTION abort); this self-heals the next batch that
 *  borrows the same connection. A CREATE-first batch is returned completely unmodified — even the
 *  defensive OFF would violate "CREATE must be the first statement," so a leak here can only be
 *  self-healed by a later non-CREATE batch. */
export function wrapBatch(batchSql: string, opts: ExecuteOptions): string {
  if (skipsWrap(batchSql)) return batchSql;
  if (!opts.capturePlan && !opts.captureStats) return `${OFF}\n${batchSql}`;
  const on = [
    opts.capturePlan ? "SET STATISTICS XML ON;" : "",
    opts.captureStats ? "SET STATISTICS IO, TIME ON;" : "",
  ]
    .filter(Boolean)
    .join("\n");
  return `${OFF}\n${on}\nBEGIN TRY\n${batchSql}\nEND TRY\nBEGIN CATCH\n  ${OFF}\n  THROW;\nEND CATCH\n${OFF}`;
}
