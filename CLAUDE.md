# CLAUDE.md — gamey

@AGENTS.md

AGENTS.md holds the project rules (dual build, adapter gating, git workflow, commands). This file adds the map, QA rules, locked design and gotchas distilled from `specs/`, `context/` and the code.

## Read first
- `context/`: design is spread across all dated files (2026-09-24 … 2026-10-02). Read newest to oldest; later "corrections" sections override earlier numbers. Append-only: same-day edits go in the same file.
- `specs/crazygames/`: check before touching ads, login, promos, fullscreen, or external requests.

## Architecture
- `src/main-basic.ts` / `src/main-full.ts` (4 lines each) call `boot(root, adapter)` from `src/ui/home.ts`. There is no `src/boot.ts`.
- `src/ui/home.ts` (~1800 lines): home, shop, `runSeries` (best-of-3, first to 2), `runDeathmatch` (endless 3-duel loops, HP carries over), `runDuel` (frame loop, hits, wounds, revive, AI scheduler). DEV-only `window.__gamey` probe.
- `src/ui/focus.ts`: focus pads/keys. iOS audio resume on `touchend` lives in `boot` (`home.ts`).
- `src/portal/`: `PortalAdapter.ts` (interface + `Progress`), `NoopAdapter.ts` (real basic impl), `CrazyGamesAdapter.ts` (stub, no SDK yet).
- `src/game/`: pure logic (`DuelMachine` seeded 60Hz + `rollWound`, `damage`, `economy`, `projectiles`, `Transport`, `fixedStep`). Never import render, DOM, or SDK here.
- Frame loop (`home.ts` `frame()`): one `createFixedStepper` (`src/game/fixedStep.ts`) runs `machine.step`, recoil recover, `stepBullets()` and ragdoll `fixedStep(h)` inside its fixed callback; afterwards `doll.follow()` (alive) / `doll.sync(alpha)` (corpse) and `renderBullets(alpha)` interpolate. New physics goes inside that callback, never per frame.
- `src/render/`: `arena`, `cowboy` (procedural fallback), `cowboyGlb`, `streetGlb`, `ragdoll` (cannon-es, 10 bodies), `smoke`, `hell` (lazy chunk).
- `src/store/SafeStore.ts`: the only way to touch localStorage (key `gamey.v1`).
- Build selection is by entry file. `__GAMEY_BUILD__` is defined in `vite.config.ts` but unused in `src/`.
- `blender/cowboys.blend` stays out of `public/` so it doesn't ship. GLBs live in `public/models/`.

## Commands (beyond AGENTS.md)
- `npm run size:full` (50MB budget), `play`, `play:mobile`, `play:record`, `test:headed`.
- `npm run test:physics` (in `npm test`): pure-Node check that a synthetic ragdoll + bullets are bit-identical at 30/60/120/144/165/240Hz and never stall a rendered frame. `npm run build:models`: regenerate GLBs (see Gotchas).
- `ai:play*` needs the dev server on port 5174 and fetches `tsx` via `npx` (not a dependency).
- Playwright specs in `tests/` (`duel-combat`, `duel-wounds`, `visual-duel`, ...) run against the dev server. They are NOT part of `npm test`, and `tests/` is not typechecked.
- Playwright global timeout is 150s; per-test timeouts are ignored.
- `npm run ai:wounds[:mobile]`: gameplay + profile frames of none/bend/crouch/prone and the numbers vs the hit capsules (visible head must be within ~0.1m of `CAPSULE_FOR_POSE.headY`). Wound poses are procedural (`WOUND_POSE_TARGET`/`WOUND_JOINTS` in home.ts), tuned to the capsules; details `context/2026-10-04.md` §6.
- Playwright wipes `test-results/` every run — run the `ai:*` capture scripts AFTER it.
- `npm run ai:ragdoll` / `ai:ragdoll:mobile`: CDP-screencast capture of foe head/body kills and player death (frames + part-position timeline in `test-results/ai-ragdoll/`). Foe frames start ~150ms before the lethal shot (frame names are ms relative to kill DETECTION, so pre-shot frames are negative). The screencast runs ~5fps headless, too coarse to rule out a single-frame snap. The "from-prone" scenario really ends from bend/crouch, because the first non-lethal hit re-rolls the wound. Needs dev server on 5174; `HEADLESS=0` to watch.
- Phase-2 slice gate: `ai:play` and `ai:play:mobile` with zero errors.

