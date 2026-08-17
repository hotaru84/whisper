import path from "node:path";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    // Bind every interface (unless TAURI_DEV_HOST names one), so `npm run dev`
    // is reachable from outside the machine/container running it -- a remote
    // dev container's preview proxy, a phone on the LAN. Localhost-only was
    // why the browser-preview entry point (`.claude/launch.json`) never
    // worked. Dev server only: `npm run tauri build` serves `frontendDist`
    // and never runs this.
    host: host || true,
    // Vite rejects requests whose Host header isn't localhost/an IP, which is
    // exactly what a preview proxy sends. Dev-only, and this server has
    // nothing behind it but the frontend's own source.
    allowedHosts: true,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },

  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
}));
