import * as THREE from "three";

// GPU bookkeeping for the session's ONE WebGL context (render/arena.ts,
// 2026-10-15 low-end pass). Arenas (menu backdrop, duels) come and go; the
// context, the compiled programs and the session GLB caches stay. What an
// arena uploaded is freed when it ends (releaseScene), never by context loss.

/** GPU data that outlives an arena: session GLB caches (cloned per duel,
    geometry shared) and module-level canvas textures. */
const keptGpu = new WeakSet<object>();

export function keepOnGpu(root: THREE.Object3D): void {
  root.traverse((o) => {
    const g = (o as THREE.Mesh).geometry;
    if (g) keptGpu.add(g);
  });
}

export function keepTexture(t: THREE.Texture): void {
  keptGpu.add(t);
}

/** Compiled programs outlive the materials that built them: every round makes
    new materials with the same program keys (per-duel values are uniforms),
    so one extra reference keeps each program for the session (~40 total). */
const pinnedPrograms = new WeakSet<object>();
export function pinPrograms(r: THREE.WebGLRenderer): void {
  for (const p of r.info.programs ?? []) {
    if (pinnedPrograms.has(p)) continue;
    pinnedPrograms.add(p);
    (p as unknown as { usedTimes: number }).usedTimes++;
  }
}

/** three numbers ShaderMaterial sources in a cache that forgets a source when
    its last material is disposed; the next round's copy then gets new ids,
    a new program key and a fresh compile (one leaked program per round with
    pinning). One live instance per source keeps the ids, so copies reuse
    the program. Everything else disposes normally. */
const shaderKeepers = new Map<string, THREE.Material>();
export function retireMaterial(mat: THREE.Material): void {
  const sm = mat as THREE.ShaderMaterial;
  if (sm.isShaderMaterial) {
    const key = `${sm.vertexShader}\u0000${sm.fragmentShader}`;
    if (!shaderKeepers.has(key)) {
      shaderKeepers.set(key, sm);
      return;
    }
    if (shaderKeepers.get(key) === sm) return;
  }
  mat.dispose();
}

/** Free the GPU side of what is still in a scene (geometry, textures,
    material refs), skipping kept data. Objects removed earlier free
    themselves (their own dispose()). */
export function releaseScene(scene: THREE.Scene): void {
  const textures = new Set<THREE.Texture>();
  const tex = (v: unknown) => {
    if (v && (v as THREE.Texture).isTexture && !keptGpu.has(v as object)) textures.add(v as THREE.Texture);
  };
  scene.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !keptGpu.has(m.geometry)) m.geometry.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) tex(v);
      const u = (mat as THREE.ShaderMaterial).uniforms;
      if (u) for (const x of Object.values(u)) tex(x?.value);
      retireMaterial(mat);
    }
  });
  for (const t of textures) t.dispose();
}
