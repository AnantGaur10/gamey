# CrazyGames — Multiplayer

Source: https://docs.crazygames.com/requirements/multiplayer
Multiplayer = ~2x long-term retention. `Play with Friends` + Multiplayer landing page.

## How it works

- Friends feature requires CG account + login. Friend requests, join when in joinable location, invite online friends via notification. SDK `Game` module powers it.

## Full requirements (for Multiplayer landing page)

- **Room sharing:** use `Update Room` (`room` unique ID, `isJoinable`, `inviteParams` for inviter->friend data). Legacy Invite Button still supported. No unskippable onboarding for joiners.
- **Invite Link:** integrate if you allow copyable direct invites.
- **Instant Multiplayer:** if `IsInstantMultiplayer=true`, launch straight into multiplayer from CG UI (e.g. landing page). Config screen (mode/count) OK. 20+ player games may drop into public play. Must be joinable immediately.
- **Round-based:** stay with same group without returning to CG UI — next match same room or all to same new room.
- **Lobby size:** submit sizes on build upload (contact team for changes).
- **Usernames:** display CG usernames in-game so friends recognize each other.

## Guidelines (strongly recommended)

- Join anytime; spectator mode if round in progress, else "room unavailable" popup.
- Implement Room Join Listener for no-reload joins (users often pre-load game).
- Use `User.getFriends()` for UX (join/notify/matchmake).

## Basic Launch for multiplayer

- Large-audience-dependent multiplayer may skip Basic -> direct Full (must meet Full reqs).
- Single-player-capable / small-testable games must do Basic first.
- QA decides flow.

## Chat + UGC (Basic + Full)

- Respect SDK `game settings` to disable chat. On complaints, must disable entirely.
- Moderation required: min profanity filter (see their Google-sheet wordlist). Advanced: AI moderation via Lasso Moderation (referral bonus, partners page). Not recommended to do AI for Basic.
- Same for UGC (custom images/drawings) — Lasso covers it.
