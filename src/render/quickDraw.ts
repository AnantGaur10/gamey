// Quick-draw (user 2026-10-05): guns start in the holster, hand on the grip.
// At DRAW the hand grips (QD_GRIP), pulls the gun clear (gun node blends
// holster -> hand until QD_OUT), swings up to level (QD_END). Cosmetic and
// time-based; the fire gate (DRAW_TICKS in home.ts) is the gameplay rule, on
// the fixed clock. Shared by the duel and the menu backdrop (ui/menuScene.ts).
export const QD_GRIP = 0.05;
export const QD_OUT = 0.16;
export const QD_END = 0.3;

/** Gun-arm angles: shoulder pitch (s), shoulder roll (z), elbow (e). */
export interface ArmPose { s: number; z: number; e: number }

/** Quick-draw arm path from the hand-on-holster pose `f`: hold while the
    hand grips, pull up (elbow folds, hand rises along the holster), swing
    out past level, settle level (0.05, 0, 0). Smoothstep between keys. */
export function quickDraw(t: number, f: ArmPose): ArmPose {
  const keys: Array<[number, number, number, number]> = [
    [0, f.s, f.z, f.e],
    [QD_GRIP, f.s, f.z, f.e],
    [QD_OUT, f.s + (0.05 - f.s) * 0.45, f.z * 0.4, f.e - 0.35],
    [QD_END - 0.08, -0.12, 0, 0.08],
    [QD_END, 0.05, 0, 0],
  ];
  if (t <= 0) return { s: f.s, z: f.z, e: f.e };
  for (let i = 1; i < keys.length; i++) {
    if (t <= keys[i][0]) {
      const [t0, s0, z0, e0] = keys[i - 1];
      const [t1, s1, z1, e1] = keys[i];
      let u = (t - t0) / (t1 - t0);
      u = u * u * (3 - 2 * u); // smoothstep: no pops between phases
      return { s: s0 + (s1 - s0) * u, z: z0 + (z1 - z0) * u, e: e0 + (e1 - e0) * u };
    }
  }
  return { s: 0.05, z: 0, e: 0 };
}

/** Gun node blend holster -> hand for quick-draw time t. */
export function gunOut(t: number): number {
  const u = Math.min(1, Math.max(0, (t - QD_GRIP) / (QD_OUT - QD_GRIP)));
  return u * u * (3 - 2 * u);
}
