// True projectiles + capsule hitboxes (Phase-2 Slice 1).
// Pure logic: no render, no net, no SDK imports. Seeded, fixed-60Hz,
// net-ready — emits over the existing Fire/Hit envelope via LocalTransport.
// Damage/falloff/TTK/cooldowns untouched (damage.ts / economy.ts own those).
import type * as THREE from "three";
import type { WoundPose } from "./DuelMachine";

export interface BulletState {
  alive: boolean;
  pos: [number, number, number];
  vel: [number, number, number];
  age: number;
  life: number;
  shooter: "player" | "foe";
  gunId: string;
  lethal: boolean; // fired while lethal-if-it-hits (double-KO rule input)
}

export const BULLET_SPEED = 110; // m/s — 2x snappy: crosses 9-14m in ~0.1s, still visible + dodgeable
export const BULLET_GRAVITY = 1.6; // slight drop, keeps long shots honest
const POOL = 8;

function makeDead(): BulletState {
  return { alive: false, pos: [0, -99, 0], vel: [0, 0, 0], age: 0, life: 0, shooter: "player", gunId: "default", lethal: false };
}

export class ProjectileSim {
  bullets: BulletState[] = Array.from({ length: POOL }, makeDead);

  fire(opts: {
    from: { x: number; y: number; z: number };
    dir: { x: number; y: number; z: number };
    distM: number;
    shooter: BulletState["shooter"];
    gunId: string;
    lethal: boolean;
  }): BulletState | null {
    const b = this.bullets.find((x) => !x.alive);
    if (!b) return null;
    const len = Math.hypot(opts.dir.x, opts.dir.y, opts.dir.z) || 1;
    b.alive = true;
    b.pos = [opts.from.x, opts.from.y, opts.from.z];
    b.vel = [(opts.dir.x / len) * BULLET_SPEED, (opts.dir.y / len) * BULLET_SPEED, (opts.dir.z / len) * BULLET_SPEED];
    b.age = 0;
    b.life = opts.distM / BULLET_SPEED + 1.0;
    b.shooter = opts.shooter;
    b.gunId = opts.gunId;
    b.lethal = opts.lethal;
    return b;
  }

  /** Fixed-step integrate. Returns bullets that expired this step. */
  step(dt: number): BulletState[] {
    const expired: BulletState[] = [];
    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.age += dt;
      b.vel[1] -= BULLET_GRAVITY * dt;
      b.pos[0] += b.vel[0] * dt;
      b.pos[1] += b.vel[1] * dt;
      b.pos[2] += b.vel[2] * dt;
      if (b.age >= b.life || b.pos[1] < -1) {
        b.alive = false;
        expired.push(b);
      }
    }
    return expired;
  }

  kill(b: BulletState): void {
    b.alive = false;
  }
}

// --- capsule hit test (sphere-vs-segment, world space) ---
// Standing capsule: head sphere at y+1.9, body segment y 0.9..1.55 r=0.62
// (the body radius matches the old screen-space test, so body TTK/feel is
// unchanged). Wounded poses shift the capsule with the visual (wound poses
// are group-level, so the offsets below mirror the pose targets in home.ts;
// the visible head sits within 3cm of headY in none/crouch/prone). Prone is
// a vertical-capsule approximation of a horizontal body — honest stopgap
// until per-bone attribution lands.
//
// Head priority (2026-10-21): the body capsule's top cap bulges to y 2.17
// and ~0.5m in front of the face, and bullets are sampled every ~23cm, so a
// head-bound bullet was usually sampled inside it first: 84% of dead-centre
// head shots and every chin shot scored as body hits. Upright poses now ask
// whether the line of fire crosses the head (or hat) within the target once
// it enters the body: the old screen-space test also checked the head first
// along the whole line. The upright head sphere is the visible head (0.40 x
// 0.34m box, r 0.25: collar and shoulder tops stay body); prone keeps the
// old r 0.34 per-sample rule.
function distPointSegment2(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
): number {
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const t = Math.min(1, Math.max(0, ((px - ax) * abx + (py - ay) * aby + (pz - az) * abz) / (abx * abx + aby * aby + abz * abz || 1)));
  const dx = px - (ax + abx * t), dy = py - (ay + aby * t), dz = pz - (az + abz * t);
  return dx * dx + dy * dy + dz * dz;
}

export interface CapsuleProfile {
  headY: number;
  bodyLoY: number;
  bodyHiY: number;
  headR: number;
  /** Hat + head priority along the line of fire (not prone). */
  upright: boolean;
}

/** Hitbox per wound pose. `none` = standing capsule above. */
export const CAPSULE_FOR_POSE: Record<WoundPose, CapsuleProfile> = {
  none: { headY: 1.9, bodyLoY: 0.9, bodyHiY: 1.55, headR: 0.25, upright: true },
  bend: { headY: 1.68, bodyLoY: 0.75, bodyHiY: 1.42, headR: 0.25, upright: true },
  crouch: { headY: 1.32, bodyLoY: 0.5, bodyHiY: 1.12, headR: 0.25, upright: true },
  prone: { headY: 0.55, bodyLoY: 0.08, bodyHiY: 0.72, headR: 0.34, upright: false },
};

