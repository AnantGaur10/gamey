// Articulated hit-point ragdoll (cannon-es): one body per body part,
// floppy limbs via point-to-point joint constraints — crumples, never planks.
// While dueling the bodies are kinematic shadows of the live pose (exact
// takeover point on death); on Hit they go dynamic + impulse at the hit
// point + joints form, then sleep + cull after settle for mobile perf.
// Null-safe throughout: missing parts are skipped, any physics failure
// falls back to setFall tip-over (caller owns the fallback policy).
import * as CANNON from "cannon-es";
import * as THREE from "three";

export interface Ragdoll {
  hit(worldPoint: THREE.Vector3, dir: THREE.Vector3, power: number): void;
  /** Kinematic shadow of the live pose. Call every frame while !fallen. */
  follow(): void;
  /** ONE fixed physics step of `h` seconds (call from the shared fixed-step
      loop, game/fixedStep.ts — never per rendered frame). No-op until hit. */
  fixedStep(h: number): void;
  /** Write the render pose: interpolate the last two physics states by
      `alpha` in [0,1] (alpha = accumulator/step). Per rendered frame. */
  sync(alpha?: number): void;
  dispose(): void;
  readonly fallen: boolean;
  /** Physics body centers (diagnostics: separates sim motion from sync). */
  bodies?(): Array<[number, number, number]>;
  /** Per-joint world gap between the two pivots (0 = joint holds). */
  jointErrors?(): Record<string, number>;
}

export interface RagdollParts {
  pelvis: THREE.Object3D | null;
  torso: THREE.Object3D | null;
  head: THREE.Object3D | null;
  upperArmL: THREE.Object3D | null;
  upperArmR: THREE.Object3D | null;
  thighL: THREE.Object3D | null;
  thighR: THREE.Object3D | null;
  shinL?: THREE.Object3D | null;
  shinR?: THREE.Object3D | null;
  forearmR?: THREE.Object3D | null;
}

// Topple assist: torque (N*m, linearly decaying) on torso+pelvis for this long.
const TOPPLE_TIME = 0.7;
const TOPPLE_TORQUE = 9;

const GUN_POWER: Record<string, number> = { default: 9, lifesteal: 7, gold: 7 };

// [part key, mass]
const DEFS: Array<[keyof RagdollParts, number]> = [
  ["pelvis", 4],
  ["torso", 5],
  ["head", 2],
  ["upperArmL", 1.5],
  ["upperArmR", 1.5],
  ["thighL", 3],
  ["thighR", 3],
  ["shinL", 2],
  ["shinR", 2],
  ["forearmR", 1.2],
];

// Parts whose collision box is sized from specific meshes only (name match;
// falls back to all meshes when nothing matches, e.g. the procedural rig).
const BODY_MESH_FILTER: Partial<Record<keyof RagdollParts, RegExp>> = {
  forearmR: /fore|hand/i,
};

/** ConeTwist whose twist reference is fixed at creation. Stock cannon-es
    derives each body's twist reference from its LOCAL cone axis
    (axis.tangents(), then to world), so two bodies that are not identically
    oriented at death (raised arm vs torso, bent forearm vs upper arm) start
    with references up to ~90 deg apart: the twist limit is violated from the
    first step and its 1e6 max-force correction tears the point joint
    (elbow pivots measured 0.3-0.55m apart; knees, formed between aligned
    bodies, held at 0.001). Here one world reference perpendicular to the limb
    axis is stored in each body's local frame, so twist starts at exactly 0.
    The reference is the character's lateral axis (parent body local X: both
    rigs are built with X = left/right): cannon measures twist as the angle
    between the two references, so a reference lying in the bend plane would
    read a plain knee/elbow fold as twist (tried: knees tore to 0.24). The
    lateral axis is the hinge of the dominant folds and does not tilt. */
