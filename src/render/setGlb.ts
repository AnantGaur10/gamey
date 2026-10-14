import * as THREE from "three";
import { stagePositions, addDirtDetail } from "./arena";

// Generic loader for the map sets built with scripts/blender/set_kit.py
// (saloon / falls / town; Main Street keeps streetGlb.ts). Same placement as
// the street: the set origin sits 9.5m past the foe along the duel line,
// Blender +Y fronts turned toward the duel by an inner yaw of PI.
//
// Node contract (set_kit.py): S_Paint (vertex colours), S_Glow (emissive by
// time of day), S_Water (flow shader), S_Foliage (wind sway), S_Sky (window
// openings painted with the time-of-day light), S_Shaft (additive sunbeams),
// A_Swing* / A_Sway* / A_Spin* (pivoted parts posed from absolute time).
// Everything here is cosmetic: never touches physics, hit capsules or the
// fixed clock. Returns null on ANY failure (the arena floor + sky remain).

export interface MapSet {
  group: THREE.Group;
  /** Absolute time in seconds (water flow, wind, swinging signs). Stateless. */
  tick(tSec: number): void;
  /** Window / lamp glow: 0 = off ... 1 = fully lit. */
  setGlow(k: number): void;
  /** Hell variant: the whole set turns red / dark brown, water turns to lava. */
  setHell(on: boolean): void;
  /** S_Sky openings + S_Shaft beam tint (sRGB hex). */
  setWindow(hex: number): void;
  /** S_Shaft sunbeam strength 0..1. */
  setShaft(k: number): void;
  /** Night read of the surroundings (MapDef.nightVis); null = off. */
  setNightVis(v: { fill: number; fog: number } | null): void;
  dispose(): void;
}

// Parsed GLBs are cached per session (cloned per duel; geometry is shared and
// never disposed here), so a series only fetches + parses each set once.
const cache = new Map<string, Promise<THREE.Group | null>>();

function loadScene(url: string): Promise<THREE.Group | null> {
  let p = cache.get(url);
  if (!p) {
    p = (async () => {
      try {
        const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
        const gltf = await new GLTFLoader().loadAsync(url);
        return gltf.scene;
      } catch (err) {
        cache.delete(url);
        if (import.meta.env.DEV) console.warn(`[gamey] set GLB failed: ${url}`, err);
        return null;
      }
    })();
    cache.set(url, p);
  }
  return p;
}

/** Start fetching a set early (series start), so the first duel swaps fast. */
export function preloadSet(url: string): void {
  void loadScene(url);
}

// Hell tint (keep in sync with set_kit.py hell_tint): luma -> very dark
// brown -> brown-red -> ember (user: "red / dark brownish"), keeping 15% of
// the original colour.
const HELL_GLSL = `
uniform float uHell;
vec3 hellTint(vec3 c) {
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  vec3 r = mix(vec3(0.035, 0.013, 0.008), vec3(0.26, 0.055, 0.025), smoothstep(0.0, 0.22, l));
  r = mix(r, vec3(0.85, 0.32, 0.08), smoothstep(0.3, 0.85, l));
  return mix(c, mix(r, c, 0.15), uHell);
}`;

/** Append a shader edit to whatever onBeforeCompile the material already has
    (dirt detail), with a distinct program cache key. */
function chain(mat: THREE.Material, key: string, fn: (sh: THREE.WebGLProgramParametersWithUniforms) => void): void {
  const prev = mat.onBeforeCompile.bind(mat);
  const prevKey = mat.customProgramCacheKey();
  mat.onBeforeCompile = (sh, r) => {
    prev(sh, r);
    fn(sh);
  };
  mat.customProgramCacheKey = () => `${prevKey}|${key}`;
  mat.needsUpdate = true;
}

type U = { value: number };