/** How far past a body contact the line of fire is searched for the head:
    from the body's front (<= 0.62m before the axis) to past the widest
    brim behind it. */
const HEAD_LOOKAHEAD_M = 1.3;
const HEAD_LOOKAHEAD_STEP_M = 0.02;

export function capsuleMid(cap: CapsuleProfile): number {
  return (cap.bodyLoY + cap.bodyHiY) / 2;
}

/** A hat as a solid of revolution on the head axis: radius per `step`-tall
    band from `y0`, both relative to the head centre (`headY`), so it rides
    every upright pose. Measured off each rig's hat mesh (cowboyGlb.ts):
    the 0.34 head sphere stops at +0.34, under every crown (outlaw +0.49,
    top hat +0.72), and brim edges past ~0.3 fell to the body capsule, so
    shots through the hat read as misses or body hits (user 2026-10-21). */
export interface HatProfile {
  y0: number;
  step: number;
  r: number[];
}

/** Outlaw hat (procedural stand-in, before / without its GLB). */
export const DEFAULT_HAT: HatProfile = {
  y0: 0.12, step: 0.04,
  r: [0.381, 0.381, 0.183, 0.18, 0.176, 0.177, 0.178, 0.18, 0.167, 0.11],
};

/** Head sphere, or (upright) the hat, which counts as the head. */
function inHead(
  px: number, py: number, pz: number,
  feet: { x: number; y: number; z: number },
  cap: CapsuleProfile,
  hat: HatProfile | null | undefined,
): boolean {
  const dx = px - feet.x, dy = py - feet.y - cap.headY, dz = pz - feet.z;
  if (dx * dx + dy * dy + dz * dz <= cap.headR * cap.headR) return true;
  if (!hat || !cap.upright) return false;
  const i = Math.floor((dy - hat.y0) / hat.step);
  const r = i >= 0 && i < hat.r.length ? hat.r[i] : 0;
  return dx * dx + dz * dz <= r * r;
}

/** `dir` (the bullet's velocity, any length) turns on head priority along
    the line of fire for upright poses; without it, per-sample only. */
export function testCapsuleHit(
  pos: [number, number, number],
  targetFeet: { x: number; y: number; z: number },
  cap: CapsuleProfile = CAPSULE_FOR_POSE.none,
  hat?: HatProfile | null,
  dir?: [number, number, number],
): { head: boolean; body: boolean; point: [number, number, number] } {
  const [px, py, pz] = pos;
  if (inHead(px, py, pz, targetFeet, cap, hat)) return { head: true, body: false, point: [px, py, pz] };
  const d2 = distPointSegment2(px, py, pz, targetFeet.x, targetFeet.y + cap.bodyLoY, targetFeet.z, targetFeet.x, targetFeet.y + cap.bodyHiY, targetFeet.z);
  if (d2 > 0.62 * 0.62) return { head: false, body: false, point: [px, py, pz] };
  const len = dir ? Math.hypot(dir[0], dir[1], dir[2]) : 0;
  if (cap.upright && len > 0) {
    const ux = dir![0] / len, uy = dir![1] / len, uz = dir![2] / len;
    for (let s = HEAD_LOOKAHEAD_STEP_M; s <= HEAD_LOOKAHEAD_M; s += HEAD_LOOKAHEAD_STEP_M) {
      const qx = px + ux * s, qy = py + uy * s, qz = pz + uz * s;
      if (inHead(qx, qy, qz, targetFeet, cap, hat)) return { head: true, body: false, point: [qx, qy, qz] };
    }
  }
  return { head: false, body: true, point: [px, py, pz] };
}

/** What a bullet fired now would hit if the target holds still: the live
    sim's integrator, substep and hit test on a scratch bullet. Fire-time
    lethality (double-KO rule) reads it, so "aimed at the head" means the
    same head + hat zone the hit test scores. */
export function predictHit(
  from: { x: number; y: number; z: number },
  dir: { x: number; y: number; z: number },
  distM: number,
  targetFeet: { x: number; y: number; z: number },
  cap: CapsuleProfile,
  hat: HatProfile | null | undefined,
  substepDt: number,
): "head" | "body" | null {
  const sim = new ProjectileSim();
  const b = sim.fire({ from, dir, distM, shooter: "player", gunId: "default", lethal: false })!;
  while (b.alive) {
    sim.step(substepDt);
    if (!b.alive) break;
    const r = testCapsuleHit(b.pos, targetFeet, cap, hat, b.vel);
    if (r.head) return "head";
    if (r.body) return "body";
  }
  return null;
}
