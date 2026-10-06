import { defaultProgress, type PortalAdapter, type Progress } from "./PortalAdapter";
import { createNoopAdapter } from "./NoopAdapter";
import { ADS_ENABLED, CG_SDK_URL, SDK_LOAD_TIMEOUT_MS } from "./config";
import { safeLoad } from "../store/SafeStore";

// CrazyGames HTML5 SDK v3 (docs.crazygames.com/sdk). Loaded at runtime, so
// the bundle carries no SDK bytes. Allowed in Basic Launch (ads are off
// there; ADS_ENABLED keeps the game from offering them). Anything that goes
// wrong (script blocked, offline, `disabled` environment on other sites, a
// throwing call) drops to the no-SDK adapter: the game always plays.

interface CgUser { username: string; profilePictureUrl?: string }
interface CgSdk {
  init(): Promise<void>;
  environment: "crazygames" | "local" | "disabled";
  game: { gameplayStart(): void; gameplayStop(): void; loadingStart(): void; loadingStop(): void };
  ad: {
    requestAd(type: "midgame" | "rewarded", cb: { adStarted?: () => void; adFinished?: () => void; adError?: (e: { code?: string }) => void }): void;
  };
  data: { getItem(k: string): string | null; setItem(k: string, v: string): void };
  user: { isUserAccountAvailable: boolean; getUser(): Promise<CgUser | null> };
}

const KEY = "gamey.v1";
/** Old saves lived in plain localStorage under the same key (pre-SDK builds). */
const MIGRATED = "gamey.migrated";

function loadScript(url: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    const t = window.setTimeout(() => reject(new Error("sdk timeout")), timeoutMs);
    s.src = url;
    s.async = true;
    s.onload = () => { window.clearTimeout(t); resolve(); };
    s.onerror = () => { window.clearTimeout(t); reject(new Error("sdk blocked")); };
    document.head.appendChild(s);
  });
}

function parseProgress(raw: string | null): Progress {
  try {
    if (!raw) return defaultProgress();
    const p = JSON.parse(raw) as Progress;
    if (p.v !== 1) return defaultProgress();
    return { ...defaultProgress(), ...p };
  } catch {
    return defaultProgress();
  }
}

export function createCrazyGamesAdapter(): PortalAdapter {
  const noop = createNoopAdapter();
  let sdk: CgSdk | null = null;
  let ads = ADS_ENABLED;
  let user: { id: string | null; name: string | null } = { id: null, name: null };
  /** Run an SDK call; on any throw fall back to no-SDK mode for the session. */
  const safe = <T>(fn: (s: CgSdk) => T, fallback: () => T): T => {
    if (!sdk) return fallback();
    try {
      return fn(sdk);
    } catch (err) {
      if (import.meta.env.DEV) console.warn("[gamey] SDK call failed, no-SDK mode", err);
      sdk = null;
      return fallback();
    }
  };
  const request = (type: "midgame" | "rewarded"): Promise<boolean> => {
    if (!ads || !sdk) return Promise.resolve(false);
    return new Promise((resolve) => {
      try {
        sdk!.ad.requestAd(type, {
          adFinished: () => resolve(true),
          adError: (e) => {
            // Safety net: Basic Launch answers every request with this code.
            if (e?.code === "adsDisabledBasicLaunch") ads = false;
            resolve(false);
          },
        });
      } catch {
        resolve(false);
      }
    });
  };

  return {
    get kind() { return sdk ? "sdk" as const : "none" as const; },
    get adsEnabled() { return ads && !!sdk; },
    async init() {
      try {
        if (new URLSearchParams(location.search).has("nosdk")) return;
        await loadScript(CG_SDK_URL, SDK_LOAD_TIMEOUT_MS);
        const s = (window as unknown as { CrazyGames?: { SDK?: CgSdk } }).CrazyGames?.SDK;
        if (!s) return;
        await s.init();
        if (s.environment === "disabled") return;
        sdk = s;
        // One-time move of a pre-SDK local save into the Data module.
        if (!s.data.getItem(KEY) && !s.data.getItem(MIGRATED)) {
          const old = safeLoad(KEY);
          if (old) s.data.setItem(KEY, old);
        }
        s.data.setItem(MIGRATED, "1");
        if (s.user.isUserAccountAvailable) {
          const u = await s.user.getUser().catch(() => null);
          if (u) user = { id: null, name: u.username };
        }
      } catch (err) {
        if (import.meta.env.DEV) console.warn("[gamey] CrazyGames SDK unavailable, no-SDK mode", err);
        sdk = null;
      }
    },
    gameplayStart() { safe((s) => s.game.gameplayStart(), () => noop.gameplayStart()); },
    gameplayStop() { safe((s) => s.game.gameplayStop(), () => noop.gameplayStop()); },
    loadingStart() { safe((s) => s.game.loadingStart(), () => noop.loadingStart()); },
    loadingStop() { safe((s) => s.game.loadingStop(), () => noop.loadingStop()); },
    requestMidgame: () => request("midgame"),
    requestRewarded: (_placement: string) => request("rewarded"),
    loadProgress(): Progress {
      return safe((s) => parseProgress(s.data.getItem(KEY)), () => noop.loadProgress());
    },
    saveProgress(p: Progress) {
      safe((s) => s.data.setItem(KEY, JSON.stringify(p)), () => noop.saveProgress(p));
    },
    getUser() {
      return user;
    },
  };
}
