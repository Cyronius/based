// Phase 0 spike #4 server — Mastra agent (mock model) exposed as an AG-UI
// endpoint on Bun.serve, with a per-launch bearer token (the real app's
// architecture in miniature). Route: POST /agent/spike (lm-ag-ui convention:
// `${baseUrl}/agent/${agentId}`).
import { Agent } from "@mastra/core/agent";
import { MastraAgent } from "@ag-ui/mastra";
import { EventEncoder } from "@ag-ui/encoder";
import { RunAgentInputSchema, type BaseEvent } from "@ag-ui/core";
import { mockModel } from "./mock-model";

const PORT = 3100;
// Per-launch token. Fixed value in the spike so the UI (separate Vite process)
// can present it; the real app injects a random one into the webview at launch.
const TOKEN = "spike-launch-token-1f88";

const spikeAgent = new Agent({
  id: "spike",
  name: "Spike Agent",
  instructions: "You are the based margin-chat agent (scripted mock).",
  model: mockModel,
});

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (req.method !== "POST" || url.pathname !== "/agent/spike") {
      return new Response("Not found", { status: 404, headers: CORS });
    }

    const auth = req.headers.get("authorization");
    if (auth !== `Bearer ${TOKEN}`) {
      console.log(`[spike4] 401 (authorization header: ${auth ? "wrong token" : "missing"})`);
      return new Response("Unauthorized", { status: 401, headers: CORS });
    }

    const input = RunAgentInputSchema.parse(await req.json());
    console.log(
      `[spike4] run thread=${input.threadId} run=${input.runId} messages=${input.messages.length} tools=[${input.tools.map((t) => t.name).join(",")}]`,
    );

    const encoder = new EventEncoder({ accept: req.headers.get("accept") ?? undefined });
    const agui = new MastraAgent({ agent: spikeAgent, resourceId: "spike-user" });

    const stream = new ReadableStream({
      start(controller) {
        const sub = agui.run(input).subscribe({
          next: (event: BaseEvent) => {
            console.log(`[spike4]   event ${String((event as any).type)}`);
            controller.enqueue(encoder.encode(event));
          },
          error: (err) => {
            console.error("[spike4] RUN_ERROR", err);
            controller.enqueue(
              encoder.encode({ type: "RUN_ERROR", message: String((err as any)?.message ?? err) } as any),
            );
            controller.close();
          },
          complete: () => controller.close(),
        });
        return () => sub.unsubscribe();
      },
    });

    return new Response(stream, {
      headers: {
        ...CORS,
        "Content-Type": encoder.getContentType(),
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  },
});

console.log(`[spike4] AG-UI endpoint on http://127.0.0.1:${PORT}/agent/spike (bun ${Bun.version})`);
console.log(`[spike4] token: ${TOKEN}`);
