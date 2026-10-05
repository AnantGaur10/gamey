import * as THREE from "three";
import { stagePositions } from "./arena";

// Ambient air particles per time of day: sunlit dust motes (noon), warm
// motes (evening), fireflies (night), rising embers (hell). One THREE.Points
// (one draw call, zero shipped bytes). Motion is a pure function of absolute
// time in the vertex shader (same stateless idea as streetGlb.tick), so it
// costs no CPU per frame and looks identical at any refresh rate. Cosmetic
// only: never touches physics, hit tests or the fixed clock.

const COUNT = 90;

interface Preset {
  color: number;
  alpha: number;
  size: number; // px at 1x
  rise: number; // m/s upward drift (wraps in the box)
  sway: number; // m of lateral wander
  blink: number; // 0 = steady, 1 = firefly pulse
  frac: number; // share of the points shown
}

const PRESETS: Record<"noon" | "evening" | "night" | "hell", Preset> = {
  noon: { color: 0xfff1d0, alpha: 0.32, size: 3, rise: 0.04, sway: 0.5, blink: 0, frac: 0.8 },
  evening: { color: 0xffc58a, alpha: 0.42, size: 3, rise: 0.03, sway: 0.45, blink: 0, frac: 0.8 },
  night: { color: 0xd8ff8a, alpha: 0.95, size: 4, rise: 0.02, sway: 0.7, blink: 1, frac: 0.35 },
  hell: { color: 0xff7a2a, alpha: 0.9, size: 3.5, rise: 0.7, sway: 0.35, blink: 0.3, frac: 1 },
};

export interface Ambient {
  /** Round index → preset (0 noon, 1 evening, 2+ night); hell overrides. */
  setTimeOfDay(roundIndex: number, hell: boolean): void;
  /** Absolute time (s) + the renderer's pixel ratio (point size is in px). */
  tick(tSec: number, pixelRatio: number): void;
  dispose(): void;
}

export function createAmbient(scene: THREE.Scene, distM: number): Ambient {
  const { player: pPos, foe: fPos } = stagePositions(distM);
  const mid = pPos.clone().lerp(fPos, 0.5);
  const axis = fPos.clone().sub(pPos).setY(0).normalize();
  const perp = new THREE.Vector3(-axis.z, 0, axis.x);
  // Seeded scatter in the air the camera looks through: from just past the
  // player to the storefronts, both sides of the street.
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const pos = new Float32Array(COUNT * 3);
  const rand = new Float32Array(COUNT * 2);
  const BOX_H = 5.5;
  for (let i = 0; i < COUNT; i++) {
    const p = mid.clone()
      .addScaledVector(axis, -4 + rnd() * 20)
      .addScaledVector(perp, (rnd() - 0.5) * 20);
    pos[i * 3] = p.x;
    pos[i * 3 + 1] = rnd() * BOX_H;
    pos[i * 3 + 2] = p.z;
    rand[i * 2] = rnd(); // phase
    rand[i * 2 + 1] = i / COUNT; // rank (preset frac culls by it)
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  geo.setAttribute("aRand", new THREE.BufferAttribute(rand, 2));

  const mat = new THREE.ShaderMaterial({
    uniforms: {
      uT: { value: 0 },
      uPr: { value: 1 },
      uColor: { value: new THREE.Color() },
      uAlpha: { value: 0 },
      uSize: { value: 3 },
      uRise: { value: 0 },
      uSway: { value: 0 },
      uBlink: { value: 0 },
      uFrac: { value: 1 },
      uH: { value: BOX_H },
    },
    vertexShader: `
      attribute vec2 aRand;
      uniform float uT, uPr, uSize, uRise, uSway, uBlink, uFrac, uH;
      varying float vA;
      void main() {
        float ph = aRand.x * 6.2831;
        vec3 p = position;
        p.x += sin(uT * 0.31 + ph * 3.0) * uSway;
        p.z += cos(uT * 0.27 + ph * 2.0) * uSway;
        p.y = mod(p.y + uT * uRise + sin(uT * 0.5 + ph) * 0.25, uH);
        // Fade in/out at the box floor + ceiling so the wrap never pops.
        float edge = smoothstep(0.0, 0.6, p.y) * (1.0 - smoothstep(uH - 1.0, uH, p.y));
        float pulse = mix(1.0, pow(max(0.0, sin(uT * 1.7 + ph * 5.0)), 3.0), uBlink);
        vA = edge * pulse * step(aRand.y, uFrac);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
        gl_PointSize = uSize * uPr * (0.7 + 0.6 * aRand.x);
      }`,
    fragmentShader: `
      uniform vec3 uColor;
      uniform float uAlpha;
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5) * 2.0;
        float a = (1.0 - smoothstep(0.35, 1.0, d)) * uAlpha * vA;
        if (a < 0.01) discard;
        gl_FragColor = vec4(uColor, a);
      }`,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false; // shader moves points; static bounds lie
  points.renderOrder = 2;
  scene.add(points);

  function setTimeOfDay(i: number, hell: boolean): void {
    const p = hell ? PRESETS.hell : i <= 0 ? PRESETS.noon : i === 1 ? PRESETS.evening : PRESETS.night;
    const u = mat.uniforms;
    (u.uColor.value as THREE.Color).setHex(p.color);
    u.uAlpha.value = p.alpha;
    u.uSize.value = p.size;
    u.uRise.value = p.rise;
    u.uSway.value = p.sway;
    u.uBlink.value = p.blink;
    u.uFrac.value = p.frac;
  }
  function tick(tSec: number, pixelRatio: number): void {
    mat.uniforms.uT.value = tSec % 10000; // keep float precision sane
    mat.uniforms.uPr.value = pixelRatio;
  }
  function dispose(): void {
    scene.remove(points);
    geo.dispose();
    mat.dispose();
  }
  setTimeOfDay(0, false);
  return { setTimeOfDay, tick, dispose };
}
