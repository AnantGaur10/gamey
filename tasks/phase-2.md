# Phase 2 — Task List

Status 2026-10-05: all 9 slices implemented and gated (context/2026-09-30.md §5, 2026-10-04.md §11). Remaining items are tagged PENDING.

Scope locked: full step 2 (projectiles, hitboxes, AI fire, ragdoll, best-of, time-of-day) + hell sudden-death + economy/revive UI + gunsmoke + Blender animation clips.
Decisions locked: full Blender clip set, light-wisp gunsmoke.
Tail for Phase 3 (NOT here): full deathmatch rules, roster stat variety, baked 1024 textures, music/SFX files, covers/videos/metadata.

Gates for EVERY slice: `npm test` (= typecheck + build:basic + size:basic <20MB) + `npm run ai:play` and `ai:play:mobile` zero errors with screenshots. No `src/game/` SDK imports. No fullscreen/promo/login/external changes. Relative paths only. `GameplayStart` timing preserved (hell/anims lazy).

## Slice 0 — Gunsmoke + muzzle flash (independent, can go first) — DONE (src/render/smoke.ts)
- [x] New `src/render/smoke.ts`: pooled `THREE.Sprite`s (~12), procedural radial-gradient canvas texture (zero shipped bytes). Spawn at `gunTip` world pos on every shot (player AND foe). Fast expand, slow rise, fade ~0.8s. `depthWrite:false`, capped pool, ortho-safe soft alpha.
- [x] 2-frame muzzle-flash quad (feeds locked night-readability rule: silhouette + flash at night, `context/2026-09-24.md` §11).
- [x] Hook into `attemptFire` (`src/ui/home.ts:413`) and the Slice-2 AI fire path.
- [x] Verify: ai-play screenshot shows wisp at muzzle, zero errors, `size:basic` unchanged.

## Slice 1 — True projectiles + capsule hitboxes — DONE (src/game/projectiles.ts)
- [x] New `src/game/projectiles.ts` (pure logic, no SDK/render imports): pooled bullets, fixed-60Hz integrate (`pos += vel*dt`, slight gravity, life = `dist/speed + 1s`), sphere-vs-capsule per-step collision, seeded. Emit over existing `Fire{pos,dir,gunId,tick}` / `Hit{tick,head,damage}` envelope (`src/game/Transport.ts:7-9`) via `LocalTransport`.
- [x] `src/ui/home.ts`: muzzle spawn from `player.gunTip` world pos/dir. Spread from `machine.sampleSpread` applied to bullet dir. REPLACE screen-space radii test (`home.ts:445/452`). Retire `drawBulletTracer` in favor of the visible bullet.
- [x] Do NOT touch: damage, falloff (`damage.ts`), TTK bands, cooldowns (`economy.ts` locked numbers).
- [x] Verify: ai-play HITs at all ranges, DPR-1 legible, full gates PASS.

## Slice 2 — AI fire (foe shoots back) — DONE
- [x] Foe driven by existing `AI_ROSTER` (`src/game/economy.ts:67-71`): `reaction = base*0.97^round*0.94^level`, floor 180ms; `focusQuality` shrinks its bloom, `accuracyMult` widens aim error. Same projectile path as player (symmetric, net-ready).
- [x] Flinch both ways per locked `context/2026-09-26.md` §3.
- [x] Foe muzzle smoke + flash reuse Slice 0. Foe gunshot via existing `playGunshotSynth` (quieter).
- [x] Verify: ai-play shows exchanges, player HP sometimes drops, no kill-RNG feel.

## Slice 3 — cannon-es hit-point ragdoll (replaces tip-over) — DONE (src/render/ragdoll.ts, now 10 bodies)
- [x] Per locked `context/2026-09-24.md` §9: ~8 bodies (pelvis/torso/head/upper-arms/legs), kinematic while dueling. On `Hit` → dynamic + `applyImpulse(bulletDir*gunPower, hitPoint)` + torque. Fixed-60Hz accumulator, render interpolates, sleep + cull after settle.
- [x] Mesh↔body binding for BOTH procedural (`cowboy.ts`) and GLB (`cowboyGlb.ts`) builds.
- [x] Keep `setFall` tip-over as null-safe fallback if physics fails (same philosophy as GLB swaps).
- [x] Blender input: confirm object origins at pivots for clean body fitting (fold into Slice 8 session).
- [x] Verify: death pose varies with hit point, settles, mobile perf clean.

