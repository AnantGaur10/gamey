// Enemy looks (user 2026-10-12): the black outlaw plus three outfits on the
// same rig, mixing purple / white / green (scripts/blender/outfits.py ->
// public/models/cowboy_<id>.glb, all with the outlaw's O_ node names, clips
// and hit geometry). `fallback` colours the procedural cowboy shown until
// the GLB lands (or if it never does). 2026-10-19: six more for the
// standard-mode ladder (game/levels.ts), three of them women.

export type FoeLookId =
  | "outlaw" | "bandido" | "ghost" | "dandy"
  | "greenhorn" | "prospector" | "kate" | "ruby" | "marshal" | "widow";

export interface FoeLook {
  id: FoeLookId;
  glb: string;
  fallback: { coat: number; hat: number; skin: number; accent: number; moustache: boolean };
}

export const FOE_LOOKS: Record<FoeLookId, FoeLook> = {
  outlaw: { id: "outlaw", glb: "cowboy_outlaw.glb", fallback: { coat: 0x8a3b2e, hat: 0x1a1a1a, skin: 0xc98d5f, accent: 0x1a1a1a, moustache: true } },
  bandido: { id: "bandido", glb: "cowboy_bandido.glb", fallback: { coat: 0x2e7d46, hat: 0xe8dcbc, skin: 0xb57a52, accent: 0x6a2c8a, moustache: true } },
  ghost: { id: "ghost", glb: "cowboy_ghost.glb", fallback: { coat: 0xe9e5da, hat: 0xefebe0, skin: 0xe8b896, accent: 0x5e2a7e, moustache: false } },
  dandy: { id: "dandy", glb: "cowboy_dandy.glb", fallback: { coat: 0x5b2a86, hat: 0x2a1838, skin: 0xe2a882, accent: 0x2f8a52, moustache: true } },
  greenhorn: { id: "greenhorn", glb: "cowboy_greenhorn.glb", fallback: { coat: 0xd39c3a, hat: 0xd8b45e, skin: 0xe9b48c, accent: 0x41618f, moustache: false } },
  prospector: { id: "prospector", glb: "cowboy_prospector.glb", fallback: { coat: 0x7b8999, hat: 0x6e5236, skin: 0xc58c62, accent: 0x3e2a1a, moustache: true } },
  kate: { id: "kate", glb: "cowboy_kate.glb", fallback: { coat: 0xc49464, hat: 0x5e4028, skin: 0xe6a87e, accent: 0x2e8c84, moustache: false } },
  ruby: { id: "ruby", glb: "cowboy_ruby.glb", fallback: { coat: 0xa3182c, hat: 0x3a0d18, skin: 0xf0c2a0, accent: 0x1c1418, moustache: false } },
  marshal: { id: "marshal", glb: "cowboy_marshal.glb", fallback: { coat: 0x2b3956, hat: 0xbdb6a8, skin: 0xd09a74, accent: 0x6d6a66, moustache: true } },
  widow: { id: "widow", glb: "cowboy_widow.glb", fallback: { coat: 0x18141a, hat: 0x16121a, skin: 0xf2d6c4, accent: 0x8e1424, moustache: false } },
};

/** Best-of series (user 2026-10-14): ONE opponent for the whole series.
    Since 2026-10-19 the standard mode is a ladder and the level picks it
    (game/levels.ts); this random pick only serves a series without a level
    (DEV probes), never the same twice in a row. */
const SERIES_FOES: FoeLookId[] = ["outlaw", "bandido", "ghost", "dandy"];
let lastSeriesFoe: FoeLookId | null = null;
export function pickSeriesFoe(): FoeLookId {
  const pool = SERIES_FOES.filter((f) => f !== lastSeriesFoe);
  lastSeriesFoe = pool[Math.floor(Math.random() * pool.length)];
  return lastSeriesFoe;
}
/** Deathmatch: the outlaw opens, then the three outfits, looping. */
const RUN_FOES: FoeLookId[] = ["outlaw", "bandido", "ghost", "dandy"];

/** Foe outside a best-of series: the tutorial dummy is the outlaw, a
    deathmatch run cycles the roster (a series carries pickSeriesFoe()). */
export function foeLookFor(mode: "deathmatch" | "tutorial", streak: number): FoeLook {
  if (mode === "tutorial") return FOE_LOOKS.outlaw;
  return FOE_LOOKS[RUN_FOES[streak % RUN_FOES.length]];
}
