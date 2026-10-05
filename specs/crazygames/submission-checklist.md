# CrazyGames — Submission Checklist for `gamey/`

Use before every submit. All boxes must be true for Full Launch.

## Build

- [ ] Total ≤250MB, files ≤1500, initial to `GameplayStart` ≤50MB (≤20MB for mobile homepage)
- [ ] Relative paths only
- [ ] Chrome + Edge verified; Safari + 4GB Chromebook either pass or accept disabling
- [ ] Tested iframe sizes: 907x510, 1216x684, 1077x606, 821x462, 1366x768, 1920x1080, 1536x864, 1280x720, 800x450, 1080x607
- [ ] Physics delta-time safe at 60/144/165Hz
- [ ] Mouse + keyboard + touch (if mobile); landscape OK; no custom orientation lock
- [ ] `user-select:none` CSS, safe-area fullscreen OK, iOS audio resume on gesture
- [ ] No custom fullscreen button
- [ ] English + accurate translations, SDK locale with EN fallback
- [ ] No cross-promo / external playable links / App Store links
- [ ] PEGI-12, 13+ safe
- [ ] Max 1 click to gameplay

## SDK

- [ ] `GameplayStart` on playable state; `Start/Stop` pair correct; `LoadStart/Stop` if useful
- [ ] `Data` save or APS (or N/A justified); `User` username/avatar shown
- [ ] Guest playable, no external logins, auto-register/login via `userId`, Auth Listener handled
- [ ] QA Tool passes with ads disabled (no freezes, no dead rewarded buttons)

## Ads (Full)

- [ ] SDK-only ads; midgame only at breaks, paused + blocked UI, mute only during play, `adError` continues
- [ ] Rewarded optional, video icon, equal alternative, no chain, cooldown/timer, coin alternative, `adError` = no reward, out-of-lives not every death, no midgame+rewarded double between levels
- [ ] Banners: ≤2, static screens 5s+, never in play, distinct, no UI cover
- [ ] AdBlock: fully playable, inline notice only for gated extras, no popups

## Multiplayer (if any)

- [ ] Room update/joinable/inviteParams, invite link/button, instant flow joinable immediately, same-group next round, lobby sizes submitted, CG usernames shown, chat gated by game settings + profanity/AI moderation

## Store

- [ ] Covers 1920x1080 + 800x1200 + 800x800, title on cover, no borders/promo/store logos, licensed art only
- [ ] Videos 15-20s ≤50MB 1080p landscape + portrait, no bars/cursor/text/sound, first frame = cover
- [ ] Description + controls metadata truthful