class RagdollJoint extends CANNON.ConeTwistConstraint {
  private readonly refA: CANNON.Vec3;
  private readonly refB: CANNON.Vec3;
  constructor(a: CANNON.Body, b: CANNON.Body, opts: ConstructorParameters<typeof CANNON.ConeTwistConstraint>[2], worldAxis: CANNON.Vec3) {
    super(a, b, opts);
    const ref = a.quaternion.vmult(new CANNON.Vec3(1, 0, 0));
    ref.vsub(worldAxis.scale(ref.dot(worldAxis)), ref);
    if (ref.length() < 0.3) {
      // Limb runs along the lateral axis (arm held out sideways): any
      // perpendicular works, use cannon's own tangent rule on the world axis.
      const t1 = new CANNON.Vec3();
      worldAxis.tangents(t1, ref);
    }
    ref.normalize();
    this.refA = a.quaternion.inverse().vmult(ref);
    this.refB = b.quaternion.inverse().vmult(ref);
  }
  update(): void {
    super.update();
    this.bodyA.vectorToWorldFrame(this.refA, this.twistEquation.axisA);
    this.bodyB.vectorToWorldFrame(this.refB, this.twistEquation.axisB);
  }
}

// Joints formed at death. `pivot`: "mid" = midpoint of the two body centres;
// "child" = the child part's own origin (knee = Shin origin, elbow = elbowR
// origin, so the hinge sits on the real joint). `cone` = max bend (rad) of the
// child limb away from the parent limb; `twist` = max twist (rad). Unlimited
// point-to-point joints let limbs fold through impossible angles.
interface JointSpec { a: keyof RagdollParts; b: keyof RagdollParts; pivot: "mid" | "child"; cone: number; twist: number }
const JOINTS: JointSpec[] = [
  { a: "pelvis", b: "torso", pivot: "mid", cone: 1.45, twist: 0.6 },
  { a: "torso", b: "head", pivot: "mid", cone: 0.9, twist: 0.7 },
  { a: "torso", b: "upperArmL", pivot: "mid", cone: 1.6, twist: 0.8 },
  { a: "torso", b: "upperArmR", pivot: "mid", cone: 1.6, twist: 0.8 },
  { a: "pelvis", b: "thighL", pivot: "mid", cone: 1.6, twist: 0.6 },
  { a: "pelvis", b: "thighR", pivot: "mid", cone: 1.6, twist: 0.6 },
  { a: "thighL", b: "shinL", pivot: "child", cone: 1.5, twist: 1.0 },
  { a: "thighR", b: "shinR", pivot: "child", cone: 1.5, twist: 1.0 },
  { a: "upperArmR", b: "forearmR", pivot: "child", cone: 1.6, twist: 1.2 },
];

interface Part {
  key: keyof RagdollParts;
  obj: THREE.Object3D;
  body: CANNON.Body;
  /** Pivot -> box-centre offset in obj-local axes (world-scaled). Bodies sit
      on the GEOMETRY centre, not the joint pivot (thighs pivot at the hip). */
  off: THREE.Vector3;
  /** Previous/latest physics pose (taken after each fixed step) for render
      interpolation: rendering must never depend on how many frames fit. */
  prevP: THREE.Vector3; currP: THREE.Vector3;
  prevQ: THREE.Quaternion; currQ: THREE.Quaternion;
}

const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _m1 = new THREE.Matrix4();

/**
 * AABB of a part's OWN geometry in its local frame (world-scaled), skipping
 * descendants that are themselves ragdoll parts. Box3.setFromObject swallowed
 * the whole subtree: pelvis > legs/waist > torso > head made the pelvis box
 * ~body-sized, so the corpse rested at half-body height (pelvis y~0.7-1.0,
 * hovering) instead of lying on the dirt.
 */
function ownBox(
  obj: THREE.Object3D,
  all: Set<THREE.Object3D>,
  only?: RegExp,
): { center: THREE.Vector3; half: THREE.Vector3 } | null {
  obj.updateWorldMatrix(true, true);
  const inv = new THREE.Matrix4().copy(obj.matrixWorld).invert();
  const sc = new THREE.Vector3();
  obj.matrixWorld.decompose(new THREE.Vector3(), new THREE.Quaternion(), sc);
  const box = new THREE.Box3();
  let any = false;
  const visit = (o: THREE.Object3D): void => {
    if (o !== obj && all.has(o)) return;
    if (!o.visible) return;
    const m = o as THREE.Mesh;
    if (m.isMesh && m.geometry && (!only || only.test(o.name))) {
      if (!m.geometry.boundingBox) m.geometry.computeBoundingBox();
      const gb = m.geometry.boundingBox!.clone().applyMatrix4(_m1.multiplyMatrices(inv, m.matrixWorld));
      box.union(gb);
      any = true;
    }
    for (const c of o.children) visit(c);
  };
  visit(obj);
  if (!any || box.isEmpty()) return null;
  const center = box.getCenter(new THREE.Vector3()).multiply(sc);
  const half = box.getSize(new THREE.Vector3()).multiply(sc).multiplyScalar(0.5);
  half.set(Math.abs(half.x), Math.abs(half.y), Math.abs(half.z));
  return { center, half };
}

