import { defaultProgress, type PortalAdapter, type Progress } from "./PortalAdapter";
import { safeLoad, safeSave } from "../store/SafeStore";

// Full-build stub for LOCAL QA only (not submitted yet).
// Mirrors the real CrazyGamesAdapter contract: pause + block UI + mute only
// while an ad actually plays; resume on adFinished/adError; adError = no
// reward + continue. With no SDK wired, everything resolves no-fill.
export function createCrazyGamesAdapter(): PortalAdapter {
  return {
    kind: "full",
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
        const raw = safeLoad(KEY_FULL);
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
        safeSave(KEY_FULL, JSON.stringify(p));
      } catch {
        // best-effort by design.
      }
    },
    getUser() {
      return { id: null, name: null };
    },
  };
}

const KEY_FULL = "gamey.v1";
