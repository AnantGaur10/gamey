import { NOON, EVENING, NIGHT, HELL, type TimeOfDay, type ArenaFloorLook } from "./arena";

// 1v1 maps (user 2026-10-12): Main Street (the original set, its own lava
// causeway hell), a saloon interior, a waterfall clearing and a town street
// between houses. The three new sets are Blender GLBs built by
// scripts/blender/build_{saloon,falls,town}.py (node contract: set_kit.py)
// and loaded by render/setGlb.ts. Their hell round is the SAME set tinted
// red / dark brown (setGlb hell tint) under hell light, sky and embers.
//
// Night difficulty is fog density (arena NIGHT): every map keeps the base
// presets' fogDensity and only changes colours, so no map is easier at night.

export type MapId = "street" | "saloon" | "falls" | "town";
export type MapChoice = MapId | "random";

export const MAP_IDS: MapId[] = ["street", "saloon", "falls", "town"];
export const MAP_CHOICES: MapChoice[] = ["random", ...MAP_IDS];

export interface MapDef {
  id: MapId;
  /** Shown on the home MAP button and the round line. */
  name: string;
  /** Set GLB under public/models (null = Main Street's own loader). */
  glb: string | null;
  floor: ArenaFloorLook;
  /** Lighting / fog / sky / grade per decided-round stage (0 noon, 1
      evening, 2+ night) and for the hell round. */
  tod(stage: number, hell: boolean): TimeOfDay;
  /** Window / lamp emissive 0..1 per stage (hell is always 1). */
  glow: [number, number, number];
  /** S_Sky openings (windows seen from inside) per stage + hell. */
  window: [number, number, number, number];
  /** S_Shaft sunbeams strength per stage + hell. */
  shaft: [number, number, number, number];
  /** Wind audio level multiplier (indoors is muffled). */
  wind: number;
  /** Ambient particle preset cap: interiors never get fireflies. */
  ambientMaxStage: number;
  /** Shadow decal strength multiplier (no sun indoors). */
  shadow: number;
  /** Multiplier on the set's baked colours (the saloon bakes dark lamp light). */
  paintGain: number;
  /** Dust kind when a miss flies on past the foe into the backdrop. */
  backdrop: "wood" | "ground";
  /** Night only: off-lane set read (setGlb addNightVis). fill = flat
      moonlight on the set colours, fog = fog distance scale off the lane. */
  nightVis?: { fill: number; fog: number };
}

/** Stage preset with colour overrides; fogDensity always comes from the base. */
function tint(base: TimeOfDay, o: Partial<Omit<TimeOfDay, "fogDensity">>): TimeOfDay {
  return { ...base, ...o, fogDensity: base.fogDensity };
}
const stageOf = (i: number) => Math.max(0, Math.min(2, i));

// Hell on the new maps: the arena HELL light (dim ember sun, red fog) with a
// red sky for the outdoor sets.
const HELL_GRADE = { exposure: 1.1, saturation: 0.98, contrast: 1.08, lift: [0.01, 0, 0] as [number, number, number], gain: [1.08, 0.94, 0.86] as [number, number, number] };
const HELL_OUT = tint(HELL, {
  sky: [[0, 0x0d0302], [0.5, 0x2a0805], [0.8, 0x5e1a0a], [1, 0xb4400e]],
  hemiSky: 0xd06a48,
  hemiGround: 0x3a1008,
  hemiIntensity: 0.55,
  dirIntensity: 0.45,
  grade: HELL_GRADE,
});

const STREET: MapDef = {
  id: "street",
  name: "MAIN STREET",
  glb: null,
  floor: { ground: 0xd9b380, ruts: true, sun: true },
  tod: (i, hell) => (hell ? HELL : [NOON, EVENING, NIGHT][stageOf(i)]),
  glow: [0, 0.55, 1],
  window: [0xffffff, 0xffffff, 0xffffff, 0xffffff],
  shaft: [0, 0, 0, 0],
  wind: 1,
  ambientMaxStage: 2,
  shadow: 1,
  paintGain: 1,
  backdrop: "wood",
};

