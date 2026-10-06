import { defineConfig } from "vite";

// One build (2026-10-06): entry basic.html -> src/main.ts. The CrazyGames
// SDK loads at runtime from its CDN (not bundled); ads stay off via
// src/portal/config.ts ADS_ENABLED until the game reaches Full.

export default defineConfig({
  base: "./",
  server: {
    port: 5174,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: "basic.html",
      output: {
        manualChunks: {
          three: ["three"],
          cannon: ["cannon-es"],
        },
      },
    },
  },
});