## CrazyGames QA rules that affect code
- Size: 50MB initial, 20MB for mobile homepage. With no SDK, total counts as initial.
- Legible at DPR=1 from 907x510 to 1920x1080 and mobile 800x450.
- Physics must hold at 60/144/165Hz: everything runs on the shared fixed 1/60s stepper and renders interpolated by alpha. Never step by frame count.
- English required. Avoid Esc and Ctrl/Cmd+W. No custom fullscreen button. No cross-promo.
- `user-select:none`. Resume the `AudioContext` inside a gesture. Relative paths only.
- Guests can always play. No external logins.
- Ads off (basic build): no freezes, no dead rewarded buttons. Rewarded ads are optional with an equal-size no-ad option.

## Locked design (summary)
- Cowboy duel, ortho over-the-shoulder camera, no blood (dust puff only).
- Flow: RoundIntro, Focus 3.0s, DRAW!, Fire, Resolve. Countdown runs only while the pointer is in the holster zone.
- Guns: default 49 dmg / 380ms, lifesteal 38, gold 37. Falloff 1.00 at 9m, 0.92 at 11m, 0.70 at 14m (body only). Head is an instant kill.
- AI reaction: `base * 0.97^round * 0.94^level`, floor 180ms.
- Double KO leads to hell sudden-death (1 bullet each, loops on double miss).
- Revive: one token per game, singleplayer only. Revive ad is Full-only.

## Gotchas
- GLB export: apply modifiers, use active collection only. The loader culls named objects not starting with `H_` or `O_`. Models self-center. All GLB and ragdoll code must be null-safe with a procedural fallback.
- Blender/GLBs: regenerate with `npm run build:models` (`scripts/blender/build_glbs.py`, headless, never saves `blender/cowboys.blend`). Do NOT hand-edit and save the .blend: NLA HOLD strips + save/reload do not round-trip rest-pose/pivot edits. Verify any new GLB by diffing ALL node TRS vs the previous good one (names, 28 anims, ~4.4k tris). Clip keys live in `CLIP_KEYS` in `build_glbs.py`, not the .blend. Live addon socket `127.0.0.1:9876` is for visual iteration only. Details: `context/2026-10-04.md` §5, §11.
- Clips that actually show: `idle` (until DRAW, then stopped for both duelists), `flinch` (released at `FLINCH_END`), `victory`/`defeat` (living duelists only, never a corpse). `fall_*` only plays if the ragdoll fails or a GLB loads post-mortem; `draw`/`cock` are never played. Procedural code owns the arms from DRAW: a looping clip rewrites `armR`/`elbowR` every mixer update and beats any chase.
- Gun arm: `stabilizeArm` puts `armR` on a mount that cancels the body's wound pitch+roll, so arm angles are standing-frame at any pose (no per-pose arm compensation needed).
- Ragdoll (`render/ragdoll.ts`): 10 bodies joined by `RagdollJoint` (ConeTwist with a fixed twist reference = the character's lateral axis; stock cannon twist refs start violated between non-aligned bodies and tore shoulder/elbow 0.3-0.5m). Cannon pivots are in the body's LOCAL frame (world offsets tore limbs apart); the forearm box excludes the gun; judge settle speed WITHOUT a CDP screencast (it slows the sim). `__gamey.jointErrors(side)` = physics pivot gaps; the round's `cleanup()` disposes the doll ~1.3-1.5s post-kill (visuals stay frozen), so read physics early. `context/2026-10-04.md` §7, §11.
- Projectiles need 8 substeps per tick or they tunnel through the head.
- HUD is fixed px. Tests assert DOM selectors (`.cue`, `.hp.you i`, `.chamber.live`, `.crosshair`), so HUD refactors break them.
- Don't delay `GameplayStart`. Keep hell and GLB assets lazy.
- Shop prices (100/120/50) and best-of-3 are NOT user-locked.

## Known drift / open items
- Tri budget blown (~14k vs 3-5k). Music/SFX, covers and preview videos are not made.
- `context/2026-10-01.md` is referenced but missing.
- `TESTING.md` lists only 3 of 5 specs. `scripts/smoke-probe.mjs` hardcodes port 5199. `test-output.log` is stale.
