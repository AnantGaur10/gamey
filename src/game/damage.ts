// Global bilinear falloff, same factor for every gun (locked 2026-09-26).
// ret: 1.00 @ 9m, 0.92 @ 11m, 0.70 @ 14m. Lerp within each leg.
export const DUEL_MIN_DIST = 9;
export const DUEL_KNEE_DIST = 11;
export const DUEL_MAX_DIST = 14;
export const RET_AT_MIN = 1.0;
export const RET_AT_KNEE = 0.92;
export const RET_AT_MAX = 0.7;

export const BASE_HP = 100;
export const HEADSHOT_INSTANT = true;
export const LIFESTEAL_CAP_PER_HIT = 15;

export function falloffRetention(distM: number): number {
  const d = Math.min(DUEL_MAX_DIST, Math.max(DUEL_MIN_DIST, distM));
  if (d <= DUEL_KNEE_DIST) {
    const t = (d - DUEL_MIN_DIST) / (DUEL_KNEE_DIST - DUEL_MIN_DIST);
    return RET_AT_MIN + (RET_AT_KNEE - RET_AT_MIN) * t;
  }
  const t = (d - DUEL_KNEE_DIST) / (DUEL_MAX_DIST - DUEL_KNEE_DIST);
  return RET_AT_KNEE + (RET_AT_MAX - RET_AT_KNEE) * t;
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
