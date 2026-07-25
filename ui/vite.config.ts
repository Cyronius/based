import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: core runs on 7042 with token "dev" (core/src/dev.ts); the client appends ?token= itself.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5183,
    proxy: {
      // ws: true so the /api/lsp WebSocket (BASED-LSP-UI) tunnels through the dev proxy too.
      "/api": { target: "http://127.0.0.1:7042", changeOrigin: false, ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 5000,
  },
});