/** Lowest allowed centre Y for an oriented box so it never starts in the ground. */
function groundClearance(q: THREE.Quaternion, h: CANNON.Vec3): number {
  const e = _m1.makeRotationFromQuaternion(q).elements; // row 1 = e[1], e[5], e[9]
  return Math.abs(e[1]) * h.x + Math.abs(e[5]) * h.y + Math.abs(e[9]) * h.z + 0.02;
}

/**
 * Bind every loose accessory mesh (hat, eyes, pads, belt, boots, bullets…)
 * to its nearest ragdoll part. `attach` preserves world transforms exactly,
 * so visuals are pixel-identical during life — but on death every detail
 * rides its body part down instead of freezing mid-air. Meshes already
 * inside a part's subtree (gun under elbowR, hand in armL) are skipped.
 * Null-safe: any failure leaves the hierarchy exactly as it was.
 */
export function bindAccessories(group: THREE.Group, parts: RagdollParts): void {
  try {
    group.updateMatrixWorld(true);
    const partObjs = (Object.values(parts) as Array<THREE.Object3D | null>).filter(
      (o): o is THREE.Object3D => !!o,
    );
    if (partObjs.length === 0) return;
    const inSubtree = (root: THREE.Object3D, o: THREE.Object3D): boolean => {
      let p = o.parent;
      while (p) {
        if (p === root) return true;
        p = p.parent;
      }
      return false;
    };
    const meshes: THREE.Mesh[] = [];
    group.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
    });
    for (const m of meshes) {
      if (partObjs.includes(m)) continue;
      if (partObjs.some((p) => inSubtree(p, m))) continue;
      m.updateWorldMatrix(true, false);
      _v1.setFromMatrixPosition(m.matrixWorld);
      let best: THREE.Object3D | null = null;
      let bd = Infinity;
      for (const p of partObjs) {
        p.updateWorldMatrix(true, false);
        _v3.setFromMatrixPosition(p.matrixWorld);
        const d = _v1.distanceToSquared(_v3);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) best.attach(m);
    }
    group.updateMatrixWorld(true);
  } catch {
    /* hierarchy untouched on failure — same as today */
  }
}

