// Dev entry: fixed port + token so the Vite proxy can inject auth. Run: bun run dev
import { join } from "node:path";
import { startServer } from "./server";
import { appDataRoot } from "./storage/db";

// Isolate dev-session data from the real app.db/agent.db under the app-data root (BASED-PLATFORM-PATHS)
// — without this, every local dev/testing run (connections created while poking at the UI, agent
// memory writes, etc.) permanently pollutes the same SQLite files a packaged/production launch reads
// on startup, including window-restore state that can resurrect a dev-only connection as a real
// window later.
process.env.BASED_DATA_DIR ??= join(appDataRoot(), "based-dev");

const server = startServer({
  port: Number(process.env.BASED_PORT ?? 7042),
  token: process.env.BASED_TOKEN ?? "dev",
});

console.log(`based core: ${server.url} (token: ${server.token})`);
