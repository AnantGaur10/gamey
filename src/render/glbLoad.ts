import type * as THREE from "three";
import { noteLoadProgress } from "./loadProgress";

// One GLB fetch + parse with retries (2026-11-02): a single failed request
// (a flaky phone link, a quick tunnel, a dev-server restart) used to leave the
// duel on its stand-ins (the procedural street, or no saloon at all) and,
// counted as "loaded", skipped the loading bar on every later duel.
const RETRY_MS = [700, 2000, 5000];

export type Gltf = { scene: THREE.Group; animations: THREE.AnimationClip[] };

export async function loadGlbWithRetry(url: string): Promise<Gltf> {
  const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
  for (let attempt = 0; ; attempt++) {
    try {
      return await new GLTFLoader().loadAsync(url, (e) => noteLoadProgress(url, e));
    } catch (err) {
      if (attempt >= RETRY_MS.length) throw err;
      if (import.meta.env.DEV) console.warn(`[gamey] GLB retry ${attempt + 1}: ${url}`, err);
      await new Promise((r) => setTimeout(r, RETRY_MS[attempt]));
    }
  }
}
