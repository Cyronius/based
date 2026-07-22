// Dev entry: fixed port + token so the Vite proxy can inject auth. Run: bun run dev
import { startServer } from "./server";

const server = startServer({
  port: Number(process.env.BASED_PORT ?? 7042),
  token: process.env.BASED_TOKEN ?? "dev",
});

console.log(`based core: ${server.url} (token: ${server.token})`);
