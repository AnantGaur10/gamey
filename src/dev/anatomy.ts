// DEV anatomy check (user 2026-11-02: "make sure all limbs are contiguous and
// correct"): for each joint, the gap in metres between the two body parts it
// joins (0 = they touch or overlap), measured on the live pose. Each part is
// its merged mesh's box in its own frame; the gap is the smallest distance
// from points sampled over one box's surface to the other box, both ways.
import * as THREE from "three";

/** Joint -> [parent part, child part] (node names without the rig prefix). */
export const JOINTS: Record<string, [string, string]> = {
  neck: ["Torso", "Head"],
  waist: ["Pelvis", "Torso"],
  shoulderL: ["Torso", "Sleeve_L"],
  shoulderR: ["Torso", "Sleeve_R"],
  elbowR: ["Sleeve_R", "Fore_R"],
  wristR: ["Fore_R", "Frame"],
  hipL: ["Pelvis", "Leg_L"],
  hipR: ["Pelvis", "Leg_R"],
  kneeL: ["Leg_L", "Shin_L"],
  kneeR: ["Leg_R", "Shin_R"],
};

const N = 6; // samples per face edge
const _inv = new THREE.Matrix4();
const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();

function boxOf(o: THREE.Object3D): THREE.Box3 | null {
  const g = (o as THREE.Mesh).geometry;
  if (!g) return null;
  if (!g.boundingBox) g.computeBoundingBox();
  return g.boundingBox;
}

/** Smallest distance from `a`'s box surface (sampled) to `b`'s box. */
function oneWay(a: THREE.Object3D, ba: THREE.Box3, b: THREE.Object3D, bb: THREE.Box3): number {
  _inv.copy(b.matrixWorld).invert();
  _m.multiplyMatrices(_inv, a.matrixWorld); // a-local -> b-local
  let best = Infinity;
  const { min, max } = ba;
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [0, 1]) {
      for (let i = 0; i <= N; i++) {
        for (let j = 0; j <= N; j++) {
          const u = i / N, v = j / N;
          const c = [0, 0, 0];
          const o1 = (axis + 1) % 3, o2 = (axis + 2) % 3;
          c[axis] = side ? max.getComponent(axis) : min.getComponent(axis);
          c[o1] = min.getComponent(o1) + u * (max.getComponent(o1) - min.getComponent(o1));
          c[o2] = min.getComponent(o2) + v * (max.getComponent(o2) - min.getComponent(o2));
          _p.set(c[0], c[1], c[2]).applyMatrix4(_m);
          const d = bb.distanceToPoint(_p) * b.matrixWorld.getMaxScaleOnAxis();
          if (d < best) best = d;
          if (best === 0) return 0;
        }
      }
    }
  }
  return best;
}

/** Gap per joint (metres, 3 decimals); null when a part is missing on this rig. */
export function limbGaps(root: THREE.Object3D, prefix: string): Record<string, number | null> {
  root.updateWorldMatrix(true, true);
  const out: Record<string, number | null> = {};
  for (const [joint, [pa, pb]] of Object.entries(JOINTS)) {
    const a = root.getObjectByName(`${prefix}_${pa}`);
    const b = root.getObjectByName(`${prefix}_${pb}`);
    const ba = a && boxOf(a), bb = b && boxOf(b);
    if (!a || !b || !ba || !bb) { out[joint] = null; continue; }
    out[joint] = +Math.min(oneWay(a, ba, b, bb), oneWay(b, bb, a, ba)).toFixed(3);
  }
  return out;
}

/** Signed flexion (degrees) at the gun elbow and both knees: + = the way a
    human joint bends (elbow: forearm toward the front; knee: shin toward the
    back), - = hyperextended / bent backwards. From the rig's own pivots and
    the body's facing (group +Z after the GLB's PI yaw; right = group -X). */
export function bendAngles(group: THREE.Object3D, prefix: string): Record<string, number | null> {
  group.updateWorldMatrix(true, true);
  const n = (k: string) => group.getObjectByName(`${prefix}_${k}`) ?? null;
  const w = (o: THREE.Object3D | null, x = 0, y = 0, z = 0) => (o ? o.localToWorld(new THREE.Vector3(x, y, z)) : null);
  const q = new THREE.Quaternion();
  group.getWorldQuaternion(q);
  const right = new THREE.Vector3(-1, 0, 0).applyQuaternion(q);
  /** Signed angle between segments a->b and b->c; sign from the bend axis vs the body's right. */
  const flex = (a: THREE.Vector3 | null, b: THREE.Vector3 | null, c: THREE.Vector3 | null, kneeLike: boolean): number | null => {
    if (!a || !b || !c) return null;
    const u = b.clone().sub(a).normalize(), v = c.clone().sub(b).normalize();
    const ang = Math.acos(Math.max(-1, Math.min(1, u.dot(v))));
    const axis = new THREE.Vector3().crossVectors(u, v);
    if (axis.lengthSq() < 1e-8) return 0;
    // Elbow flexion turns the forearm forward: (upper x fore) . right > 0.
    // Knee flexion turns the shin back: (thigh x shin) . right < 0.
    const s = Math.sign(axis.dot(right)) * (kneeLike ? -1 : 1);
    return +((s * ang * 180) / Math.PI).toFixed(1);
  };
  const leg = (side: "L" | "R") => {
    const thigh = n(`Leg_${side}`), shin = n(`Shin_${side}`);
    return flex(w(thigh, 0, 0.28, 0), w(n(`Knee_${side}`)), w(shin, 0, -0.18, 0), true);
  };
  return {
    // What you SEE: shoulder pivot -> the upper arm mesh's lower end -> the
    // forearm mesh's lower end (the hand). Mesh boxes: sleeve centre 0.13
    // down its axis, half-length 0.21; forearm centre 0.13, lower end 0.215.
    elbowR: flex(w(n("armR")), w(n("Sleeve_R"), 0, -0.21, 0), w(n("Fore_R"), 0, -0.215, 0), false),
    kneeL: leg("L"),
    kneeR: leg("R"),
  };
}
