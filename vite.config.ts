import { readdirSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";
import type { OutputChunk } from "rollup";

// One build (2026-10-06): entry basic.html -> src/main.ts. The CrazyGames
// SDK loads at runtime from its CDN (not bundled); ads stay off via
// src/portal/config.ts ADS_ENABLED until the game reaches Full.

/** main.ts dynamic-imports the game (ui/home) so the SDK loads in parallel;
    preload that chunk + its static deps (three, cannon) from the HTML so
    they still start downloading with the page (no extra round trip). */
function preloadGameChunks(): Plugin {
  return {
    name: "gamey-preload-game",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      handler(_html, ctx) {
        const bundle = ctx.bundle;
        if (!bundle) return;
        const chunks = Object.values(bundle).filter((c): c is OutputChunk => c.type === "chunk");
        const entry = chunks.find((c) => c.isEntry);
        const game = chunks.find((c) => c.name === "home" && entry?.dynamicImports.includes(c.fileName));
        if (!game) return;
        return [game.fileName, ...game.imports].filter((f) => f !== entry!.fileName).map((f) => ({
          tag: "link",
          attrs: { rel: "modulepreload", crossorigin: true, href: `./${f}` },
          injectTo: "head" as const,
        }));
      },
    },
  };
}

/** Music tracks that actually ship (public/assets/music): AudioManager
    requests only these. A probe for a missing file logged a console 404 on
    every prod load (2026-10-21). */
function musicFiles(): string[] {
  try {
    return readdirSync("public/assets/music").filter((f) => /\.(mp3|ogg)$/i.test(f));
  } catch {
    return [];
  }
}

export default defineConfig({
  base: "./",
  plugins: [preloadGameChunks()],
  define: {
    __MUSIC_FILES__: JSON.stringify(musicFiles()),
  },
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
