# Testing Guide — gamey

Visual testing system using Playwright + WSLg (visible browser windows on Windows desktop from WSL).

## Quick Start

```bash
npm run play
```

Opens a headed Chromium browser where you can play the game manually. Browser window appears on your Windows desktop via WSLg. Stays open for 10 minutes or until Ctrl+C.

## Available Commands

### Manual Play (Interactive)

| Command | Description |
|---------|-------------|
| `npm run play` | Play at 1920x1080, 300ms slowMo |
| `npm run play:mobile` | Play at 800x450 (mobile viewport) |
| `npm run play:record` | Record video to `test-results/videos/` |
| `VIEWPORT=1280x720 npm run play` | Custom viewport size |
| `SLOW_MO=0 npm run play` | No artificial slowdown |

### Automated Tests (Headed)

| Command | Description |
|---------|-------------|
| `npm run test:headed` | Run visual test suite (desktop-1920 only), headed |
| `npm run test:all-headed` | Run all projects (desktop + mobile), headed |
| `npx playwright test --headed` | Full Playwright test with visible browser |
| `npx playwright test --headed --debug` | Debug mode with Playwright Inspector |

### AI Self-Play (Bot plays, you watch)

| Command | Description |
|---------|-------------|
| `npm run ai:play` | Bot plays at 1920x1080 desktop, headed via WSLg |
| `npm run ai:play:mobile` | Bot plays at 800x450 mobile, headed via WSLg |
| `npm run ai:play:all` | Desktop run followed by mobile run |

Shots go to `test-results/ai-play/<WIDTHxHEIGHT>/`, video to `test-results/ai-play-videos/<WIDTHxHEIGHT>/`.

### Shell Scripts (Advanced)

Located in `scripts/`:

| Script | Usage |
|--------|-------|
| `./scripts/play.sh` | Main play script (called by `npm run play`) |
| `./scripts/play-headed.sh` | Legacy: runs `tests/interactive-demo.ts` |
| `./scripts/test-visual.sh` | Starts dev server + runs desktop-1920 tests |
| `./scripts/test-all-headed.sh` | Starts dev server + runs all test projects |
| `./scripts/play-custom.sh` | Custom viewport/slowMo (e.g., `./scripts/play-custom.sh 800x600 200`) |

## Test Files

Gates (run before every commit; the dev server must be up on 5174 for everything except `npm test`):

| Gate | What it checks |
|------|----------------|
| `npm test` | typecheck + build + 20MB size budget + `test:physics` (pure Node, no browser) |
| `npx playwright test tests/duel-combat.spec.ts tests/duel-wounds.spec.ts tests/zz-ragdoll-check.spec.ts` | the Playwright gate, all 4 viewport projects (see below) |
| `HEADLESS=1 npm run ai:play:all` | bot plays a full match at 1920x1080 and 800x450, zero console errors |

Playwright specs (`npx playwright test <file>`; projects desktop-1920, desktop-1366, desktop-1280, mobile-800 in `playwright.config.ts`):

| File | Purpose |
|------|---------|
| `tests/duel-combat.spec.ts` | focus QTE, holster restart, hits both ways, shop buttons, console errors, hell round, quick-draw, crosshair kick |
| `tests/duel-wounds.spec.ts` | wound lottery, poses vs hit capsules, prone duels, wound reset per round |
| `tests/zz-ragdoll-check.spec.ts` | foe corpse: parts present, finite, on the ground, joints attached (physics gaps < 0.1m) |
| `tests/visual-duel.spec.ts` | early desktop/mobile flow + console check; waits for the home menu that a fresh profile skips (tutorial first), stale |
| `tests/zz-probe2.spec.ts` | joint readout dump (diagnostic, asserts nothing) |

Capture / measurement scripts (`npx tsx <file>` or the npm alias; `HEADLESS=1` to keep windows closed; output in `test-results/`, which Playwright wipes, so run these AFTER specs):

| File | Purpose |
|------|---------|
| `tests/ai-play.ts` | `npm run ai:play[:mobile|:all]`: bot plays a match, shots + video |
| `tests/ai-ragdoll.ts` | `npm run ai:ragdoll[:mobile]`: screencast of foe/player kills + part timelines (`FOE=bandido` etc.) |
| `tests/ragdoll-lab.ts` | ragdoll rest-pose stats over many deaths per wound pose (`FOE=`, `N=`, `SECS=1.4`, `SHOTS=`) |
| `tests/ai-wounds.ts` | `npm run ai:wounds[:mobile]`: wound pose frames + head/pelvis heights vs capsules |
| `tests/ai-stance.ts` | standing-pose close-ups + joint rotations |
| `tests/physics-refresh.test.ts` | `npm run test:physics`: ragdoll + bullets bit-identical at 30-240Hz |
| `tests/manual-play.ts` | interactive play session (`npm run play`, headed) |
| `tests/interactive-demo.ts` / `.js` | step-by-step headed demo with console logs (legacy) |
| `scripts/smoke-probe.mjs` | one shot fired in a standard duel, two screenshots (`PORT=` overrides 5174) |

## Environment Variables

- `VIEWPORT` — viewport size (e.g., `1920x1080`, `800x450`)
- `SLOW_MO` — artificial delay in ms (default 300 for play, 0 for tests)
- `RECORD_VIDEO` — set to `1` to record video (saved to `test-results/videos/`)
- `HEADLESS` — set to `1` to run AI self-play without a visible window (CI)
- `INSPECT_SECS` — how long `ai:play` keeps the browser open at the end (default 30)

## Tips

**For development:**
```bash
npm run play
```

**For mobile QA:**
```bash
npm run play:mobile
```

**Record a gameplay video:**
```bash
npm run play:record
```

**Debug specific test:**
```bash
npx playwright test --headed --debug -g "Desktop 1920x1080"
```

**View test report:**
```bash
npx playwright show-report
```

## WSLg Setup

Playwright automatically uses WSLg (Windows Subsystem for Linux GUI) if:
- Running WSL2 on Windows 11 (or Windows 10 with WSLg backport)
- `DISPLAY` environment variable is set (auto-configured by WSLg)

Check WSLg is working:
```bash
echo $DISPLAY          # should show :0 or similar
xdg-open --version     # should exist
```

If browser doesn't appear on Windows desktop, check Windows 11 WSLg is enabled or install WSLg backport for Windows 10.

## Outputs

- **Screenshots**: `tests/screenshots/*.png` (from automated tests)
- **Videos**: `test-results/videos/*.webm` (when `RECORD_VIDEO=1`)
- **HTML Report**: `playwright-report/index.html` (after `playwright test`)
- **Traces**: `test-results/*.zip` (on first retry, view with `npx playwright show-trace`)

## Next Steps

- Add regression tests (screenshot comparisons)
- Add performance metrics collection
- Add touch event simulation for mobile tests
- Integrate with CI (headless mode for automated runs)