## Slice 4 — Best-of loop — DONE (runSeries)
- [x] Series state around `runDuel`: full-HP resets, most-rounds-wins, round counter HUD, winner flow back to home.
- [x] `award()` (`src/ui/home.ts:698`) becomes real: 10g Best-of win + 2g consolation + kill bonus (locked `context/2026-09-26.md` §4).
- [x] Verify: ai-play multi-round (extend second-round logic stubbed in `tests/ai-play.ts:283`).

## Slice 5 — Time-of-day driver — DONE
- [x] `roundIndex` → existing `setTimeOfDay` (`src/render/arena.ts:434`) + CSS sky retint (old-CSS-sky-only gap, open thread `context/2026-09-29.md` §16) + lantern emissive boost at night. R1 noon → R2 evening → R3 night → R4+ night.
- [x] Night keeps ~15% enemy ambient + rim + muzzle flash. DPR-1 readability check MANDATORY (QA fail risk).
- [x] Verify: ai-play screenshots per round show the grade; mobile legible.

## Slice 6 — Hell sudden-death (double KO) — DONE except the live-fired verify
- [x] Lazy chunk loaded AFTER `GameplayStart` (never in initial payload — QA gate). Dark rock ground, emissive scrolling lava strips (shader, no particles), red fog/lighting, black-red sky.
- [x] Locked rule (`context/2026-09-24.md` §12): lethal-in-flight-fired-before-death counts, must actually hit; hell rounds 1-bullet each, both-miss loops until someone hits; winner takes point.
- [ ] PENDING — Verify: forced double-KO test → hell loads, loop resolves, winner takes point. (hell is implemented — context/2026-09-30.md §5 Slice 6 — but the loop was only code-reviewed, never live-fired.)

## Slice 7 — Economy + revive UI — DONE
- [x] Real `award()` gold flow. Shop prices: TBD — propose numbers, get user approval before locking.
- [x] Revive token buy + death-screen emergency buy at `ceil(1.5x)` (`economy.ts:82`). Once per game, 1HP + Focus restart. Ad button Full-only behind flag; Noop hides it (locked `context/2026-09-26.md` §6).
- [x] No mid-run spending, no progression gates (portal QA rules — check `specs/crazygames/` before wiring).
- [x] Verify: buy/equip/revive flows in basic (zero dead buttons) + full stub.

## Slice 8 — Blender animation clips (full set, one Blender sitting) — DONE
- [x] Clips to author: idle sway loop, DRAW raise flourish, hammer-cock, hit-flinch, victory pose, defeat pose. Death stays ragdoll; gun-arm aim stays procedural.
- [x] Seam rules: clips on existing empty hierarchy (`H_/O_armR/elbowR/gunTip`) + new pivot empties (e.g. `O_Lean`); loader wraps `inner` in an `anim` group so idle/victory never fight `setFall` on the outer group. Procedural arm owns `armR/elbowR` during aim — DRAW flourish IS the auto-raise: plays pre-engagement when GLB present, procedural `poseArm` raise stays fallback and takes over on first input. Flinch/victory play only in Resolve.
- [x] Same session also: place origins at pivots (Slice 3 fitting), deepen street tones (open thread `context/2026-09-29.md` §16; superseded by the street rebuild in `tasks/2026-10-05-street.md`), UNLINK `St_Sign_*` from Outlaw collection (TEL-fix leftover, `context/2026-09-30.md` §2), re-export per recipe (`use_active_collection`, collections audit — loader guard backstops leaks).
- [x] Mixer playback in `cowboyGlb.ts` (+ procedural no-op path so behavior identical without GLB).
- [x] Verify: clips play on GLB builds, fallback identical, re-export audit zero strays, size PASS.

## Slice 9 — QA sweep (after all slices) — PARTIAL
- [x] `qa.html` iframe matrix (all sizes incl. 800x450 mobile, DPR-1), portrait side-bars.
- [ ] PENDING — Night-round readability, hell-round readability (code paths exist; no recorded DPR-1 readability pass at night/hell yet).
- [ ] PENDING — AdBlock run (basic, no dead buttons), private-mode storage run (covered by design per context/2026-09-30.md §5 Slice 9 — SafeStore memory fallback; never actually run in a browser).
- [x] Append results to `context/YYYY-MM-DD.md` (same-day file, append never overwrite).