export function createRagdoll(
  _scene: THREE.Scene,
  parts: RagdollParts,
  gunId = "default",
): Ragdoll | null {
  try {
    const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
    world.allowSleep = true;
    // Stiff joints: the default 10 solver iterations let sharp impulses
    // stretch point-to-point joints apart (scattered corpses). 25 keeps the
    // chain together through the impact transient; 10 bodies stay cheap.
    (world.solver as CANNON.GSSolver).iterations = 30;
    world.addBody(
      (() => {
        const ground = new CANNON.Body({ mass: 0, shape: new CANNON.Plane() });
        ground.quaternion.setFromAxisAngle(new CANNON.Vec3(1, 0, 0), -Math.PI / 2);
        // Collision layers: ground (group 1) collides with everything;
        // parts below collide ONLY with the ground (mask 1), never with
        // each other — self-collisions between overlapping jointed boxes
        // inject energy every step (verified: the clump jitter-climbed and
        // hovered at y≈3 instead of falling). Standard ragdoll practice.
        ground.collisionFilterGroup = 1;
        ground.collisionFilterMask = -1;
        return ground;
      })(),
    );

    const list: Part[] = [];
    const byKey = new Map<keyof RagdollParts, Part>();
    const partSet = new Set<THREE.Object3D>(
      (Object.values(parts) as Array<THREE.Object3D | null>).filter((o): o is THREE.Object3D => !!o),
    );
    DEFS.forEach(([key, mass], idx) => {
      const obj = parts[key];
      if (!obj) return;
      obj.updateWorldMatrix(true, false);
      _v1.setFromMatrixPosition(obj.matrixWorld);
      obj.getWorldQuaternion(_q1);
      // Physical size from the part's own geometry (see ownBox), shrunk to
      // 75%: full-size boxes of adjacent parts (pelvis/thighs, torso/arms)
      // interpenetrate at spawn, and cannon-es resolves deep penetration
      // with cannonball velocities on the first dynamic step (verified:
      // corpses launched ~7m skyward). Smaller boxes + the above-ground
      // clamp below keep depenetration pops tiny.
      // The gun rides the forearm part, but its barrel/cylinder/frame would make
      // a long heavy box that tears the elbow joint apart on ground contact
      // (forearm drifted 0.6-0.9m from the shoulder): size from forearm+hand.
      const own = (BODY_MESH_FILTER[key] ? ownBox(obj, partSet, BODY_MESH_FILTER[key]) : null) ?? ownBox(obj, partSet);
      const off = own ? own.center : new THREE.Vector3();
      const hx = Math.max(0.05, own ? own.half.x * 0.75 : 0.1);
      const hy = Math.max(0.05, own ? own.half.y * 0.75 : 0.1);
      const hz = Math.max(0.05, own ? own.half.z * 0.75 : 0.1);
      const body = new CANNON.Body({
        mass,
        shape: new CANNON.Box(new CANNON.Vec3(hx, hy, hz)),
        type: CANNON.Body.KINEMATIC,
        linearDamping: 0.4,
        angularDamping: 0.35,
        allowSleep: true,
        sleepSpeedLimit: 0.5,
        sleepTimeLimit: 0.5,
        // Own layer, ground-only mask: never collide with sibling parts
        // (see ground setup above). 2 << idx stays in-range up to idx 29.
        collisionFilterGroup: 2 << idx,
        collisionFilterMask: 1,
      });
      // Body sits on the geometry centre (pivot + rotated offset). Never
      // spawn intersecting the ground plane: a box starting 0.3m deep pops
      // the whole chain skyward when it goes dynamic. Feet stay planted
      // visually — follow() re-seats bodies every frame while alive.
      _v1.add(_v2.copy(off).applyQuaternion(_q1));
      body.position.set(_v1.x, Math.max(_v1.y, groundClearance(_q1, body.shapes[0] ? (body.shapes[0] as CANNON.Box).halfExtents : new CANNON.Vec3(hx, hy, hz))), _v1.z);
      body.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w);
      world.addBody(body);
      const p: Part = {
        key, obj, body, off,
        prevP: new THREE.Vector3(body.position.x, body.position.y, body.position.z), currP: new THREE.Vector3(body.position.x, body.position.y, body.position.z),
        prevQ: new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w), currQ: new THREE.Quaternion(body.quaternion.x, body.quaternion.y, body.quaternion.z, body.quaternion.w),
      };
      list.push(p);
      byKey.set(key, p);
    });
    if (list.length === 0) return null;

    let fallen = false;
    // prev <- curr, curr <- body (after a fixed step).
    const snap = (pt: Part): void => {
      pt.prevP.copy(pt.currP); pt.prevQ.copy(pt.currQ);
      pt.currP.set(pt.body.position.x, pt.body.position.y, pt.body.position.z);
      pt.currQ.set(pt.body.quaternion.x, pt.body.quaternion.y, pt.body.quaternion.z, pt.body.quaternion.w);
    };
    // prev = curr = body (pose set directly: follow(), start of hit()) so the
    // first interpolated frame never blends from a stale pose.
    const resetSnap = (pt: Part): void => {
      pt.currP.set(pt.body.position.x, pt.body.position.y, pt.body.position.z);
      pt.currQ.set(pt.body.quaternion.x, pt.body.quaternion.y, pt.body.quaternion.z, pt.body.quaternion.w);
      pt.prevP.copy(pt.currP); pt.prevQ.copy(pt.currQ);
    };
    // Decaying topple torque (set on hit): with limited joints a corpse can
    // settle kneeling/sitting on its heels; this carries the fall to the dirt.
    let toppleT = 0;
    const toppleAxis = new CANNON.Vec3(0, 0, 0);
    const constraints: CANNON.Constraint[] = [];

    function follow(): void {
      if (fallen) return;
      for (const p of list) {
        p.obj.updateWorldMatrix(true, false);
        _v1.setFromMatrixPosition(p.obj.matrixWorld);
        p.obj.getWorldQuaternion(_q1);
        _v1.add(_v2.copy(p.off).applyQuaternion(_q1));
        // Same above-ground clamp as creation (see above): bodies must be
        // penetration-free on the exact frame they go dynamic.
        const half = (p.body.shapes[0] as CANNON.Box).halfExtents;
        p.body.position.set(_v1.x, Math.max(_v1.y, groundClearance(_q1, half)), _v1.z);
        p.body.quaternion.set(_q1.x, _q1.y, _q1.z, _q1.w);
        p.body.velocity.setZero();
        p.body.angularVelocity.setZero();
        resetSnap(p);
      }
    }

    function hit(worldPoint: THREE.Vector3, dir: THREE.Vector3, power: number): void {
      // Re-seat every body on the live pose first. hit() runs inside the fixed
      // step, before this frame's follow(), so the bodies were a frame stale
      // while the "child" joint pivots below read the live obj origins: any
      // arm motion that frame (aim chase, flinch) spawned the elbow joint
      // pre-stretched and the solver yanked it apart (shoulder->elbow up to
      // 0.79 vs 0.34 rest). follow() also resets the interpolation snapshots.
      follow();
      fallen = true;
      toppleT = TOPPLE_TIME;
      toppleAxis.set(dir.z, 0, -dir.x);
      const p = GUN_POWER[gunId] ?? 8;
      const scale = (power || p) / p;
      const yaw = Math.sin(worldPoint.x * 12.9898 + worldPoint.z * 78.233) * 0.45;
      for (const pt of list) {
        pt.body.type = CANNON.Body.DYNAMIC;
        pt.body.wakeUp();
        // Gentle directional shove only — corpses must crumple within ~1m,
        // not launch out of frame (especially toward the chase camera).
        // The focal impulse below carries the hit-point reaction.
        pt.body.velocity.set(dir.x * 0.5 * scale, 0.25 * scale, dir.z * 0.5 * scale);
        // Coherent topple along the shot (axis = up x dir) plus a small
        // deterministic yaw from the hit point — the whole body falls over as
        // one and the (now limited) joints fold it, instead of 10 parts each
        // spinning a random way and cartwheeling (Math.random made every
        // corpse different and chaotic; this is reproducible per hit).
        pt.body.angularVelocity.set(dir.z * 2.2 * scale, yaw, -dir.x * 2.2 * scale);
      }
      // Focal impulse on the body nearest the hit point. cannon-es takes
      // the application point RELATIVE TO THE BODY CENTER (world-oriented),
      // NOT a world position: passing world coords directly inflates the
      // lever arm ~20x and flings parts apart (starfish corpses).
      let best = list[0].body;
      let bd = Infinity;
      const hp = new CANNON.Vec3(worldPoint.x, worldPoint.y, worldPoint.z);
      for (const pt of list) {
        const d = pt.body.position.vsub(hp).length();
        if (d < bd) { bd = d; best = pt.body; }
      }
      const rel = new CANNON.Vec3(hp.x - best.position.x, hp.y - best.position.y, hp.z - best.position.z);
      // Scaled to crumple, not launch: full power flings bodies meters out
      // of frame (verified: corpses vanished behind the chase camera, and
      // headshots juggled parts skyward). The up-bias stays small so kills
      // read as knocked down/back, never juggled.
      const k = 0.55;
      best.applyImpulse(new CANNON.Vec3(dir.x * p * scale * k, 0.9 * scale * k, dir.z * p * scale * k), rel);
      // Form joints from the live pose. ConeTwist = point joint + a cone limit
      // on how far the child limb may bend away from the parent limb. Axes are
      // the limb direction at death, expressed in each body's local frame
      // (both start aligned, so a wounded/kneeling pose starts inside limits).
      for (const j of JOINTS) {
        const a = byKey.get(j.a);
        const b = byKey.get(j.b);
        if (!a || !b) continue;
        let jx: number, jy: number, jz: number;
        if (j.pivot === "child") {
          b.obj.updateWorldMatrix(true, false);
          _v1.setFromMatrixPosition(b.obj.matrixWorld);
          jx = _v1.x; jy = _v1.y; jz = _v1.z;
        } else {
          jx = (a.body.position.x + b.body.position.x) / 2;
          jy = (a.body.position.y + b.body.position.y) / 2;
          jz = (a.body.position.z + b.body.position.z) / 2;
        }
        // limb axis: parent centre -> child centre (fallback straight down)
        const ax = new CANNON.Vec3(b.body.position.x - a.body.position.x, b.body.position.y - a.body.position.y, b.body.position.z - a.body.position.z);
        if (ax.length() < 1e-4) ax.set(0, -1, 0); else ax.normalize();
        const axA = a.body.quaternion.inverse().vmult(ax);
        const axB = b.body.quaternion.inverse().vmult(ax);
        const c = new RagdollJoint(a.body, b.body, {
          // cannon pivots are in each body's LOCAL frame (world offsets were
          // only right for upright bodies — a rotated/offset part, like the
          // forearm+gun box, ended up with its joint far from the elbow).
          pivotA: a.body.quaternion.inverse().vmult(new CANNON.Vec3(jx - a.body.position.x, jy - a.body.position.y, jz - a.body.position.z)),
          pivotB: b.body.quaternion.inverse().vmult(new CANNON.Vec3(jx - b.body.position.x, jy - b.body.position.y, jz - b.body.position.z)),
          axisA: axA,
          axisB: axB,
          angle: j.cone,
          twistAngle: j.twist,
          collideConnected: false,
        }, ax);
        constraints.push(c);
        world.addConstraint(c);
      }
    }

    function fixedStep(h: number): void {
      if (!fallen) return;
      if (toppleT > 0) {
        const k = TOPPLE_TORQUE * (toppleT / TOPPLE_TIME);
        for (const key of ["torso", "pelvis"] as const) {
          const t = byKey.get(key);
          if (t) { t.body.torque.x += toppleAxis.x * k; t.body.torque.z += toppleAxis.z * k; }
        }
        toppleT -= h;
      }
      world.step(h);
      for (const pt of list) snap(pt);
    }

    function sync(alpha = 1): void {
      if (!fallen) return;
      const a = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
      for (const pt of list) {
        _q2.copy(pt.prevQ).slerp(pt.currQ, a);
        // Body is on the geometry centre; the obj pivot is back along -off.
        _v3.copy(pt.off).applyQuaternion(_q2);
        _v1.copy(pt.prevP).lerp(pt.currP, a);
        _v2.set(_v1.x - _v3.x, _v1.y - _v3.y, _v1.z - _v3.z);
        const parent = pt.obj.parent;
        if (!parent) {
          pt.obj.position.copy(_v2);
          pt.obj.quaternion.copy(_q2);
          continue;
        }
        parent.updateWorldMatrix(true, false);
        parent.worldToLocal(_v2);
        pt.obj.position.copy(_v2);
        parent.getWorldQuaternion(_q1).invert();
        pt.obj.quaternion.copy(_q1.multiply(_q2));
      }
    }

    function dispose(): void {
      for (const c of constraints) world.removeConstraint(c);
      constraints.length = 0;
      for (const pt of list) world.removeBody(pt.body);
      const ground = world.bodies.find((b) => b.mass === 0);
      if (ground) world.removeBody(ground);
    }

    return {
      get fallen() { return fallen; },
      hit, follow, fixedStep, sync, dispose,
      bodies: () => list.map((pt) => [pt.body.position.x, pt.body.position.y, pt.body.position.z] as [number, number, number]),
      jointErrors: () => {
        const out: Record<string, number> = {};
        constraints.forEach((c, i) => {
          const pc = c as CANNON.PointToPointConstraint;
          const j = JOINTS.filter((s) => byKey.get(s.a) && byKey.get(s.b))[i];
          const wa = pc.bodyA.position.vadd(pc.bodyA.quaternion.vmult(pc.pivotA));
          const wb = pc.bodyB.position.vadd(pc.bodyB.quaternion.vmult(pc.pivotB));
          out[j ? `${j.a}-${j.b}` : String(i)] = +wa.vsub(wb).length().toFixed(3);
        });
        return out;
      },
    };
  } catch {
    return null;
  }
}