// Saloon: a closed hall, the sky never shows. Daylight comes in through the
// windows (S_Sky panes + S_Shaft beams) and fades to lamplight at night; the
// fog is tobacco smoke (same densities: at night the far foe sinks into it).
const SALOON_TOD: TimeOfDay[] = [
  tint(NOON, {
    sky: [[0, 0x1a110b], [1, 0x2a1a10]],
    hemiIntensity: 0.95, hemiSky: 0xffe6c8, hemiGround: 0x5a4030,
    dirIntensity: 0.4, dirColor: 0xffd8a0,
    fogColor: 0x3a2c20,
    grade: { exposure: 1.08, saturation: 1.05, contrast: 1.06, lift: [0, 0, 0], gain: [1.04, 1, 0.94] },
    rim: { color: 0xffd8a0, strength: 0.32 },
  }),
  tint(EVENING, {
    sky: [[0, 0x140c08], [1, 0x24140c]],
    hemiIntensity: 0.62, hemiSky: 0xffc890, hemiGround: 0x4a3020,
    dirIntensity: 0.32, dirColor: 0xff9a50,
    fogColor: 0x2e1f16,
    grade: { exposure: 1.0, saturation: 1.08, contrast: 1.06, lift: [0.01, 0, 0], gain: [1.08, 0.97, 0.88] },
    rim: { color: 0xffa060, strength: 0.3 },
  }),
  tint(NIGHT, {
    sky: [[0, 0x080504], [1, 0x120a06]],
    hemiIntensity: 0.32, hemiSky: 0x8a6a4a, hemiGround: 0x2a1a10,
    dirIntensity: 0.12, dirColor: 0xffb070,
    fogColor: 0x18100a,
    grade: { exposure: 1.35, saturation: 0.95, contrast: 1.04, lift: [0, 0, 0], gain: [1.08, 0.98, 0.9] },
    rim: { color: 0xffb070, strength: 0.12 },
  }),
];
const SALOON_HELL = tint(HELL, {
  sky: [[0, 0x0a0302], [1, 0x1a0604]],
  hemiSky: 0xd06a48, hemiGround: 0x2a0c06, hemiIntensity: 0.6,
  dirIntensity: 0.35,
  grade: HELL_GRADE,
});
const SALOON: MapDef = {
  id: "saloon",
  name: "SALOON",
  glb: "saloon.glb",
  floor: { ground: null, ruts: false, sun: false },
  tod: (i, hell) => (hell ? SALOON_HELL : SALOON_TOD[stageOf(i)]),
  glow: [1, 1, 1],
  window: [0xfff4dc, 0xffb070, 0x1a2040, 0xff3a12],
  shaft: [1, 0.7, 0, 0.3],
  wind: 0.2,
  ambientMaxStage: 1,
  shadow: 0.6,
  paintGain: 1.5,
  backdrop: "wood",
};

// Falls: a sunny meadow under a waterfall; golden dusk; moonlit blue night.
const FALLS_TOD: TimeOfDay[] = [
  tint(NOON, {
    sky: [[0, 0x3a73bd], [0.45, 0x86b4dc], [0.8, 0xd4e6ec], [1, 0xc2d6c8]],
    hemiIntensity: 1.1, hemiSky: 0xeaf4ff, hemiGround: 0x6f8a45,
    dirIntensity: 0.55, dirColor: 0xfff2dc,
    fogColor: 0xc8dcd8,
    grade: { exposure: 1.0, saturation: 1.12, contrast: 1.05, lift: [0, 0, 0], gain: [1, 1.02, 0.98] },
    rim: { color: 0xfff6e0, strength: 0.28 },
  }),
  tint(EVENING, {
    // Top stop near the fog colour: a purple top cut jagged teeth along the
    // fogged treeline.
    sky: [[0, 0x9a7270], [0.45, 0xb87c62], [0.75, 0xf0a066], [1, 0x8a6a48]],
    hemiIntensity: 0.62, hemiSky: 0xffc89a, hemiGround: 0x5a5a32,
    dirIntensity: 0.38, dirColor: 0xffa050,
    fogColor: 0xb07a58,
    grade: { exposure: 0.97, saturation: 1.12, contrast: 1.06, lift: [0.01, 0, 0.01], gain: [1.06, 0.98, 0.9] },
    rim: { color: 0xffb070, strength: 0.3 },
  }),
  tint(NIGHT, {
    sky: [[0, 0x050a1a], [0.5, 0x10213a], [0.8, 0x1e3448], [1, 0x0e1a1c]],
    hemiIntensity: 0.18, hemiSky: 0x8aa8ff, hemiGround: 0x1a2418,
    dirIntensity: 0.15, dirColor: 0x9ab8ff,
    fogColor: 0x101c2c,
    grade: { exposure: 1.4, saturation: 0.85, contrast: 1.04, lift: [0, 0, 0], gain: [0.88, 0.96, 1.12] },
    rim: { color: 0x9ab8ff, strength: 0.1 },
  }),
];
const FALLS: MapDef = {
  id: "falls",
  name: "THE FALLS",
  glb: "falls.glb",
  floor: { ground: 0x7d9a45, ruts: false, sun: false },
  tod: (i, hell) => (hell ? HELL_OUT : FALLS_TOD[stageOf(i)]),
  glow: [0, 0.4, 1],
  window: [0xffffff, 0xffffff, 0xffffff, 0xffffff],
  shaft: [0, 0, 0, 0],
  wind: 1.1,
  ambientMaxStage: 2,
  shadow: 1,
  paintGain: 1,
  backdrop: "ground",
  nightVis: { fill: 0.14, fog: 0.45 },
};

