// Game never imports SDKs directly. Only this interface.
export interface Progress {
  v: 1;
  gold: number;
  gunsOwned: string[];
  equippedGun: string;
  reviveToken: 0 | 1;
  bestStreak: number;
  bestBestOf: number;
  /** map: home-screen MAP choice ("random" or a map id, render/maps.ts). */
  settings: { mute: boolean; quality: "low" | "high"; map?: string };
  /** First-launch tutorial finished or skipped: never forced again. */
  tutorialDone?: boolean;
  /** Standard-mode ladder (game/levels.ts): the next unbeaten level,
      0-based; LEVEL_COUNT = all ten cleared. Missing on older saves = 0. */
  level?: number;
}

export function defaultProgress(): Progress {
  return {
    v: 1,
    gold: 0,
    gunsOwned: ["default"],
    equippedGun: "default",
    reviveToken: 0,
    bestStreak: 0,
    bestBestOf: 0,
    settings: { mute: false, quality: "high" },
  };
}

/** Device class as the portal reports it (ua-parser names, e.g. os "iOS"). */
export interface DeviceInfo {
  type: "desktop" | "tablet" | "mobile";
  os: string;
}

export interface PortalAdapter {
  /** "sdk" = CrazyGames SDK live, "none" = no SDK (load failed / ?nosdk / other site). */
  readonly kind: "sdk" | "none";
  /** Rewarded/midgame ads may be offered. Game code shows "watch ad" buttons
      ONLY when true (Basic Launch QA: no dead rewarded buttons). */
  readonly adsEnabled: boolean;
  /** Bring the portal up before boot(). Never rejects: on any failure the
      adapter keeps working in no-SDK mode. */
  init(): Promise<void>;
  gameplayStart(): void;
  gameplayStop(): void;
  loadingStart(): void;
  loadingStop(): void;
  /** Midgame/break ad. Resolves true if an ad played, false on no-fill. Never rejects, never blocks. */
  requestMidgame(): Promise<boolean>;
  /** Rewarded ad. Resolves true only on adFinished; false on adError/no-fill. Never rejects. */
  requestRewarded(_placement: string): Promise<boolean>;
  loadProgress(): Progress;
  saveProgress(p: Progress): void;
  getUser(): { id: string | null; name: string | null };
  /** CrazyGames SDK `user.systemInfo` (technical spec: use it for device-
      specific experience, not our own UA sniffing). Null without the SDK. */
  deviceInfo(): DeviceInfo | null;
}
