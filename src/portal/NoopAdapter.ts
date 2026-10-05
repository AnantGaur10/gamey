import { defaultProgress, type PortalAdapter, type Progress } from "./PortalAdapter";
import { safeLoad, safeSave } from "../store/SafeStore";

const KEY = "gamey.v1";

// CrazyGames Basic Launch: no SDK bytes. Ads disabled; rewarded UI must be
// hidden by the game (never dead-clickable). All ad calls resolve no-fill.
export function createNoopAdapter(): PortalAdapter {
  return {
    kind: "basic",
    gameplayStart() {},
    gameplayStop() {},
    loadingStart() {},
    loadingStop() {},
    async requestMidgame() {
      return false;
    },
    async requestRewarded(_placement: string) {
      return false;
    },
    loadProgress(): Progress {
      try {
        const raw = safeLoad(KEY);
        if (!raw) return defaultProgress();
        const p = JSON.parse(raw) as Progress;
        if (p.v !== 1) return defaultProgress();
        return { ...defaultProgress(), ...p };
      } catch {
        return defaultProgress();
      }
    },
    saveProgress(p: Progress) {
      try {
        safeSave(KEY, JSON.stringify(p));
      } catch {
        // session continues; persistence is best-effort by design.
      }
    },
    getUser() {
      return { id: null, name: null };
    },
  };
}