function addHell(mat: THREE.Material, uHell: U): void {
  chain(mat, "hell", (sh) => {
    sh.uniforms.uHell = uHell;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\n${HELL_GLSL}`)
      .replace("#include <color_fragment>", "#include <color_fragment>\ndiffuseColor.rgb = hellTint(diffuseColor.rgb);");
  });
}

/** Leaves / grass: sway grows with height above the ground (world y). */
function addWind(mat: THREE.Material, uTime: U): void {
  chain(mat, "wind", (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nuniform float uTime;")
      .replace(
        "#include <begin_vertex>",
        `#include <begin_vertex>
        {
          vec4 ww = modelMatrix * vec4(transformed, 1.0);
          float h = max(0.0, ww.y);
          float amp = min(h, 2.0) * 0.012 + max(h - 2.0, 0.0) * 0.008;
          float ph = ww.x * 0.35 + ww.z * 0.27;
          float gust = 0.7 + 0.3 * sin(uTime * 0.37 + ph * 0.1);
          transformed.x += amp * gust * (sin(uTime * 1.3 + ph) + 0.4 * sin(uTime * 3.1 + ph * 2.0));
          transformed.z += amp * gust * 0.6 * cos(uTime * 1.1 + ph);
        }`,
      );
  });
}

/** Moving water: vertical faces stream down in columns, flat faces ripple;
    in hell it becomes glowing lava. Normal from screen derivatives (the GLB
    ships no normals). */
function addWater(mat: THREE.Material, uTime: U, uHell: U): void {
  chain(mat, "water", (sh) => {
    sh.uniforms.uTime = uTime;
    sh.uniforms.uHell = uHell;
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWW;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvWW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vWW;\nuniform float uTime;\nuniform float uHell;\nfloat wFlow = 0.0;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          vec3 wn = normalize(cross(dFdx(vWW), dFdy(vWW)));
          float vertical = 1.0 - smoothstep(0.35, 0.7, abs(wn.y));
          float colId = floor((vWW.x + vWW.z) * 2.2);
          float jit = fract(sin(colId * 12.9898) * 43758.5453);
          float s = fract(vWW.y * 0.2 + uTime * (0.8 + 0.6 * jit) + jit);
          float fall = smoothstep(0.0, 0.2, s) * (1.0 - smoothstep(0.3, 0.85, s));
          float rip = 0.5 + 0.5 * sin(vWW.x * 1.9 + uTime * 1.4) * sin(vWW.z * 1.6 - uTime * 1.1);
          wFlow = mix(rip * 0.6, fall, vertical);
          vec3 water = diffuseColor.rgb * (0.78 + 0.55 * wFlow);
          vec3 lava = mix(vec3(0.22, 0.02, 0.0), vec3(0.85, 0.28, 0.03), wFlow);
          diffuseColor.rgb = mix(water, lava, uHell);
        }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        totalEmissiveRadiance += diffuseColor.rgb * mix(0.18 + 0.22 * wFlow, 0.5, uHell);`,
      );
    // Lava keeps the normal fog: fog-free (or half-fogged) it hung as crisp
    // blocks over a cliff the hell haze had swallowed.
  });
}

/** Night surroundings (user 2026-10-14: "see vaguely the surroundings" at
    night, not the foe). Off the duel lane only: set colours get a flat
    moonlight fill and a lighter fog. The lane (|lateral| < LANE_IN from the
    player->foe line) keeps the full night fog and light, so whatever sits
    behind the foe stays black and he never shows as a silhouette; the lane is
    depth-agnostic, so it does not tell his distance either. The duelists,
    the arena floor and fogDensity are untouched (night difficulty = fog). */
const LANE_IN = 2.5, LANE_OUT = 8.0;
function addNightVis(mat: THREE.Material, uVis: U, uFill: U, uFog: U, lane: THREE.Vector4): void {
  chain(mat, "nightvis", (sh) => {
    sh.uniforms.uNvOn = uVis;
    sh.uniforms.uNvFill = uFill;
    sh.uniforms.uNvFog = uFog;
    sh.uniforms.uNvLane = { value: lane };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vNvW;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvNvW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace(
        "#include <common>",
        `#include <common>
        varying vec3 vNvW;
        uniform float uNvOn;
        uniform float uNvFill;
        uniform float uNvFog;
        uniform vec4 uNvLane;
        float nvOff = 0.0;`,
      )
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        nvOff = uNvOn * smoothstep(${LANE_IN.toFixed(1)}, ${LANE_OUT.toFixed(1)}, abs(dot(vNvW.xz - uNvLane.xy, uNvLane.zw)));`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        "#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * uNvFill * nvOff;",
      )
      .replace(
        "#include <fog_fragment>",
        `#ifdef USE_FOG
          float nvDepth = vFogDepth * mix(1.0, uNvFog, nvOff);
          #ifdef FOG_EXP2
            float fogFactor = 1.0 - exp(-fogDensity * fogDensity * nvDepth * nvDepth);
          #else
            float fogFactor = smoothstep(fogNear, fogFar, nvDepth);
          #endif
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, fogFactor);
        #endif`,
      );
  });
}

const GLOW_DAY = 0xffb45a;
const GLOW_HELL = 0xff4a1a;

