# CrazyGames — Advertisement Requirements (Full Launch)

Source: https://docs.crazygames.com/requirements/ads

> Basic Launch: ads disabled, no revenue. If Ads SDK integrated, game must run smoothly with ads off. Reject if: freezes between levels, dead rewarded buttons.

- Only ads via CrazyGames SDK. No other networks.
- Types: midgame video (between levels/stages), rewarded video (for bonus, with fallback banners), in-game banners.
- Never: interrupt gameplay, trigger deceptively, chain multiple ads. No ads before reasonable gameplay.

## Video / midgame

- Show only at logical breaks: level transition, map change, player death. NEVER during active play or on nav buttons (main menu icon, settings, shop).
- Pause game during request + show. Block UI (disable buttons / spinner) until `adFinished` or `adError`. Requests are not instant (auctions).
- Handle `adError` (unfilled / timing / adblock / low demand) — continue game normally.
- Mute in-game audio only when ad actually starts playing, unmute on finish. Don't mute on request (may be no-fill and feels broken).
- Frequency managed by SDK (max 1 midgame / 3min, interplay with rewarded). Request at every opportune moment; early requests are ignored safely.

## Rewarded

Design as occasional delight, not progression tax. Levels requiring rewarded to complete = reject.

Placement/frequency:
- Not too often. Show timer or hide button when on cooldown.
- No chaining (watch 2 videos for 1 reward).
- Don't aggressively promote. No button on active gameplay screen (e.g. no button during race).

Reward UI:
- Consistent accessible location.
- Not misleading. Continue-without-ad must be same size/font/color. Skip/close never hidden/delayed.
- Clear it's optional + requires watching ad (video icon).
- Provide alternative (e.g. buy with earned coins).

Callbacks:
- `adFinished` -> celebrate reward (animation/notification).
- `adError` -> DO NOT reward. Provide fallback incentive. See AdBlock below.

Examples that work: in-game store bonus, end-of-level multiplier, occasional out-of-lives (NOT every death).
Out-of-lives rules:
- Not every death. Timer + coin alternative + "try later" when no fill.
- Between 2 levels: either midgame + restart OR rewarded-continue, never both.

## Banners

- Only on content screens open ~5s avg. Never during gameplay.
- Must not block UI on any size incl. mobile. Clearly distinct from game content.
- Max 2 per screen, non-intrusive.
- Note perf cost.

## AdBlockers

Detection is imperfect (~not 100%). Rules:
- AdBlock players must play normally. Never block or disadvantage them.
- May gate extras/special features with inline notice (not popup — breaks fullscreen + conflicts with CG notices).
- Don't leave rewarded buttons clickable with no effect.
