import type { AIProfile } from "./economy";

// Standard-mode ladder (user 2026-10-19: "for the standard mode create a
// level based system so after each duel of 3 rounds it switches to the next
// npc have 10 levels in total with different enemy npc each progressively
// difficult in response time and accuracy they must look different").
// One named foe per level, a best-of-3 each: win it and the next one steps
// up, lose it and the same foe waits for a rematch. Pure data + logic (no
// render / DOM / SDK); the foe ids are render/foes.ts FoeLookIds.

export interface Level {
  /** Shown on the round line, result card and home (English, upper-case UI). */
  name: string;
  /** One line under the name on the level banner. */
  tagline: string;
  /** render/foes.ts outfit id. */
  foe: "greenhorn" | "outlaw" | "prospector" | "bandido" | "kate" | "ghost" | "ruby" | "dandy" | "marshal" | "widow";
  /** Base first-shot delay after DRAW (ms, before the 0.85 haste and the
      per-round 0.97^stage climb in runDuel's scheduleFoe). */
  reactionBaseMs: number;
  /** Hand wobble multiplier (x 0.03 rad gaussian sigma): lower = more accurate. */
  accuracyMult: number;
  /** Stand-in for QTE hits: how far the foe's own crosshair shrinks at DRAW. */
  focusQuality: number;
}

// Old best-of tiers for scale (AI_ROSTER, round 1 -> 3): 850/1.30/0.35,
// 700/1.00/0.55, 550/0.80/0.75. Level 1 sits below round 1 (a gentle
// opener), level 6 around the old round 3, level 10 well past it. Reaction
// x0.85 (haste) lands level 1 at ~810ms and level 10's last round at ~300ms
// (floor 180ms); wobble 1.55 -> 0.58 takes the first-shot hit rate at 15m
// from ~45% to ~90%.
export const LEVELS: readonly Level[] = [
  { name: "GREENHORN GUS", tagline: "Fresh off the farm. Slow hands.", foe: "greenhorn", reactionBaseMs: 950, accuracyMult: 1.55, focusQuality: 0.25 },
  { name: "BLACK BART", tagline: "Robbed every stage from here to Tucson.", foe: "outlaw", reactionBaseMs: 870, accuracyMult: 1.38, focusQuality: 0.33 },
  { name: "OLD MOSE", tagline: "Forty years of gold dust. Steady aim.", foe: "prospector", reactionBaseMs: 790, accuracyMult: 1.24, focusQuality: 0.41 },
  { name: "EL VERDE", tagline: "Two bandoliers, never a missed payday.", foe: "bandido", reactionBaseMs: 720, accuracyMult: 1.12, focusQuality: 0.49 },
  { name: "CALAMITY KATE", tagline: "Rode with the cavalry. Draws like it.", foe: "kate", reactionBaseMs: 655, accuracyMult: 1.0, focusQuality: 0.56 },
  { name: "THE PALE RIDER", tagline: "Nobody has seen his face. Nobody alive.", foe: "ghost", reactionBaseMs: 595, accuracyMult: 0.9, focusQuality: 0.63 },
  { name: "RUBY ROSE", tagline: "Deals cards with one hand. Shoots with the other.", foe: "ruby", reactionBaseMs: 540, accuracyMult: 0.81, focusQuality: 0.7 },
  { name: "GENTLEMAN JACK", tagline: "Never draws first. Never needs to.", foe: "dandy", reactionBaseMs: 490, accuracyMult: 0.73, focusQuality: 0.77 },
  { name: "MARSHAL COLE", tagline: "Wore the star. Then sold it.", foe: "marshal", reactionBaseMs: 440, accuracyMult: 0.65, focusQuality: 0.84 },
  { name: "THE WIDOW", tagline: "Every man she buried drew first.", foe: "widow", reactionBaseMs: 395, accuracyMult: 0.58, focusQuality: 0.9 },
];

export const LEVEL_COUNT = LEVELS.length;

/** Saved ladder position (Progress.level: next unbeaten level, LEVEL_COUNT =
    ladder cleared) -> the level PLAY starts. A cleared ladder replays the
    final duel. Bad or missing saves start at level 1. */
export function playableLevel(saved: number | undefined): number {
  const n = Number.isFinite(saved) ? Math.floor(saved as number) : 0;
  return Math.min(Math.max(n, 0), LEVEL_COUNT - 1);
}

/** The foe's AI for a ladder level at `stage` decided rounds into its
    best-of-3. Reaction keeps the shared formula in runDuel (x0.85 haste,
    x0.97^stage); accuracy and focus climb a little per decided round, as the
    old tiers did, without overtaking the next level's opener much. */
export function levelAi(level: number, stage: number): AIProfile {
  const l = LEVELS[playableLevel(level)];
  const s = Math.max(0, Math.min(stage, 2));
  return {
    reactionBaseMs: l.reactionBaseMs,
    accuracyMult: l.accuracyMult * Math.pow(0.95, s),
    focusQuality: Math.min(0.95, l.focusQuality + 0.04 * s),
  };
}

/** Gold for beating a level the first time (economy is not user-locked). */
export function levelClearGold(level: number): number {
  return 20 + 5 * (playableLevel(level) + 1);
}
