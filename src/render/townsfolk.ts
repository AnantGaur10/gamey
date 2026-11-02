// Townsfolk (user 2026-11-02): Main Street and Telegraph Row get no music;
// instead a few townsfolk stroll their boardwalks and you hear their boots.
// They are scenery: never in the duel lane (|x| < 2.5 between camera and foe,
// set_kit.py), no hit volume, cosmetic + time-based (they freeze with the
// pause, never touch the fixed clock). Once shots ring out they hurry off.
//
// Rigs are the enemy outfit GLBs (same O_ rig as the foe), never the foe's
// own outfit, walked procedurally: hips, knees, left arm, a bob; the right
// hand rides the holstered grip (the `idle` clip), the gun stays holstered.
// Placed in SET space (Blender metres: x = across the screen, y = down the
// street, foe at (0, 9.5)) under the set's GLB root, where a Blender point
// (x, y, z) is the local (x, z, -y).
import * as THREE from "three";
import { loadCowboyGlb, type CowboyGlb } from "./cowboyGlb";
import { FOE_LOOKS, type FoeLookId } from "./foes";
import type { MapId } from "./maps";

/** A straight walk in set space; the walker ping-pongs between its ends.
    `exit`: the end that leads out of the picture (where they hurry off to). */
interface Lane { a: [number, number]; b: [number, number]; exit: "a" | "b"; }

interface MapFolk {
  lanes(camY: number): Lane[];
  /** Walking surface height at a set point (boardwalk top or the street). */
  height(x: number, y: number): number;
  count: number;
}

const WALK_TOP = 0.32;
// Telegraph Row (build_town.py): boardwalk runs per side, in screen y.
const TOWN_WALK_L: Array<[number, number]> = [[-16, -2.4], [0, 8], [8, 17], [19.2, 28.2], [28.2, 35], [36.6, 46]];
const TOWN_WALK_R: Array<[number, number]> = [[-16, -7], [-7, 5], [7.4, 15.4], [15.4, 25], [27, 35.5], [35.5, 46]];
/** Boardwalk top with 0.4m ramps at the ends (the end steps), else the street. */
function onRuns(runs: Array<[number, number]>, y: number): number {
  let h = 0;
  for (const [a, b] of runs) {
    const inside = Math.min(y - a, b - y);
    if (inside > -0.4) h = Math.max(h, WALK_TOP * Math.min(1, (inside + 0.4) / 0.4));
  }
  return h;
}

const FOLK: Partial<Record<MapId, MapFolk>> = {
  // Main Street (build_street.py): the boardwalk along the facades behind the
  // foe, x -19.5..19.5, y 0..2.2. y 1.6 clears the porch props (rocker,
  // barrels, crates <= y 1.45) and the lamp posts on the front edge (y 2.0);
  // the stretch right behind the foe stays empty (a walker crossing his
  // silhouette would muddle the aim), and the crate at x 4.0.
  street: {
    lanes: () => [{ a: [-19, 1.6], b: [-3.6, 1.6], exit: "a" }, { a: [4.7, 1.6], b: [19, 1.6], exit: "b" }],
    // The main boardwalk, then the left row's (bank, assay office) past the gap.
    height: (x) => (Math.abs(x) <= 19.5 || (x >= -34 && x <= -20.6) ? WALK_TOP : 0),
    count: 3,
  },
  // Telegraph Row: both side walks, hugging the storefronts (n 0.4 off the
  // wall at x -/+8.5: clear of the barrels/crates, porch posts and the
  // outside stair), from the end row to well short of the camera.
  town: {
    lanes: (camY) => {
      const top = Math.min(46, camY - 6);
      return [{ a: [-8.1, -15], b: [-8.1, top], exit: "b" }, { a: [8.1, -15], b: [8.1, top], exit: "b" }];
    },
    height: (x, y) => onRuns(x < 0 ? TOWN_WALK_L : TOWN_WALK_R, y),
    count: 4,
  },
};

const OUTFITS: FoeLookId[] = ["greenhorn", "prospector", "kate", "ruby", "marshal", "dandy", "bandido", "widow"];
const WALK_SPEED = 1.25; // m/s
const HURRY_SPEED = 2.8;
const STEP_LEN = 0.68; // m per step