// Town: an overcast street between houses (telegraph poles + wires);
// windows light up from dusk.
const TOWN_TOD: TimeOfDay[] = [
  tint(NOON, {
    sky: [[0, 0x6f7a86], [0.5, 0x9aa2a8], [0.85, 0xb9b6ac], [1, 0xa89f8e]],
    hemiIntensity: 1.05, hemiSky: 0xd8dde2, hemiGround: 0x6e6252,
    dirIntensity: 0.28, dirColor: 0xeef0f6,
    fogColor: 0xa7a399,
    grade: { exposure: 1.02, saturation: 0.92, contrast: 1.06, lift: [0, 0, 0], gain: [0.99, 1, 1.03] },
    rim: { color: 0xe8eef8, strength: 0.3 },
  }),
  tint(EVENING, {
    sky: [[0, 0x3c4250], [0.5, 0x5e6068], [0.8, 0x8a7a6a], [1, 0x6a5a4c]],
    hemiIntensity: 0.6, hemiSky: 0x9aa0aa, hemiGround: 0x4a4038,
    dirIntensity: 0.24, dirColor: 0xffb88a,
    fogColor: 0x5f5a58,
    grade: { exposure: 0.98, saturation: 0.95, contrast: 1.07, lift: [0, 0, 0.01], gain: [1.02, 0.98, 0.98] },
    rim: { color: 0xffc8a0, strength: 0.3 },
  }),
  tint(NIGHT, {
    sky: [[0, 0x07090f], [0.5, 0x141824], [0.8, 0x23242c], [1, 0x15130f]],
    hemiIntensity: 0.16, hemiSky: 0x4a5670, hemiGround: 0x1c1814,
    dirIntensity: 0.12, dirColor: 0x8a9ac0,
    fogColor: 0x101218,
    grade: { exposure: 1.4, saturation: 0.85, contrast: 1.04, lift: [0, 0, 0], gain: [0.92, 0.96, 1.08] },
    rim: { color: 0x8aa0d0, strength: 0.1 },
  }),
];
const TOWN: MapDef = {
  id: "town",
  name: "TELEGRAPH ROW",
  glb: "town.glb",
  floor: { ground: 0x7e705e, ruts: false, sun: false },
  tod: (i, hell) => (hell ? HELL_OUT : TOWN_TOD[stageOf(i)]),
  glow: [0, 0.7, 1],
  window: [0xffffff, 0xffffff, 0xffffff, 0xffffff],
  shaft: [0, 0, 0, 0],
  wind: 1,
  ambientMaxStage: 2,
  shadow: 0.7,
  paintGain: 1,
  backdrop: "wood",
  nightVis: { fill: 0.12, fog: 0.55 },
};

export const MAPS: Record<MapId, MapDef> = { street: STREET, saloon: SALOON, falls: FALLS, town: TOWN };

export function isMapChoice(v: unknown): v is MapChoice {
  return typeof v === "string" && (MAP_CHOICES as string[]).includes(v);
}

/** Resolve the saved choice to a concrete map ("random" rolls one). */
export function pickMap(choice: MapChoice | undefined): MapId {
  if (choice && choice !== "random") return choice;
  return MAP_IDS[Math.floor(Math.random() * MAP_IDS.length)];
}

/** Home-screen label for a choice. */
export function mapLabel(choice: MapChoice): string {
  return choice === "random" ? "RANDOM" : MAPS[choice].name;
}

/** Page background behind the canvas (CSS) from a stage's sky stops. */
export function cssSky(t: TimeOfDay): string {
  const hex = (c: number) => `#${c.toString(16).padStart(6, "0")}`;
  return `linear-gradient(${t.sky.map(([p, c]) => `${hex(c)} ${Math.round(p * 100)}%`).join(", ")})`;
}
