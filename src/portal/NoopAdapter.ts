import { defaultProgress, type PortalAdapter, type Progress } from "./PortalAdapter";
import { safeLoad, safeSave } from "../store/SafeStore";

const KEY = "gamey.v1";

// No-SDK mode: SafeStore saves, no-op game events, ads resolve no-fill (and
// adsEnabled=false hides every rewarded button). Used directly with ?nosdk=1
// and as CrazyGamesAdapter's fallback when the SDK can't load (adblock,
// offline, other sites).
export function createNoopAdapter(): PortalAdapter {
  return {
    kind: "none",
    adsEnabled: false,
    async init() {},
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