export async function loadMapSet(url: string, distM: number, paintGain = 1): Promise<MapSet | null> {
  try {
    const src = await loadScene(url);
    if (!src) return null;
    const inner = src.clone(true);
    inner.rotation.y = Math.PI;
    const group = new THREE.Group();
    group.name = "MapSet";
    group.add(inner);
    const { player: pPos, foe: fPos } = stagePositions(distM);
    const duelDir = fPos.clone().sub(pPos);
    duelDir.y = 0;
    duelDir.normalize();
    const mid = pPos.clone().lerp(fPos, 0.5);
    group.position.copy(mid).addScaledVector(duelDir, mid.distanceTo(fPos) + 9.5);
    group.rotation.y = Math.atan2(-duelDir.x, -duelDir.z);

    const uHell: U = { value: 0 };
    const uTime: U = { value: 0 };
    const uVis: U = { value: 0 }, uFill: U = { value: 0 }, uFog: U = { value: 1 };
    // Lane: origin (player, xz) + unit perpendicular of the duel line (xz).
    const lane = new THREE.Vector4(pPos.x, pPos.z, -duelDir.z, duelDir.x);
    // Colour is baked (palette x AO x sun shadow) and no normals ship:
    // flat Lambert like the street.
    const paint = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    paint.color.setScalar(paintGain); // linear multiplier on the baked colours
    addDirtDetail(paint, duelDir, 0.02);
    addHell(paint, uHell);
    addNightVis(paint, uVis, uFill, uFog, lane);
    const foliage = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    foliage.color.setScalar(paintGain);
    addWind(foliage, uTime);
    addHell(foliage, uHell);
    addNightVis(foliage, uVis, uFill, uFog, lane);
    const glow = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, emissive: GLOW_DAY, emissiveIntensity: 0 });
    addHell(glow, uHell);
    const water = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    addWater(water, uTime, uHell);
    addNightVis(water, uVis, uFill, uFog, lane);
    const sky = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false });
    const shaft = new THREE.MeshBasicMaterial({
      vertexColors: true, fog: false, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending, opacity: 0,
    });
    const byName: Record<string, THREE.Material> = {
      M_Paint: paint, M_Glow: glow, M_Water: water, M_Foliage: foliage, M_Sky: sky, M_Shaft: shaft,
    };
    const swing: THREE.Object3D[] = [], sway: THREE.Object3D[] = [], spin: THREE.Object3D[] = [];
    inner.traverse((o) => {
      if (o.name.startsWith("A_Swing")) swing.push(o);
      else if (o.name.startsWith("A_Sway")) sway.push(o);
      else if (o.name.startsWith("A_Spin")) spin.push(o);
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const old = m.material as THREE.Material;
      m.material = byName[old.name] ?? paint;
      if (old.name === "M_Shaft") m.renderOrder = 2; // after the opaque set and the duelists
    });
    const base = new Map<THREE.Object3D, THREE.Euler>();
    for (const o of [...swing, ...sway, ...spin]) base.set(o, o.rotation.clone());

    let glowK = 0;
    function tick(t: number): void {
      uTime.value = t % 3600; // keep float precision in the shaders
      const gust = 0.6 + 0.4 * Math.sin(t * 0.37) * Math.sin(t * 0.23 + 1.3);
      swing.forEach((o, i) => {
        const b = base.get(o)!;
        o.rotation.x = b.x + 0.12 * gust * Math.sin(t * 1.3 + i * 2.1);
        o.rotation.z = b.z + 0.035 * gust * Math.sin(t * 1.7 + i);
      });
      sway.forEach((o, i) => {
        const b = base.get(o)!;
        o.rotation.x = b.x + 0.025 * gust * Math.sin(t * 0.9 + i * 1.7);
        o.rotation.z = b.z + 0.04 * gust * Math.sin(t * 1.1 + i);
      });
      spin.forEach((o, i) => {
        const b = base.get(o)!;
        o.rotation.z = b.z + t * (0.9 + 0.25 * gust) + i;
      });
      if (glowK > 0) glow.emissiveIntensity = glowK * (0.9 + 0.06 * Math.sin(t * 9.1) + 0.04 * Math.sin(t * 23.7));
    }
    return {
      group,
      tick,
      setGlow(k) {
        glowK = Math.max(0, Math.min(1, k));
        glow.emissiveIntensity = glowK;
      },
      setHell(on) {
        uHell.value = on ? 1 : 0;
        glow.emissive.setHex(on ? GLOW_HELL : GLOW_DAY);
      },
      setWindow(hex) {
        sky.color.setHex(hex);
        shaft.color.setHex(hex);
      },
      setShaft(k) {
        shaft.opacity = Math.max(0, Math.min(1, k));
        shaft.visible = shaft.opacity > 0.01;
      },
      setNightVis(v) {
        uVis.value = v ? 1 : 0;
        uFill.value = v?.fill ?? 0;
        uFog.value = v?.fog ?? 1;
      },
      dispose() {
        group.removeFromParent();
        for (const m of [paint, foliage, glow, water, sky, shaft]) m.dispose();
      },
    };
  } catch (err) {
    if (import.meta.env.DEV) console.warn(`[gamey] set GLB failed: ${url}`, err);
    return null;
  }
}
