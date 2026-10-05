# CrazyGames — Technical Requirements

Source: https://docs.crazygames.com/requirements/technical

## 1. File size & count

- Total ≤ **250MB**, ≤ **1500 files** (high file count slows loading).
- Initial download ≤ **50MB**, measured from load start to first `GameplayStart` (SDK `Game` module). That event must fire when user is in playable state, not menu/loading.
- ≤ **20MB** initial to be eligible for mobile homepage.
- Without SDK: total size is used, so total must be ≤50MB (≤20MB for mobile homepage).
- Externally hosted files: judged on time-to-gameplay ≤ **20s**.
- Use **relative paths only**. Absolute paths fail.
- Unity: use custom build + optimizer package + addressables guide.

## 2. Device & browser

- Must work on **Chrome + Edge**. Poor Safari = disabled on Safari (reach loss). Poor on 4GB Chromebook (ChromiumOS) = disabled there.
- Inputs: mouse + keyboard + touch if mobile supported.
- Desktop must be playable in landscape. Portrait allowed with black bars / side background images.
- Use SDK `systemInfo` (`User` module) for device-specific experience, not own UA sniffing.

## 3. Mobile specifics

- Orientation: set supported orientations in portal submission. Portal prompts rotate. Do NOT code own orientation lock.
- Prevent iOS/tablet double-tap zoom / selection menu:
```css
body {
  -webkit-user-select: none;
  -moz-user-select: none;
  -ms-user-select: none;
  user-select: none;
}
```
- Unity on iOS disabled by default (memory crashes). Enabled after volume + QA eval.
- Must work in CrazyGames App fullscreen + safe areas. See `resources/crazygames-app/#safe-area-padding`.
- DPR handling (Unity): DPR=1 on iOS + low-mem Android, native `window.devicePixelRatio` elsewhere. They can override.

## 4. iOS audio resume

- Problem: iOS puts `AudioContext` into `interrupted` -> `suspended` on background/call. Android keeps it running. Engines like Howler / PlayCanvas often break.
- Fix: call `resume()` inside user gesture, not just `visibilitychange`:
```js
document.addEventListener("touchend", () => {
  if (audioContext && audioContext.state === "suspended") {
    audioContext.resume();
  }
});
```
- Howler: `Howler.ctx`. PlayCanvas: `pc.app.soundManager.context`. Unity usually auto-handles.

## 5. SDK integration

- Basic (if SDK used): must fire `GameplayStart` on entering playable state. Ads will be disabled — game must still run.
- Full: + `GameplayStart/Stop` (measure experience), `Data` module for saves (see account spec), `User` module for username/avatar, optional `LoadStart/Stop` for load analytics.

## 6. Sitelock & whitelisting

- If sitelock implemented, whitelist all CrazyGames domains + iOS/Android app origins.
- See `resources/html5/sitelock/`.

## 7. User consent / privacy

- If collecting personal data beyond SDK events: add non-blocking Terms & Privacy notice (not blocking popup).
- Good examples: Bloxd.io in-game notice, Racing Limits (opens policy in new tab).
