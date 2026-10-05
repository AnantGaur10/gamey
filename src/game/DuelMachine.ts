// Pure duel state machine: no render, no net, no SDK imports (lint rule).
// Seeded tick (fixed 60Hz by caller), replay/net-ready event log.
// States: Ready (waiting in holster zone) -> Focus(3s) -> Draw -> Fire -> Resolve.
// Aim stays parked until Draw; the ready gate only STARTS the countdown.

export type DuelPhase = "ready" | "intro" | "focus" | "draw" | "fire" | "resolve";

/** Persistent wound pose from taken hits (locked 2026-10-02): duelists stay
    rooted (no locomotion) but react — crouch (lunge) on hit 1, prone unlocks
    at hit 2+. `bend` is never rolled (kept for forcing/debug). Rolls use the
    seeded RNG, so poses are deterministic per seed. */
export type WoundPose = "none" | "bend" | "crouch" | "prone";

export interface FocusTap {
  tick: number;
  pad: "left" | "right" | "key";
}

export interface FocusMiss {
  tick: number;
}

const FOCUS_TICKS = 180; // 3.0s @ 60Hz
const TAP_FALLOFF_K = 0.18;
const HOLD_SHRINK_DEG_PER_SEC = 0.3;
const MISS_GROW_DEG = 0.25;
const POST_DRAW_REGROW_DEG_PER_SEC = 0.5;
const MAX_TAPS_PER_SEC = 12;
// Timing-QTE focus (2026-10-05): a hit shrinks bloom by focusPerTapDeg x
// these: PERFECT -0.36° (15% of the 2.4° start), GOOD -0.24° (10%). ~7
// perfect hits reach the 0.12° bloomMin; a miss costs MISS_GROW_DEG like
// the old outside-pad tap.
const QTE_PERFECT_MULT = 1.2;
const QTE_GOOD_MULT = 0.8;
const SPREAD_RIM_P = 0.7; // share of shots in the outer ring of the bloom
const SPREAD_INNER_R = 0.6; // ring starts at this fraction of the radius
// Shot kick (user 2026-10-05, anti-spam): every player shot multiplies the
// crosshair by SHOT_KICK_MULT, then it returns to the pre-shot ("base")
// radius faster and faster (ease-in, KICK_RETURN_S). Shots stack on the
// current size. A hit (flinch) rubber-bands it out to the post-hit radius:
// an underdamped spring (RB_*) that overshoots once, then the same return.
const SHOT_KICK_MULT = 1.5;
const KICK_RETURN_S = 0.6;
const RB_STIFF = 180;
const RB_DAMP = 12; // zeta ~0.45: one visible overshoot
const RB_S = 0.3;

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class DuelMachine {
  phase: DuelPhase = "ready";
  /** PC: countdown only ticks while the mouse stays in the holster zone. */
  paused = false;
  tick = 0;
  seed: number;
  bloomDeg: number;
  bloomStartDeg: number;
  bloomMinDeg: number;
  bloomMaxDeg: number;
  focusPerTapDeg: number;
  duelDistM: number;
  reviveUsed = false;
  private taps: FocusTap[] = [];
  private misses: FocusMiss[] = [];
  private tapCount = 0;
  private holdSec = 0;
  private rng: () => number;
  /** bloomDeg = base + kickDeg; kick = transient shot/flinch excess. */
  private kickDeg = 0;
  private kickFrom = 0;
  private kickT = 0;
  private rbOn = false;
  private rbT = 0;
  private rbV = 0;
  private rbTarget = 0;

  constructor(opts: {
    seed: number;
    bloomStartDeg: number;
    bloomMinDeg: number;
    bloomMaxDeg?: number;
    focusPerTapDeg: number;
    duelDistM: number;
  }) {
    this.seed = opts.seed;
    this.bloomStartDeg = opts.bloomStartDeg;
    this.bloomMinDeg = opts.bloomMinDeg;
    this.bloomMaxDeg = opts.bloomMaxDeg ?? opts.bloomStartDeg + 1.5;
    this.focusPerTapDeg = opts.focusPerTapDeg;
    this.bloomDeg = opts.bloomStartDeg;
    this.duelDistM = opts.duelDistM;
    this.rng = mulberry32(opts.seed);
  }

  startFocus(): void {
    if (this.phase !== "ready" && this.phase !== "intro") return;
    this.phase = "focus";
    this.tick = 0;
  }

  /** Rate-limited tap. Returns applied shrink (0 if capped). */
  addTap(tick: number, pad: FocusTap["pad"]): number {
    if (this.phase !== "focus") return 0;
    const recent = this.taps.filter((t) => tick - t.tick < 60).length;
    if (recent >= MAX_TAPS_PER_SEC) return 0;
    this.taps.push({ tick, pad });
    const shrink =
      this.focusPerTapDeg * (1 / (1 + TAP_FALLOFF_K * this.tapCount));
    this.tapCount += 1;
    this.bloomDeg = Math.max(this.bloomMinDeg, this.bloomDeg - shrink);
    return shrink;
  }

  /** Timing-QTE result: perfect/good shrink bloom, miss grows it. */
  addQte(res: "perfect" | "good" | "miss"): void {
    if (this.phase !== "focus") return;
    if (res === "miss") {
      this.addMiss();
      return;
    }
    const mult = res === "perfect" ? QTE_PERFECT_MULT : QTE_GOOD_MULT;
    this.tapCount += 1;
    this.bloomDeg = Math.max(this.bloomMinDeg, this.bloomDeg - this.focusPerTapDeg * mult);
  }

  /** Holster left before DRAW: the whole Focus restarts (full 3.0s countdown,
      bloom back to its start). Without the bloom reset, leaving at 0.1s
      would buy another 3s of QTE hits. */
  resetFocus(): void {
    if (this.phase !== "focus") return;
    this.tick = 0;
    this.bloomDeg = this.bloomStartDeg;
    this.kickDeg = this.kickFrom = this.kickT = this.rbV = 0;
    this.rbOn = false;
    this.taps = [];
    this.misses = [];
    this.tapCount = 0;
    this.holdSec = 0;
  }

  addHold(dtSec: number): void {
    if (this.phase !== "focus") return;
    this.holdSec += dtSec;
    this.bloomDeg = Math.max(
      this.bloomMinDeg,
      this.bloomDeg - HOLD_SHRINK_DEG_PER_SEC * dtSec,
    );
  }

  addMiss(): void {
    if (this.phase !== "focus") return;
    this.misses.push({ tick: this.tick });
    this.bloomDeg = Math.min(this.bloomMaxDeg, this.bloomDeg + MISS_GROW_DEG);
  }

  /** wound lottery (user 2026-10-05: lunge + prone only, bend is never
      rolled but stays forceable): hit 1 always crouch (the lunge); hit 2+
      crouch 60 / prone 40. One rng draw per call either way, so the seeded
      sequence shared with sampleSpread keeps its shape. Tunable weights. */
  rollWound(hitsTaken: number): WoundPose {
    if (hitsTaken <= 0) return "none";
    const r = this.rng();
    if (hitsTaken === 1) return "crouch";
    return r < 0.6 ? "crouch" : "prone";
  }

  /** bullet spread sample: random point in the bloom disc (seeded), biased
      to the rim (user ask 2026-10-05): SPREAD_RIM_P of shots land in the
      outer ring (SPREAD_INNER_R..1 of the radius), the rest in the middle,
      each area-uniform. A uniform disc put 64% in the middle, so a big
      crosshair still mostly hit dead centre. */
  sampleSpread(): { dx: number; dy: number } {
    const r = (this.bloomDeg * Math.PI) / 180;
    const a = this.rng() * Math.PI * 2;
    const u = this.rng();
    const k = SPREAD_INNER_R;
    const m = this.rng() < SPREAD_RIM_P ? Math.sqrt(k * k + u * (1 - k * k)) : k * Math.sqrt(u);
    return { dx: Math.cos(a) * r * m, dy: Math.sin(a) * r * m };
  }

  step(dtSec: number): void {
    if (this.paused) return;
    this.tick += 1;
    if (this.phase === "focus") {
      if (this.tick >= FOCUS_TICKS) {
        this.phase = "draw";
      }
    } else if (this.phase === "draw") {
      // caller flips to fire on first shot; draw persists until then.
    } else if (this.phase === "fire") {
      // recoil recovery + post-draw regrow handled by caller via helpers.
      void dtSec;
    }
  }

  /** Radius the kick returns to (Focus result + post-DRAW regrow). */
  get baseBloomDeg(): number {
    return this.bloomDeg - this.kickDeg;
  }

  /** Kick ceiling: bloomMax x SHOT_KICK_MULT, so a first shot always kicks
      the full x1.5 (the base never exceeds bloomMax) and stacked spam stays
      bounded. */
  get kickCapDeg(): number {
    return this.bloomMaxDeg * SHOT_KICK_MULT;
  }

  /** Set the transient excess over the base (total capped at kickCapDeg). */
  private setKick(k: number): void {
    const base = this.bloomDeg - this.kickDeg;
    this.kickDeg = Math.max(0, Math.min(this.kickCapDeg - base, k));
    this.bloomDeg = base + this.kickDeg;
  }

  /** Player shot: crosshair x SHOT_KICK_MULT of its current size, then the
      ease-in return restarts (recoverKick). */
  applyShotKick(): void {
    const base = this.baseBloomDeg;
    this.rbOn = false;
    this.setKick(this.bloomDeg * SHOT_KICK_MULT - base);
    this.kickFrom = this.kickDeg;
    this.kickT = 0;
  }

  /** Flinch (locked §3, both ways): the crosshair rubber-bands out to
      `bloomAddDeg` past its current size, then returns like a shot kick. */
  applyFlinch(aimUpDeg: number, bloomAddDeg: number): { aimUpDeg: number } {
    const base = this.baseBloomDeg;
    this.rbTarget = Math.min(this.kickCapDeg, this.bloomDeg + bloomAddDeg) - base;
    this.rbOn = true;
    this.rbT = 0;
    this.rbV = 0;
    return { aimUpDeg };
  }

  /** Fixed-step kick integration (draw + fire): rubber-band spring first,
      then the accelerating return to the base (0 exactly at KICK_RETURN_S). */
  recoverKick(dtSec: number): void {
    if (this.rbOn) {
      const a = RB_STIFF * (this.rbTarget - this.kickDeg) - RB_DAMP * this.rbV;
      this.rbV += a * dtSec;
      this.setKick(this.kickDeg + this.rbV * dtSec);
      this.rbT += dtSec;
      if (this.rbT >= RB_S) {
        this.rbOn = false;
        this.kickFrom = this.kickDeg;
        this.kickT = 0;
      }
      return;
    }
    if (this.kickDeg <= 0) return;
    this.kickT += dtSec;
    const u = this.kickT / KICK_RETURN_S;
    this.setKick(u >= 1 ? 0 : this.kickFrom * (1 - u * u));
  }

  /** Post-DRAW regrow (locked 2026-09-26 §1): holding without firing lets
      the focused bloom drift back open toward bloomMax. */
  regrow(dtSec: number): void {
    this.bloomDeg = Math.min(this.bloomMaxDeg, this.bloomDeg + POST_DRAW_REGROW_DEG_PER_SEC * dtSec);
  }

  focusProgress(): number {
    return Math.min(1, this.tick / FOCUS_TICKS);
  }

  focusTicksLeft(): number {
    return Math.max(0, FOCUS_TICKS - this.tick);
  }
}
