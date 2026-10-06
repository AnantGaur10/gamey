// Portal switches (one place).
//
// ADS_ENABLED: CrazyGames turns ads off in Basic Launch (requests fail with
// `adsDisabledBasicLaunch`) and QA rejects rewarded buttons that do nothing.
// Keep false until CrazyGames promotes the game to Full, then flip to true
// and re-upload: the "watch ad" buttons (shop +10g, revive) appear and ad
// requests go through the SDK.
export const ADS_ENABLED = false;

/** CrazyGames HTML5 SDK v3 (the only external request the game makes). */
export const CG_SDK_URL = "https://sdk.crazygames.com/crazygames-sdk-v3.js";

/** Give up on the SDK script after this long and play in no-SDK mode. */
export const SDK_LOAD_TIMEOUT_MS = 4000;
