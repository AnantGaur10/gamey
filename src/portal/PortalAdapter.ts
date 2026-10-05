// Game never imports SDKs directly. Only this interface.
export interface Progress {
  v: 1;
  gold: number;
  gunsOwned: string[];
  equippedGun: string;
  reviveToken: 0 | 1;
  bestStreak: number;
  bestBestOf: number;
  settings: { mute: boolean; quality: "low" | "high" };
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

export interface PortalAdapter {
  readonly kind: "basic" | "full";
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
}