export interface Townsfolk {
  /** Cosmetic, per rendered frame (dt in seconds, already clamped). */
  tick(dt: number): void;
  /** Shots fired: everyone heads off the nearest way and is gone. */
  hurry(): void;
  dispose(): void;
}

interface Walker {
  rig: CowboyGlb;
  lane: Lane;
  s: number; // 0..1 along the lane
  dir: 1 | -1;
  side: number; // lateral jitter (m)
  pause: number; // s left standing
  phase: number;
  amp: number;
  yaw: number;
  gone: boolean;
  lastCos: number;
  base: Map<THREE.Object3D, THREE.Euler>;
  cuffRel: THREE.Vector3 | null;
  j: Record<"legL" | "legR" | "kneeL" | "kneeR" | "sleeve" | "cuff", THREE.Object3D | null>;
}

export function folkCount(map: MapId, stage: number, hell: boolean, lowGfx: boolean, lowMemory: boolean, saveData: boolean): number {
  const f = FOLK[map];
  if (!f || hell || saveData) return 0;
  let n = f.count;
  if (stage >= 2) n = Math.ceil(n / 2); // night: the street empties out
  if (lowMemory) n = Math.min(n, 2);
  if (lowGfx) n = Math.min(n, 1);
  return n;
}

export function createTownsfolk(opts: {
  map: MapId;
  /** The set's GLB root (a Blender point (x, y, z) is its local (x, z, -y)). */
  root: THREE.Object3D;
  distM: number;
  count: number;
  /** Outfits that must not walk the street (the foe's). */
  exclude: FoeLookId[];
  onStep(world: THREE.Vector3, surface: "wood" | "dirt"): void;
}): Townsfolk {
  const def = FOLK[opts.map];
  const walkers: Walker[] = [];
  let alive = true;
  let hurrying = false;
  if (!def || opts.count <= 0) return { tick() {}, hurry() {}, dispose() {} };
  const camY = 9.5 + Math.sqrt(opts.distM * opts.distM + 36) + 3.1;
  const lanes = def.lanes(camY);
  const pool = OUTFITS.filter((o) => !opts.exclude.includes(o));
  for (let i = pool.length - 1; i > 0; i--) { const k = Math.floor(Math.random() * (i + 1)); [pool[i], pool[k]] = [pool[k], pool[i]]; }
  const base = import.meta.env.BASE_URL;
  const tmp = new THREE.Vector3();

  for (let i = 0; i < opts.count; i++) {
    const outfit = pool[i % pool.length];
    const lane = lanes[i % lanes.length];
    void loadCowboyGlb(`${base}models/${FOE_LOOKS[outfit].glb}`, "O").then((rig) => {
      if (!rig || !alive) return;
      rig.holster?.();
      if (rig.hasClip("idle")) rig.playClip("idle", true); // hand on the holstered grip
      const g = rig.group;
      const find = (n: string) => g.getObjectByName(`O_${n}`) ?? null;
      const j = { legL: find("Leg_L"), legR: find("Leg_R"), kneeL: find("Knee_L"), kneeR: find("Knee_R"), sleeve: find("Sleeve_L"), cuff: find("Cuff_L") };
      const baseRot = new Map<THREE.Object3D, THREE.Euler>();
      for (const o of Object.values(j)) if (o) baseRot.set(o, o.rotation.clone());
      const w: Walker = {
        rig, lane, s: Math.random(), dir: Math.random() < 0.5 ? 1 : -1, side: (Math.random() - 0.5) * 0.2,
        pause: Math.random() < 0.3 ? Math.random() * 2 : 0, phase: Math.random() * 6, amp: 0, yaw: 0, gone: false, lastCos: 1,
        base: baseRot, cuffRel: j.sleeve && j.cuff ? j.cuff.position.clone().sub(j.sleeve.position) : null, j,
      };
      if (hurrying) { w.gone = true; return; } // shots already fired: nobody strolls in
      w.yaw = laneYaw(w);
      place(w, 0);
      opts.root.add(g);
      walkers.push(w);
    });
  }

  function laneDir(l: Lane): [number, number] {
    const dx = l.b[0] - l.a[0], dy = l.b[1] - l.a[1];
    const len = Math.hypot(dx, dy) || 1;
    return [dx / len, dy / len];
  }
  function laneYaw(w: Walker): number {
    const [dx, dy] = laneDir(w.lane);
    // Set direction (dx, dy) is the local (dx, 0, -dy); the rig faces +Z at yaw 0.
    return Math.atan2(dx * w.dir, -dy * w.dir);
  }
  function place(w: Walker, bob: number): void {
    const [dx, dy] = laneDir(w.lane);
    const x = w.lane.a[0] + (w.lane.b[0] - w.lane.a[0]) * w.s + dy * w.side;
    const y = w.lane.a[1] + (w.lane.b[1] - w.lane.a[1]) * w.s - dx * w.side;
    const g = w.rig.group;
    g.position.set(x, def!.height(x, y) + bob, -y);
    g.rotation.y = w.yaw;
  }
  const turn = (o: THREE.Object3D | null, w: Walker, dx: number): void => {
    if (!o) return;
    const b = w.base.get(o);
    if (b) o.rotation.set(b.x + dx, b.y, b.z);
  };

  function tick(dt: number): void {
    if (!alive) return;
    for (const w of walkers) {
      if (w.gone) continue;
      const speed = hurrying ? HURRY_SPEED : WALK_SPEED;
      const len = Math.hypot(w.lane.b[0] - w.lane.a[0], w.lane.b[1] - w.lane.a[1]) || 1;
      let moving = w.pause <= 0;
      if (!moving) {
        w.pause -= dt;
        if (w.pause <= 0) w.dir = (w.dir * -1) as 1 | -1; // turn back after a look around
      } else {
        w.s += (w.dir * speed * dt) / len;
        // Hurrying: on past the exit end, 25m out of the picture, then gone.
        const past = hurrying ? 25 / len : 0;
        if (w.s <= -past || w.s >= 1 + past) {
          if (hurrying) { w.gone = true; w.rig.group.visible = false; continue; }
          w.s = Math.max(0, Math.min(1, w.s));
          w.pause = 1 + Math.random() * 2.5;
          moving = false;
        } else if (!hurrying && Math.random() < dt * 0.04) {
          w.pause = 0.8 + Math.random() * 1.5; // stop a moment, then turn back (the pause end flips dir)
        }
      }
      // Ease the facing round (a turn takes ~0.4s).
      const want = laneYaw(w);
      let d = want - w.yaw;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      w.yaw += d * Math.min(1, dt * 7);
      // Gait: hips swing opposite, the swinging leg's knee folds, the left arm
      // counters the left leg, the body bobs highest over the planted foot.
      const ampTarget = moving ? (hurrying ? 0.6 : 0.4) : 0;
      w.amp += (ampTarget - w.amp) * Math.min(1, dt * 6);
      if (moving) w.phase += (dt * Math.PI * speed) / STEP_LEN;
      const sn = Math.sin(w.phase), cs = Math.cos(w.phase);
      turn(w.j.legL, w, w.amp * sn);
      turn(w.j.legR, w, -w.amp * sn);
      turn(w.j.kneeL, w, -1.3 * w.amp * Math.max(0, cs));
      turn(w.j.kneeR, w, -1.3 * w.amp * Math.max(0, -cs));
      const arm = -0.6 * w.amp * sn;
      turn(w.j.sleeve, w, arm);
      if (w.j.cuff && w.j.sleeve && w.cuffRel) {
        turn(w.j.cuff, w, arm);
        w.j.cuff.position.copy(w.j.sleeve.position).add(tmp.copy(w.cuffRel).applyAxisAngle(_X, arm));
      }
      place(w, w.amp * 0.06 * (Math.abs(cs) - 0.5));
      w.rig.update(dt);
      // A heel strikes each time the stride turns (cos crosses zero).
      if (moving && w.amp > 0.15 && Math.sign(cs) !== Math.sign(w.lastCos)) {
        const g = w.rig.group;
        g.getWorldPosition(tmp);
        opts.onStep(tmp, g.position.y > 0.2 ? "wood" : "dirt");
      }
      w.lastCos = cs;
    }
  }

  return {
    tick,
    hurry() {
      if (hurrying) return;
      hurrying = true;
      for (const w of walkers) {
        if (w.gone) continue;
        w.dir = w.lane.exit === "a" ? -1 : 1; // out of the picture, never past the foe
        w.pause = 0;
      }
    },
    dispose() {
      alive = false;
      for (const w of walkers) {
        w.rig.stopClips();
        w.rig.group.removeFromParent();
      }
      walkers.length = 0;
    },
  };
}

const _X = new THREE.Vector3(1, 0, 0);
