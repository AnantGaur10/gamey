// Gun roster + gold economy (locked 2026-09-26; prices intentionally TBD).
// TTK (HP=100, ret 1.00/0.92/0.70): default 49 -> 3 everywhere, never 2
// (2 hits = 98 @9m); lifesteal 38 / gold 37 -> 3 @<=11m, 4 @14m.

export type ExtraKind = "none" | "lifesteal" | "gold";

export interface GunDef {
  id: string;
  baseDamage: number;
  bloomStartDeg: number;
  bloomMinDeg: number;
  focusPerTapDeg: number;
  /** Chamber cooldown between shots. User-locked mapping: higher damage →
      SHORTER cooldown (descending with damage). Default fires fastest. */
  cooldownMs: number;
  extra: ExtraKind;
  extraValue: number; // lifesteal fraction (0.2) or gold bonus fraction (0.4)
}

export const GUNS: Record<string, GunDef> = {
  default: {
    id: "default",
    baseDamage: 49,
    bloomStartDeg: 2.4,
    bloomMinDeg: 0.03, // user 2026-10-06 (was 0.12; 0.6 before 2026-10-05)
    focusPerTapDeg: 0.3,
    cooldownMs: 380,
    extra: "none",
    extraValue: 0,
  },
  lifesteal: {
    id: "lifesteal",
    baseDamage: 38,
    bloomStartDeg: 2.4,
    bloomMinDeg: 0.035, // same ratio to default as before (was 0.14)
    focusPerTapDeg: 0.3,
    cooldownMs: 620,
    extra: "lifesteal",
    extraValue: 0.2,
  },
  gold: {
    id: "gold",
    baseDamage: 37,
    bloomStartDeg: 2.4,
    bloomMinDeg: 0.04, // same ratio to default as before (was 0.16)
    focusPerTapDeg: 0.3,
    cooldownMs: 650,
    extra: "gold",
    extraValue: 0.4,
  },
};

export interface AIProfile {
  reactionBaseMs: number;
  accuracyMult: number;
  focusQuality: number; // 0..1 simulated shrink
}

export const AI_ROSTER: AIProfile[] = [
  { reactionBaseMs: 850, accuracyMult: 1.3, focusQuality: 0.35 },
  { reactionBaseMs: 700, accuracyMult: 1.0, focusQuality: 0.55 },
  { reactionBaseMs: 550, accuracyMult: 0.8, focusQuality: 0.75 },
];

// Gold awards (flat per win + consolation; numbers are v1 tuning, not locked prices).
export const GOLD_WIN_BESTOF = 10;
export const GOLD_WIN_DEATHMATCH = 15;
export const GOLD_STREAK_STEP = 5;
export const GOLD_LOSS_CONSOLATION = 2;
export const GOLD_KILL_BONUS = 5;

// Revive token prices are NOT locked. Formula only:
//   death_price = ceil(1.5 * shop_price)
export function reviveDeathPrice(shopPrice: number): number {
  return Math.ceil(1.5 * shopPrice);
}
