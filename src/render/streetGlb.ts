import * as THREE from "three";
import { stagePositions } from "./arena";

/** Blender street set (scripts/blender/build_street.py) + its ambient life. */
export interface StreetSet {
  group: THREE.Group;
  /** Cosmetic motion only (signs, doors, horse, cat, laundry, tumbleweed),
   * posed from absolute time in seconds: stateless, rate-independent, and
   * never touches physics or hit capsules. */
  tick(tSec: number): void;
  /** Window/lantern glow: 0 = day (dark glass) ... 1 = night (lit). */
  setGlow(k: number): void;
}

// Loads the Blender street set and poses it exactly where the procedural
// street sits (same mid/duelDir formula), so the swap is seamless.
// Returns null on ANY failure — caller keeps the procedural street.
// Like the cowboys, Blender fronts (+Y) arrive as -Z: inner yaw of PI aims
// the storefronts at +Z toward the duel, matching the procedural seam.
// Node-local axes (glTF): screen-right = -x, up = +y, toward camera = -z.
export async function loadStreetGlb(
  url: string,
  distM: number,
): Promise<StreetSet | null> {
  try {
    const { GLTFLoader } = await import(
      "three/examples/jsm/loaders/GLTFLoader.js"
    );
    const gltf = await new GLTFLoader().loadAsync(url);
    const inner = gltf.scene;
    inner.rotation.y = Math.PI;
    const group = new THREE.Group();
    group.add(inner);
    const { player: pPos, foe: fPos } = stagePositions(distM);
    const duelDir = fPos.clone().sub(pPos);
    duelDir.y = 0;
    duelDir.normalize();
    const mid = pPos.clone().lerp(fPos, 0.5);
    group.position.copy(mid).addScaledVector(duelDir, mid.distanceTo(fPos) + 9.5);
    group.rotation.y = Math.atan2(-duelDir.x, -duelDir.z);

    // Colour is baked into COLOR_0 (palette x AO x sun shadow) and the GLB
    // ships no normals: Lambert + flatShading matches the arena's lighting
    // model (the ground band's edge melts into the arena plane) and is cheap.
    const paint = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    const glow = new THREE.MeshLambertMaterial({
      vertexColors: true,
      flatShading: true,
      emissive: 0xffb45a,
      emissiveIntensity: 0,
    });
    inner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const old = m.material as THREE.Material;
      m.material = old.name === "M_Glow" ? glow : paint;
      old.dispose();
    });

    const node = (n: string) => inner.getObjectByName(n) ?? null;
    const batL = node("A_BatL"), batR = node("A_BatR");
    const signs = [node("A_SignWhiskey"), node("A_SignRooms")];
    const head = node("A_HorseHead"), tail = node("A_HorseTail");
    const catTail = node("A_CatTail"), rocker = node("A_Rocker");
    const laundry = node("A_Laundry"), tumble = node("A_Tumble");
    const tumbleX = tumble ? tumble.position.x : 0;
    const tumbleY = tumble ? tumble.position.y : 0;
    let glowK = 0;

    const TUMBLE_PERIOD = 19; // s; on screen for TUMBLE_CROSS of them
    const TUMBLE_CROSS = 8;
    function tick(t: number): void {
      // Wind: two detuned sines read as gusts instead of a metronome.
      const gust = 0.6 + 0.4 * Math.sin(t * 0.37) * Math.sin(t * 0.23 + 1.3);
      signs.forEach((s, i) => {
        if (!s) return;
        s.rotation.z = 0.045 * gust * Math.sin(t * 1.7 + i * 2.1);
        s.rotation.x = 0.12 * gust * Math.sin(t * 1.3 + i);
      });
      const bat = 0.22 * gust * (0.5 + 0.5 * Math.sin(t * 0.9));
      if (batL) batL.rotation.y = -bat;
      if (batR) batR.rotation.y = bat * 0.85;
      if (laundry) laundry.rotation.x = 0.18 * gust * Math.sin(t * 1.9) - 0.06;
      if (rocker) rocker.rotation.z = 0.09 * Math.sin(t * 1.6);
      // Horse: slow breathing nod + an occasional head toss; tail swish.
      if (head) {
        const toss = Math.max(0, Math.sin(t * 0.31) - 0.92) * 3.5;
        head.rotation.z = 0.035 * Math.sin(t * 0.8) - 0.12 * toss;
      }
      if (tail) {
        tail.rotation.x = 0.25 * Math.sin(t * 2.3) * (0.4 + 0.6 * Math.max(0, Math.sin(t * 0.5)));
        tail.rotation.z = 0.06 * Math.sin(t * 1.1);
      }
      if (catTail) catTail.rotation.z = 0.35 * Math.sin(t * 2.6) * Math.max(0.2, Math.sin(t * 0.4));
      if (tumble) {
        const c = (t % TUMBLE_PERIOD) / TUMBLE_CROSS; // 0..1 while crossing
        tumble.visible = c < 1;
        if (c < 1) {
          const dx = -18 + 36 * c; // screen-left -> right
          tumble.position.x = tumbleX - dx; // screen-right is node -x
          tumble.position.y = tumbleY + Math.abs(Math.sin(c * Math.PI * 7)) * 0.28;
          tumble.rotation.z = (dx / 0.38) % (Math.PI * 2);
        }
      }
      if (glowK > 0) {
        glow.emissiveIntensity = glowK * (0.9 + 0.06 * Math.sin(t * 9.1) + 0.04 * Math.sin(t * 23.7));
      }
    }
    function setGlow(k: number): void {
      glowK = Math.max(0, Math.min(1, k));
      glow.emissiveIntensity = glowK;
    }
    return { group, tick, setGlow };
  } catch (err) {
    if (import.meta.env.DEV) console.warn(`[gamey] street GLB failed: ${url}`, err);
    return null;
  }
}
