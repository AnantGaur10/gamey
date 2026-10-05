import { defineConfig } from "vite";

// Dual-build: GAMEY_BUILD=basic (CrazyGames Basic, zero SDK bytes)
//              GAMEY_BUILD=full  (CrazyGames Full + later Poki)
// Game logic is never forked; only the entry + adapter differ.
const buildKind = process.env.GAMEY_BUILD === "full" ? "full" : "basic";

export default defineConfig({
  base: "./",
  server: {
    port: 5174,
  },
  define: {
    __GAMEY_BUILD__: JSON.stringify(buildKind),
  },
  build: {
    outDir: buildKind === "full" ? "dist-full" : "dist-basic",
    emptyOutDir: true,
    sourcemap: false,
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: buildKind === "full" ? "full.html" : "basic.html",
      output: {
        manualChunks: {
          three: ["three"],
          cannon: ["cannon-es"],
        },
      },
    },
  },
});
