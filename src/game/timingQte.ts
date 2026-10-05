// Focus timing QTE (user ask 2026-10-05, replaces Space mashing): a needle
// ping-pongs across a bar; press while it sits in the gold zone. Every press
// moves the zone; a hit narrows it (and speeds the needle up), a miss widens
// it, so the skill is chaining as many hits as possible before DRAW. Pure + seeded: advanced
// only on the shared fixed clock (never per frame), judged at sub-tick time.

import { mulberry32 } from "./DuelMachine";

export type QteResult = "perfect" | "good" | "miss";

const TRAVERSE0_SEC = 0.48; // needle 0 -> 1 at the start
const TRAVERSE_MIN_SEC = 0.3;
const SPEEDUP_PER_HIT = 0.93; // traverse time multiplier per hit
const ZONE0 = 0.22; // zone width as a fraction of the bar
const ZONE_MIN = 0.08;
const ZONE_MAX = 0.32;
const ZONE_SHRINK_PER_HIT = 0.86;
const ZONE_GROW_PER_MISS = 1.18;
const PERFECT_FRAC = 0.3; // centre band of the zone that counts as perfect
const FREEZE_SEC = 0.12; // needle holds where it stopped (result readable)
// Every press respawns the zone AHEAD of the needle (along its travel,
// bounces included) at this distance: never under it, never a full lap away,
// so the 3s window fits many attempts (~8-10).
const SPAWN_AHEAD_MIN = 0.22;
const SPAWN_AHEAD_MAX = 0.55;

/** Bar position (0..1) after moving `d` from `p`, bouncing off both ends. */
function bounce(p: number, d: number): { pos: number; dir: 1 | -1 } {
  let x = p + d;
  let dir: 1 | -1 = d >= 0 ? 1 : -1;
  for (let i = 0; i < 8 && (x > 1 || x < 0); i++) {
    if (x > 1) { x = 2 - x; dir = -1; }
    else if (x < 0) { x = -x; dir = 1; }
  }
  return { pos: Math.min(1, Math.max(0, x)), dir };
}

export class TimingQte {
  /** Needle position 0..1 at the last fixed tick. */
  pos = 0;
  dir: 1 | -1 = 1;
  zoneC = 0.5;
  zoneW = ZONE0;
  traverseSec = TRAVERSE0_SEC;
  streak = 0;
  hits = 0;
  misses = 0;
  last: QteResult | null = null;
  private freezeLeft = 0;
  private respawn = false;
  private rng: () => number;

  constructor(seed: number) {
    this.rng = mulberry32(seed ^ 0x51ed);
    this.reset();
  }

  /** Back to the opening state (holster left early: everything restarts). */
  reset(): void {
    this.pos = 0;
    this.dir = 1;
    this.zoneW = ZONE0;
    this.traverseSec = TRAVERSE0_SEC;
    this.streak = 0;
    this.hits = 0;
    this.misses = 0;
    this.last = null;
    this.freezeLeft = 0;
    this.respawn = false;
    this.spawnZone();
  }

  get frozen(): boolean {
    return this.freezeLeft > 0;
  }

  get perfectW(): number {
    return this.zoneW * PERFECT_FRAC;
  }

  /** Fixed-clock step (caller: only while Focus is running). */
  advance(dtSec: number): void {
    if (this.freezeLeft > 0) {
      this.freezeLeft -= dtSec;
      if (this.freezeLeft <= 0 && this.respawn) {
        this.respawn = false;
        this.spawnZone();
      }
      return;
    }
    const b = bounce(this.pos, (this.dir * dtSec) / this.traverseSec);
    this.pos = b.pos;
    this.dir = b.dir;
  }

  /** Needle `extraSec` past the last tick (render + judge at sub-tick time,
      so what the player sees is what gets judged at any refresh rate). */
  peek(extraSec: number): number {
    if (this.freezeLeft > 0) return this.pos;
    return bounce(this.pos, (this.dir * Math.max(0, extraSec)) / this.traverseSec).pos;
  }

  /** Player pressed. null = ignored (needle still showing the last result). */
  press(extraSec: number): QteResult | null {
    if (this.freezeLeft > 0) return null;
    const p = this.peek(extraSec);
    const d = Math.abs(p - this.zoneC);
    const res: QteResult = d <= this.perfectW / 2 ? "perfect" : d <= this.zoneW / 2 ? "good" : "miss";
    this.pos = p;
    this.freezeLeft = FREEZE_SEC;
    this.last = res;
    if (res === "miss") {
      this.misses += 1;
      this.streak = 0;
      this.zoneW = Math.min(ZONE_MAX, this.zoneW * ZONE_GROW_PER_MISS);
    } else {
      this.hits += 1;
      this.streak += 1;
      this.traverseSec = Math.max(TRAVERSE_MIN_SEC, this.traverseSec * SPEEDUP_PER_HIT);
      this.zoneW = Math.max(ZONE_MIN, this.zoneW * ZONE_SHRINK_PER_HIT);
    }
    this.respawn = true; // new position after every press
    return res;
  }

  private spawnZone(): void {
    const lo = this.zoneW / 2 + 0.02;
    const hi = 1 - this.zoneW / 2 - 0.02;
    const ahead = SPAWN_AHEAD_MIN + this.rng() * (SPAWN_AHEAD_MAX - SPAWN_AHEAD_MIN);
    const c = bounce(this.pos, this.dir * ahead).pos;
    this.zoneC = Math.min(hi, Math.max(lo, c));
  }
}
