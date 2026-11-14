import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Dev: core runs on 7042 with token "dev" (core/src/dev.ts); the client appends ?token= itself.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    tailwindcss(),
    ...(mode === "servo" || mode === "servo-latest" ? [{
      name: "based-servo-entry",
      transformIndexHtml: {
        order: "pre" as const,
        handler: (html: string) => html.replace('/src/main.tsx', '/src/servo.ts'),
      },
    }] : []),
  ],
  server: {
    port: 5183,
    proxy: {
      // ws: true so the /api/lsp WebSocket (BASED-LSP-UI) tunnels through the dev proxy too.
      "/api": { target: "http://127.0.0.1:7042", changeOrigin: false, ws: true },
    },
  },
  build: {
    outDir: mode === "servo-latest" ? "dist-servo-latest" : mode === "servo" ? "dist-servo" : "dist",
    chunkSizeWarningLimit: 5000,
  },
}));
