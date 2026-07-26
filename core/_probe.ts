import { MockLanguageModelV4 } from "ai/test";
import { createSubagentRunner } from "./src/agent/subagent";
import { AuditStore } from "./src/agent/audit";
import { openDb } from "./src/storage/db";
import { defaultCapabilitiesFor } from "./src/agent/surface";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function textModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: "stream-start", warnings: [] });
          c.enqueue({ type: "text-start", id: "1" });
          c.enqueue({ type: "text-delta", id: "1", delta: text });
          c.enqueue({ type: "text-end", id: "1" });
          c.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          c.close();
        },
      }),
    }),
  });
}

const dir = mkdtempSync(join(tmpdir(), "probe-"));
const audit = new AuditStore(openDb(join(dir, "app.db")));
const runner = createSubagentRunner({
  model: textModel("hello from child") as never,
  capabilities: defaultCapabilitiesFor("mssql"),
  toolDeps: {
    getAdapter: () => {
      throw new Error("no adapter");
    },
    connectionId: () => "c",
    database: () => "d",
    audit,
  },
  timeoutMs: 10_000,
  concurrency: 1,
});

const res = await runner("probe goal", [{ name: "t1", instructions: "say hello" }]);
console.log(JSON.stringify(res, null, 2));
console.log("AUDIT:", JSON.stringify(audit.list("c"), null, 2));
