import { MockLanguageModelV4 } from "ai/test";
import { createSubagentRunner } from "./src/agent/subagent";
import { AuditStore } from "./src/agent/audit";
import { openDb } from "./src/storage/db";
import { defaultCapabilitiesFor } from "./src/agent/surface";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let turn = 0;
const model = new MockLanguageModelV4({
  doGenerate: async () => {
    turn++;
    if (turn === 1) {
      return {
        content: [
          { type: "tool-call", toolCallId: "tc1", toolName: "report_findings",
            input: JSON.stringify({ summary: "found three tables", artifacts: [{ label: "q", sql: "SELECT 1" }], confidence: "high" }) },
        ],
        finishReason: "tool-calls",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        warnings: [],
      };
    }
    return {
      content: [{ type: "text", text: "done" }],
      finishReason: "stop",
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    };
  },
});

const dir = mkdtempSync(join(tmpdir(), "probe-"));
const audit = new AuditStore(openDb(join(dir, "app.db")));
const runner = createSubagentRunner({
  model: model as never,
  capabilities: defaultCapabilitiesFor("mssql"),
  toolDeps: {
    getAdapter: () => { throw new Error("no adapter"); },
    connectionId: () => "c",
    database: () => "d",
    audit,
  },
  timeoutMs: 10_000,
  concurrency: 1,
});

const res = await runner("probe goal", [{ name: "t1", instructions: "say hello" }]);
console.log(JSON.stringify(res, null, 2));
