import { resolve } from "node:path";
import { defineConfig } from "vite";

const root = resolve(import.meta.dirname, "client");

export default defineConfig({
  root,
  server: {
    // Allow tunnel hostnames (Cloudflare/ngrok) in dev.
    allowedHosts: true,
  },
  build: {
    outDir: resolve(import.meta.dirname, "dist/client"),
    emptyOutDir: true,
    // Phaser (~1.2 MB) is its own lazy chunk, loaded only when the match starts.
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        game: resolve(root, "game/index.html"),
        controller: resolve(root, "controller/index.html"),
      },
    },
  },
});
