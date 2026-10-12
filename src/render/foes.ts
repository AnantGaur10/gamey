// Enemy looks (user 2026-10-12): the black outlaw plus three outfits on the
// same rig, mixing purple / white / green (scripts/blender/outfits.py ->
// public/models/cowboy_<id>.glb, all with the outlaw's O_ node names, clips
// and hit geometry). `fallback` colours the procedural cowboy shown until
// the GLB lands (or if it never does).

export type FoeLookId = "outlaw" | "bandido" | "ghost" | "dandy";

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
};

/** Best-of series: a new opponent per decided round (the AI tier follows
    the same stage), so a drawn round replays vs the same foe. */
const SERIES_FOES: FoeLookId[] = ["bandido", "ghost", "dandy"];
/** Deathmatch: the outlaw opens, then the three outfits, looping. */
const RUN_FOES: FoeLookId[] = ["outlaw", "bandido", "ghost", "dandy"];

export function foeLookFor(mode: "standard" | "deathmatch" | "tutorial", stage: number, streak: number): FoeLook {
  if (mode === "tutorial") return FOE_LOOKS.outlaw;
  if (mode === "deathmatch") return FOE_LOOKS[RUN_FOES[streak % RUN_FOES.length]];
  return FOE_LOOKS[SERIES_FOES[Math.max(0, Math.min(SERIES_FOES.length - 1, stage))]];
}
