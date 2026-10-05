# CrazyGames — Account Integration

Source: https://docs.crazygames.com/requirements/account-integration
35M+ CG accounts. Goals: no standalone username/avatar needed, no extra login flows, guests can always play.

## Scenarios

1. **No accounts in game (Basic OK):** no `User` module needed. Use `Data` module or APS for progress.
2. **Use CG profile (Full):** fetch user via `User` module. `null` = guest, continue as guest. Show username/avatar. Save via `Data` or APS.
3. **In-game account, Basic (pre-integration):** allow guests + registered CG users to play as guests by default. DISABLE external logins (Facebook/Google/email). Must fully integrate once successful.
4. **In-game account, Full:** auto-register/login CG users via `userId`, guests play as guests, no in-game logout to external logins. You own progress migration if offering import/export.

## Progress save (Full, required unless N/A)

1. Preferred: `Data` module (guest saved locally, synced to cloud on login if no cloud data).
2. Own backend: link via `User` module `userId`. Handle multi-device + shared device.
3. Alternative: Automatic Progress Save (APS, syncs local -> cloud). NOT allowed with IAP (relies on local data).

## In-game account logic (Full)

Prep: use CG `userId` (unique string, stable; username/avatar change) as key. Get via `getUserToken()` JWT, verify on your server. Request every launch.

- **Not logged in (`userNotAuthenticated`):** start as Guest (main path). Recommend NOT creating in-game account; if you do, must link to CG account on login. Don't rely solely on local data (shared devices). Optional `Login with CrazyGames` button, not main CTA. Don't auto-trigger Auth prompt.
- **Logged in (`userId` returned):** if known -> update username/avatar, fetch backend data, play. If unknown -> auto-create account keyed on `userId`; optionally migrate guest local progress.
- **During play:** listen via Auth Listener. Guest logs in mid-game -> run logged-in flow, refresh if needed. Logout = full page refresh, nothing to do.
- **Login button:** top-right, not blocking CTA, calls Auth prompt. Guests only get `Login with CrazyGames`, no other methods.
- **Logout/linking:** no in-game logout to external options. Import/export allowed if you migrate correctly. Use optional Account Link prompt (strongly recommended if you create accounts for guests; recommended with IAP).
