# CLAUDE.md — gamey

@AGENTS.md

AGENTS.md holds the project rules (dual build, adapter gating, git workflow, commands). This file adds the map, QA rules, locked design and gotchas distilled from `specs/`, `context/` and the code.

## Read first
- `context/`: design is spread across all dated files (2026-09-24 … 2026-10-02). Read newest to oldest; later "corrections" sections override earlier numbers. Append-only: same-day edits go in the same file.
- `specs/crazygames/`: check before touching ads, login, promos, fullscreen, or external requests.

## Task tracking (user rule, 2026-10-05)
- Before executing any task, break it into small steps in `short-term-tasks/<YYYY-MM-DD>-<slug>.md` (checkbox list, user quote + decisions on top).
- Tick steps off as they land, and keep the file current when the plan changes.
- When the task is done or cancelled, delete its file. `short-term-tasks/` only holds live work; the history lives in `context/` and git. (`tasks/` is the older long-form folder.)

## Architecture
- `src/main-basic.ts` / `src/main-full.ts` (4 lines each) call `boot(root, adapter)` from `src/ui/home.ts`. There is no `src/boot.ts`.
- `src/ui/home.ts` (~1800 lines): home, shop, `runSeries` (best-of-3, first to 2), `runDeathmatch` (endless 3-duel loops, HP carries over), `runDuel` (frame loop, hits, wounds, revive, AI scheduler). DEV-only `window.__gamey` probe.
- `src/ui/focus.ts`: focus timing-QTE ring (SVG on the foe's body, radius = crosshair radius; draw + Space/Enter); the QTE logic is `src/game/timingQte.ts` (fixed clock, seeded). iOS audio resume on `touchend` lives in `boot` (`home.ts`).
- `src/portal/`: `PortalAdapter.ts` (interface + `Progress`), `NoopAdapter.ts` (real basic impl), `CrazyGamesAdapter.ts` (stub, no SDK yet).
- `src/game/`: pure logic (`DuelMachine` seeded 60Hz + `rollWound`, `damage`, `economy`, `projectiles`, `Transport`, `fixedStep`). Never import render, DOM, or SDK here.
- Frame loop (`home.ts` `frame()`): one `createFixedStepper` (`src/game/fixedStep.ts`) runs `machine.step`, recoil recover, `stepBullets()` and ragdoll `fixedStep(h)` inside its fixed callback; afterwards `doll.follow()` (alive) / `doll.sync(alpha)` (corpse) and `renderBullets(alpha)` interpolate. New physics goes inside that callback, never per frame.
- `src/render/`: `arena`, `cowboy` (procedural fallback), `cowboyGlb`, `streetGlb`, `ragdoll` (cannon-es, 10 bodies), `smoke`, `hell` (lazy chunk).
- `src/store/SafeStore.ts`: the only way to touch localStorage (key `gamey.v1`).
- Build selection is by entry file. `__GAMEY_BUILD__` is defined in `vite.config.ts` but unused in `src/`.
- `blender/cowboys.blend` stays out of `public/` so it doesn't ship. GLBs live in `public/models/`.

## Commands (beyond AGENTS.md)
- `npm run size:full` (50MB budget), `play`, `play:mobile`, `play:record`, `test:headed`.
- `npm run test:physics` (in `npm test`): pure-Node check that a synthetic ragdoll + bullets are bit-identical at 30/60/120/144/165/240Hz and never stall a rendered frame. `npm run build:models`: regenerate the cowboy GLBs; `npm run build:street`: regenerate `street.glb` (see Gotchas).
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
- Cowboy duel, right-shoulder PERSPECTIVE 3rd-person camera (player left third, foe right of centre; `context/2026-10-05.md` §9), no blood (dust puff only).
- Flow: RoundIntro, Focus 3.0s, DRAW!, Fire, Resolve. Revolvers start HOLSTERED with the gun hand on the grip; at DRAW both quick-draw (0.3s: grip, pull, swing to level) and the player cannot fire for `DRAW_TICKS` = 10 fixed ticks (0.167s) while the gun clears (`context/2026-10-05.md` §16). Focus is a timing QTE ring centred on the HOLSTER zone (not the foe: it would give his position away) whose radius is the crosshair radius (stop the swinging marker on the gold arc; every press moves the zone, a hit narrows it + speeds the needle, a miss widens it; chain hits until DRAW). PC: leaving the holster zone restarts the whole Focus (3.0s, bloom, QTE) on return; touch is committed once started. `context/2026-10-05.md` §5.
- Guns: default 49 dmg / 380ms, lifesteal 38, gold 37. Falloff 1.00 up to 9m, 0.92 at 11m, 0.70 at 14m, same slope on to a 0.55 floor (~16m+) (body only). Head is an instant kill.
- Duel distance: uniform 6-25m every round, hell included (`DUEL_RANGE_*` in `damage.ts`), shown on the round line.
- Crosshair: a player shot kicks it x1.5, then it returns to the pre-shot size with an ease-in over 0.6s (stacks; ceiling bloomMax x1.5). A hit (flinch, both ways) rubber-bands it out with one overshoot, then the same return. `DuelMachine.applyShotKick/applyFlinch/recoverKick`, fixed clock. `context/2026-10-05.md` §17.
- AI reaction: `base * 0.97^round * 0.94^level`, floor 180ms.
- Double KO leads to hell sudden-death: ONE round, full cylinders, first landed hit wins (any body hit kills), never repeats (all-miss = drawn round), no revive in hell. `context/2026-10-05.md` §12.
- Wound lottery: hit 1 = crouch (lunge), hit 2+ = crouch 60 / prone 40 (prone = on the back). `bend` stays in the tables but is never rolled. Wounds never gate lethality.
- Revive: one token per game, singleplayer only. Revive ad is Full-only.

## Gotchas
- GLB export: apply modifiers, use active collection only. The loader culls named objects not starting with `H_` or `O_`. Models self-center. All GLB and ragdoll code must be null-safe with a procedural fallback.
- Blender/GLBs: regenerate with `npm run build:models` (`scripts/blender/build_glbs.py`, headless, never saves `blender/cowboys.blend`). Do NOT hand-edit and save the .blend: NLA HOLD strips + save/reload do not round-trip rest-pose/pivot edits. Each cowboy is merged to 15 meshes (one per KEEP node in `build_glbs.py`: the nodes the game reads by name + `{P}_Hat` + `{P}_CoatTail_L/R`) with one material `M_Cowboy` and palette x baked AO in COLOR_0 (metals pre-darkened). A new node the game must read has to join `KEEP`, or it gets merged away. Verify any new GLB by diffing the KEEP nodes' world TRS and the world vertex set vs the previous good one (28 anims, 4348/4392 tris). Clip keys live in `CLIP_KEYS` in `build_glbs.py`, not the .blend. Live addon socket `127.0.0.1:9876` is for visual iteration only. Details: `context/2026-10-04.md` §5, §11.
- Street set: `scripts/blender/build_street.py` is the ONLY source (byte-identical output per run; `blender/street_snapshot.blend` is a view-only copy, edits there never reach the GLB). Node contract with `streetGlb.ts`: `S_Paint` (static, vertex colours), `S_Glow` (material `M_Glow`, emissive driven by time of day), `A_*` pivoted parts animated by name (`A_BatL/R`, `A_SignWhiskey/Rooms`, `A_HorseHead/Tail`, `A_CatTail`, `A_Rocker`, `A_Laundry`, `A_Tumble`); renaming one silently freezes it. Colour = palette x Cycles AO x ray-cast sun shadow (`sun_shadow()`; the Cycles SHADOW bake is unbounded, never use it), clamped to 1. Street tris (~33k incl. the backdrop, 12 draw calls, ~1.3MB) have their own budget, separate from the 3-5k cowboy budget. `left_row()` (bank, assay office, barber, church with steeple, x -20..-42) and `backdrop()` (camera-facing `ridge()` curtains of mesas/buttes/spires at y -70/-120/-190 + windmill + water tower, all in `S_Paint`) cover the wide views of long duels (2026-10-06); `face()` winding is the reverse of what reads naturally, check new faces in a capture. `__gamey.tod(i, hell?)` (DEV) forces a round's time of day for look-dev captures. `context/2026-10-05.md` §4.
- Render look (`context/2026-10-05.md` §8): the camera is a `PerspectiveCamera` (`FOV_Y`/`CAM_*` in `arena.ts`, positive near; it replaced the negative-near ortho cam, §9). Screen size of a world length is depth-dependent: use `worldPerPxAt(point)`, never a global scale. The kill punch animates `camera.zoom` (narrows the FOV). No shadow map: duelist shadows are `createShadowDecal` quads along the baked sun (a real-time map cost ~40% frame time on software GL). Ground detail is `addDirtDetail` (world-XZ shader injection) shared by the arena ground AND the street's `S_Paint`, so the two floors match; keep it on both. Pixel ratio is capped (2, 1.5 on touch) and a one-way watchdog (`noteFrame`) drops it to 1 on slow frames. Cosmetic FX (dust puffs, tracers, ambient particles, kill zoom) are time-based and never touch the bullet sim. Cue/title font is Rye (`src/assets/rye-latin.woff`, OFL). DEV probes `__gamey.info()` (draw calls of the whole frame incl. 2 post passes, pixel ratio) and `__gamey.fx()` (live puffs). Since 2026-10-06 (`context/2026-10-06.md`): opaque canvas, no MSAA; `arena.render()` = scene -> 8-bit linear target -> ONE `render/post.ts` pass (FXAA, then tint + saturation, ACES tone map, sRGB, contrast); the `noteFrame` watchdog's second stage drops that pass for the session if frames stay slow at 1x (direct render, materials tone-map themselves; software GL always lands here, so headless captures show the direct path); the sky is an in-scene screen-space quad (`TimeOfDay.sky`); per-time-of-day `grade` and cowboy `rim` (`addRimLight`, added before fog so night fog still hides the foe) live in `TimeOfDay`. Cowboys (GLB + procedural) are `MeshLambertMaterial` flat. Hat/coat-tail sway (`render/sway.ts`) steps on the fixed clock; the hit camera shake is render-only (camera restored right after the draw).
- Hell set: `scripts/blender/build_hell.py` (`npm run build:hell`, deterministic) is the ONLY source of `public/models/hell.glb` (nodes `X_Paint`, `X_Glow`; causeway top z=0 = game ground). `render/hell.ts` keeps a procedural fallback + the runtime shaders (lava, sky, eclipse, runes). Night difficulty is FOG density (`NIGHT.fogDensity`), with fog-free muzzle flashes as the giveaway. `context/2026-10-05.md` §13-14.
- Clips that actually show: `idle` (hand on the holstered grip, solved in `build_glbs.py`; until DRAW, then stopped for both duelists), `flinch` (released at `FLINCH_END`), `victory`/`defeat` (living duelists only, never a corpse). `fall_*` only plays if the ragdoll fails or a GLB loads post-mortem; `draw`/`cock` are never played. Rig nodes `{P}_Gun` (revolver as one node under elbowR, origin at the grip) and `{P}_GunHolster` (socket on the Pelvis) drive `holster()`/`drawStep(k)` (`makeGunHolster` in `cowboy.ts`); the holster mesh is fitted to the holstered gun in the build. Procedural code owns the arms from DRAW: a looping clip rewrites `armR`/`elbowR` every mixer update and beats any chase.
- Gun arm: `stabilizeArm` puts `armR` on a mount that cancels the body's wound pitch+roll, so arm angles are standing-frame at any pose (no per-pose arm compensation needed).
- Ragdoll (`render/ragdoll.ts`): 10 bodies joined by `RagdollJoint` (ConeTwist with a fixed twist reference = the character's lateral axis; stock cannon twist refs start violated between non-aligned bodies and tore shoulder/elbow 0.3-0.5m). Cannon pivots are in the body's LOCAL frame (world offsets tore limbs apart); the forearm box excludes the gun; judge settle speed WITHOUT a CDP screencast (it slows the sim). `__gamey.jointErrors(side)` = physics pivot gaps; the round's `cleanup()` disposes the doll ~1.3-1.5s post-kill (visuals stay frozen), so read physics early. `context/2026-10-04.md` §7, §11.
- Projectiles need 8 substeps per tick or they tunnel through the head.
- HUD is fixed px. Tests assert DOM selectors (`.cue`, `.hp.you i`, `.chamber.live`, `.crosshair` `--gap`, `.qte .qtrack/.qfill/.qres`) and aim through `__gamey.aimAt('foe')` (the foe is NOT at screen centre) and the cue words `HOLSTER UP` / `FOCUS` / `DRAW`, so HUD refactors break them. Tests time QTE presses through the DEV `__gamey.qte()` probe (`qteHits()` helper).
- Don't delay `GameplayStart`. Keep hell and GLB assets lazy.
- Shop prices (100/120/50) and best-of-3 are NOT user-locked.

## Known drift / open items
- Music, covers and preview videos are not made (gunshots + wind are Web Audio synth in `AudioManager`, `context/2026-10-05.md` §15; hit SFX files still missing).
- `context/2026-10-01.md` is referenced but missing.
- `TESTING.md` lists only 3 of 5 specs. `scripts/smoke-probe.mjs` hardcodes port 5199. `test-output.log` is stale.
