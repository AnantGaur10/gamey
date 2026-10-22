# HIGH NOON DUEL: store metadata (CrazyGames Developer Portal)

Paste-ready text for the portal. Every claim maps to code (sources in
brackets, delete them when pasting). Covers: `store/covers/` (built by
`npm run build:covers`). Preview videos are not made yet.

## Name

HIGH NOON DUEL

## Genre / tags

Shooting, Western, Cowboy, 3D, Reflex, Duel, Singleplayer

## Short description

A quick-draw cowboy duel. Focus your aim, draw when the cue drops and put
your rival in the dirt before he puts you there.

## Description

Six bullets, one outlaw, one street. HIGH NOON DUEL is a 3D quick-draw
showdown: keep your hand on the holster while the clock runs, steady your aim,
and fire the moment the cue says DRAW!

- **Focus before the draw.** Stop the swinging marker on the gold arc to
  tighten your crosshair. Every perfect press narrows it more, every miss
  costs you time. [`src/game/timingQte.ts`, `src/ui/focus.ts`]
- **Aim for the head.** A headshot (hat included) always kills. Body hits
  drop your rival into a crouch or flat on his back, and he keeps shooting,
  so re-aim and finish the job. [`src/game/projectiles.ts`, `context/2026-10-21.md` §1]
- **Pace your shots.** Every shot kicks your crosshair wide and every hit you
  take throws it wider. Spraying all six bullets rarely works.
  [`DuelMachine.applyShotKick/applyFlinch`]
- **Noon, dusk, night.** Each decided round of a best-of-3 gets darker. At night
  your rival vanishes into the dark and only his muzzle flash gives him away.
  [`timeOfDayForRound`, `src/render/arena.ts`]
- **Ten gunslingers.** Climb a ladder of ten named rivals, from Greenhorn Gus
  to The Widow, each one faster and deadlier than the last.
  [`src/game/levels.ts`]
- **Sudden death.** Both duelists down at once? One more round, full
  cylinders, and the first hit wins. [`context/2026-10-05.md` §12]
- **Deathmatch.** Duel after duel on one life, and your health carries over.
  How many can you outdraw? [`runDeathmatch`]
- **Four places to fight:** Main Street, the Saloon, The Falls and
  Telegraph Row, at random or your pick. [`src/render/maps.ts`]
- **Armory.** Earn gold with every win and spend it on new revolvers (a
  lifesteal gun that heals on every hit, a gold gun that pays more) and a
  revive token. [`src/game/economy.ts`, shop in `home.ts`]

A short tutorial teaches the draw on your first visit. You can replay it any
time from HOW TO PLAY.

## Controls

Desktop:
- Mouse: move into the HOLSTER box to start the countdown (leaving it restarts the countdown)
- Space / Enter: stop the Focus marker on the gold arc
- Mouse: aim
- Left click: fire

Touch:
- Tap the HOLSTER box to start the countdown
- Tap anywhere: stop the Focus marker on the gold arc
- Drag: aim
- Quick tap: fire

## Notes for the portal form

- Singleplayer only. Guests can play without signing in. Progress saves
  through the CrazyGames Data module when the SDK loads, and falls back to
  local storage otherwise.
- No ads in Basic Launch (`ADS_ENABLED=false`).
- English only.
- Orientation: landscape (plays on desktop and mobile; mobile viewport
  tested down to 800x450).
