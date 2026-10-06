import * as THREE from "three";

// Secondary motion (user 2026-10-06): the hat and coat tails lag their
// parent like damped pendulums. Cosmetic, but it still integrates on the
// shared fixed clock (fixedStep inside the duel's stepper callback) and
// renders interpolated by alpha, so it looks the same at 60/144/165Hz.
// Pivots come from cowboyGlb (hat brim / tail tops); the procedural cowboy
// has none and gets no sway.

export interface SwayNode {
  pivot: THREE.Object3D;
  kind: "hat" | "tail";
}

export interface Sway {
  /** Once per rendered frame BEFORE the fixed steps: measures the parent's
      world acceleration from the last rendered pose. */
  sense(dt: number): void;
  fixedStep(h: number): void;
  /** Writes the interpolated angles onto the pivots. */
  render(alpha: number): void;
  /** Extra swing on a hit (0..1). */
  kick(k: number): void;
}

// k = stiffness (rad/s^2 per rad), zeta = damping ratio, gain = rad per
// m/s^2 of parent acceleration, max = clamp (rad), wind = idle flutter (rad).
const TUNE = {
  hat: { k: 220, zeta: 0.35, gain: 0.012, max: 0.18, wind: 0.004, kick: 1.2 },
  tail: { k: 55, zeta: 0.22, gain: 0.045, max: 0.6, wind: 0.035, kick: 3.5 },
};

const _w = new THREE.Vector3();
const _q = new THREE.Quaternion();

export function createSway(nodes: SwayNode[]): Sway | null {
  const live = nodes.filter((n) => n.pivot.parent);
  if (live.length === 0) return null;
  const st = live.map((n, i) => ({
    n,
    t: TUNE[n.kind],
    base: n.pivot.rotation.clone(),
    x: 0, z: 0, vx: 0, vz: 0, px: 0, pz: 0,
    pos: null as THREE.Vector3 | null,
    vel: new THREE.Vector3(),
    acc: new THREE.Vector3(),
    phase: i * 1.7,
  }));
  let clock = 0;
  return {
    sense(dt) {
      if (dt <= 0) return;
      const f = 1 - Math.exp(-dt * 18); // smooth the finite differences
      for (const s of st) {
        const parent = s.n.pivot.parent!;
        parent.updateWorldMatrix(true, false);
        _w.setFromMatrixPosition(parent.matrixWorld);
        if (!s.pos) { s.pos = _w.clone(); continue; }
        const vx = (_w.x - s.pos.x) / dt, vy = (_w.y - s.pos.y) / dt, vz = (_w.z - s.pos.z) / dt;
        // Acceleration into the parent's frame: the swing axes are local.
        const ax = (vx - s.vel.x) / dt, ay = (vy - s.vel.y) / dt, az = (vz - s.vel.z) / dt;
        parent.getWorldQuaternion(_q).invert();
        const a = new THREE.Vector3(ax, ay, az).applyQuaternion(_q);
        s.acc.lerp(a.clampLength(0, 60), f);
        s.vel.set(vx, vy, vz);
        s.pos.copy(_w);
      }
    },
    fixedStep(h) {
      clock += h;
      for (const s of st) {
        const { k, zeta, gain, max, wind } = s.t;
        const c = 2 * zeta * Math.sqrt(k);
        s.px = s.x;
        s.pz = s.z;
        // The free end lags the parent's acceleration. A tail hangs BELOW its
        // pivot and the hat sits ABOVE it, so the same lag is opposite angles.
        const sg = s.n.kind === "tail" ? 1 : -1;
        const gx = sg * s.acc.z * gain + wind * Math.sin(clock * 1.9 + s.phase);
        const gz = -sg * s.acc.x * gain + wind * 0.6 * Math.sin(clock * 1.3 + s.phase * 2);
        s.vx += (k * (gx - s.x) - c * s.vx) * h;
        s.vz += (k * (gz - s.z) - c * s.vz) * h;
        s.x = Math.max(-max, Math.min(max, s.x + s.vx * h));
        s.z = Math.max(-max, Math.min(max, s.z + s.vz * h));
      }
    },
    render(alpha) {
      for (const s of st) {
        const x = s.px + (s.x - s.px) * alpha;
        const z = s.pz + (s.z - s.pz) * alpha;
        s.n.pivot.rotation.set(s.base.x + x, s.base.y, s.base.z + z);
      }
    },
    kick(k) {
      for (const s of st) {
        s.vx -= s.t.kick * k;
        s.vz += s.t.kick * k * 0.4 * Math.sin(s.phase);
      }
    },
  };
}

/** Insert a pivot group at the world point `at` (in `mesh`'s parent, same
    orientation as the parent) and re-hang the mesh under it, world
    transform unchanged. */
export function pivotMesh(mesh: THREE.Object3D, at: THREE.Vector3, name: string): THREE.Group | null {
  const parent = mesh.parent;
  if (!parent) return null;
  parent.updateWorldMatrix(true, true);
  const pivot = new THREE.Group();
  pivot.name = name;
  pivot.position.copy(parent.worldToLocal(at.clone()));
  parent.add(pivot);
  pivot.updateMatrixWorld(true);
  pivot.attach(mesh);
  return pivot;
}
