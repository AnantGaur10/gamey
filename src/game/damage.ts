// Duel distance per round: uniform over DUEL_RANGE_MIN..MAX metres (user
// 2026-10-05: visibly different every round; was 9-14).
export const DUEL_RANGE_MIN = 6;
export const DUEL_RANGE_MAX = 25;

// Global falloff, same factor for every gun (locked 2026-09-26, extended
// 2026-10-05): 1.00 up to 9m, 0.92 @ 11m, 0.70 @ 14m (lerp within each leg),
// then the 11-14m slope carries on until it is clamped at RET_FLOOR (0.55,
// reached at ~16m).
export const DUEL_MIN_DIST = 9;
export const DUEL_KNEE_DIST = 11;
export const DUEL_MAX_DIST = 14;
export const RET_AT_MIN = 1.0;
export const RET_AT_KNEE = 0.92;
export const RET_AT_MAX = 0.7;
export const RET_FLOOR = 0.55;

export const BASE_HP = 100;
export const HEADSHOT_INSTANT = true;
export const LIFESTEAL_CAP_PER_HIT = 15;

export function falloffRetention(distM: number): number {
  const d = Math.max(DUEL_MIN_DIST, distM);
  if (d <= DUEL_KNEE_DIST) {
    const t = (d - DUEL_MIN_DIST) / (DUEL_KNEE_DIST - DUEL_MIN_DIST);
    return RET_AT_MIN + (RET_AT_KNEE - RET_AT_MIN) * t;
  }
  // Past the max the far leg's slope continues, floored at RET_FLOOR.
  const t = (d - DUEL_KNEE_DIST) / (DUEL_MAX_DIST - DUEL_KNEE_DIST);
  return Math.max(RET_FLOOR, RET_AT_KNEE + (RET_AT_MAX - RET_AT_KNEE) * t);
}

export function bodyDamage(base: number, distM: number): number {
  return base * falloffRetention(distM);
}

/** Whole-hit count to kill a full-HP target with body shots. */
export function bodyHitsToKill(base: number, distM: number, hp = BASE_HP): number {
  const per = bodyDamage(base, distM);
  if (per <= 0) return Number.POSITIVE_INFINITY;
  return Math.ceil(hp / per - 1e-9);
}
