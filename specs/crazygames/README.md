# CrazyGames Release Specs

Goal: pass CrazyGames QA for `gamey/` and be eligible for **Full Launch** (monetization).

Sources (2026):
- https://docs.crazygames.com/requirements/intro
- https://docs.crazygames.com/requirements/technical
- https://docs.crazygames.com/requirements/gameplay
- https://docs.crazygames.com/requirements/ads
- https://docs.crazygames.com/requirements/account-integration
- https://docs.crazygames.com/requirements/multiplayer
- https://docs.crazygames.com/requirements/game-covers
- https://docs.crazygames.com/requirements/quality

## Launch tiers

- **Basic Launch:** go live without CrazyGames customization. SDK optional. No monetization / revenue share. Ads disabled even if SDK integrated. Used to prove metrics. See `resources/basic-launch-metrics`.
- **Full Launch:** requires everything below + full SDK. Required for ad revenue + Xsolla IAP (invite-only).
- Flow: submit at `developer.crazygames.com` -> preview + QA Tool (checks requirements + SDK) -> Basic -> selected for Full -> integrate -> QA again -> revenue.
- Support threshold: 50k combined plays before 1:1 SDK integration support.
- HTML5 + Unity SDKs are full-featured. GDevelop / Defold / Wonderland SDKs may lack features.

## Must-pass summary

| Category | Basic | Full |
|---|---|---|
| Technical | initial ≤50MB, total ≤250MB, ≤1500 files, Chrome/Edge OK, relative paths | + `GameplayStart` event, SDK full (start/stop, Data/User where applicable, load events optional) |
| Gameplay | visual QA, PEGI-12, English, no custom fullscreen, no cross-promo | + land in gameplay, max 1 click |
| Ads | monetization disabled, no external ads, must not freeze with ads off | + SDK-only ads, midgame/rewarded/banner rules, AdBlock playable |
| Accounts | no external logins, guests must be able to play | + link progress to CG account, use CG username/avatar, auto-login |
| Multiplayer | optional Full features, QA decides Basic vs direct Full | + room info, invite link/button, instant flow, keep rooms, DisableChat respect |
| Covers | 3 covers + videos + description/controls metadata | same |

## Global gotchas for `gamey/`

- Design for Full from day one to avoid rework.
- Never use absolute paths.
- Never add custom fullscreen button.
- Never require login to play.
- Never block AdBlock users from playing.
- Only CrazyGames SDK ads. No other ad network.
- File/size budgets enforced in CI early.
