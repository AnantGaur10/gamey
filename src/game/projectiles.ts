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
// Standing capsule: head sphere at y+1.9 r=0.34, body segment y 0.9..1.55
// r=0.62. Radii match the old screen-space test so TTK/feel is unchanged —
// only the sampling path is now ballistic. Wounded poses shift the capsule
// with the visual (wound poses are group-level, so the offsets below mirror
// the pose targets in home.ts). Prone is a vertical-capsule approximation of
// a horizontal body — honest stopgap until per-bone attribution lands.
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
}

/** Hitbox per wound pose. `none` = standing capsule above. */
export const CAPSULE_FOR_POSE: Record<WoundPose, CapsuleProfile> = {
  none: { headY: 1.9, bodyLoY: 0.9, bodyHiY: 1.55 },
  bend: { headY: 1.68, bodyLoY: 0.75, bodyHiY: 1.42 },
  crouch: { headY: 1.32, bodyLoY: 0.5, bodyHiY: 1.12 },
  prone: { headY: 0.55, bodyLoY: 0.08, bodyHiY: 0.72 },
};

export function capsuleMid(cap: CapsuleProfile): number {
  return (cap.bodyLoY + cap.bodyHiY) / 2;
}

export function testCapsuleHit(
  pos: [number, number, number],
  targetFeet: { x: number; y: number; z: number },
  cap: CapsuleProfile = CAPSULE_FOR_POSE.none,
): { head: boolean; body: boolean; point: [number, number, number] } {
  const [px, py, pz] = pos;
  const hx = targetFeet.x, hy = targetFeet.y + cap.headY, hz = targetFeet.z;
  const dh2 = (px - hx) * (px - hx) + (py - hy) * (py - hy) + (pz - hz) * (pz - hz);
  if (dh2 <= 0.34 * 0.34) return { head: true, body: false, point: [px, py, pz] };
  const d2 = distPointSegment2(px, py, pz, targetFeet.x, targetFeet.y + cap.bodyLoY, targetFeet.z, targetFeet.x, targetFeet.y + cap.bodyHiY, targetFeet.z);
  if (d2 <= 0.62 * 0.62) return { head: false, body: true, point: [px, py, pz] };
  return { head: false, body: false, point: [px, py, pz] };
}
