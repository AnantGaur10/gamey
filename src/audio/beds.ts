// What each place sounds like under the duel (user 2026-11-02): the Saloon
// plays its honky-tonk tune, The Falls its river + birds; Main Street and
// Telegraph Row have no bed (their townsfolk's footsteps carry them,
// render/townsfolk.ts). Hell silences every bed: only the wind's roar.
import type { BedLayer } from "./AudioManager";
import type { MapId } from "../render/maps";

/** The home screen: "Lasso Lady" (congusbongus, CC0), a seamless loop. */
export const MENU_BED: BedLayer[] = [{ file: "home-screen.mp3", gain: 0.55, bus: "music" }]; // chiptune: square waves read loud

export function mapBed(map: MapId, stage: number, hell: boolean): BedLayer[] {
  if (hell) return [];
  const s = Math.max(0, Math.min(2, stage));
  switch (map) {
    case "saloon":
      return [{ file: "saloon.mp3", gain: 0.8, bus: "music" }];
    case "falls":
      return [
        { file: "falls-river.mp3", gain: 0.55, bus: "sfx" },
        // Birds settle as the light goes.
        { file: "falls-birds.mp3", gain: [0.4, 0.22, 0.05][s], bus: "sfx" },
      ];
    default:
      return [];
  }
}
