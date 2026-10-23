import { test, expect, Page } from '@playwright/test';

// Double KO -> sudden death, live-fired (phase-2 Slice 6). Both duelists are
// set to 1 HP after DRAW (DEV __gamey.hp), so both shots are lethal at fire
// time; the player fires the instant the foe's bullet is out, before the next
// frame steps it, so the two lethal bullets cross. Then the sudden-death
// round is played out and its winner's point must land in the series.

type Gamey = {
  round(i: number, d?: number): void;
  hp(p: number, f: number): void;
  aimAt(s: string): { x: number; y: number };
  gun(s: string): { drawTick: number; tick: number };
  state(): { phase: string; roundOver: boolean; playerHP: number; foeHP: number; foeAmmo: number; hell: boolean; live: number };
  qte(): { needle: number; zoneC: number; zoneW: number; frozen: boolean; hits: number; phase: string; paused: boolean };
};

async function startStandard(page: Page): Promise<void> {
  await page.goto('/basic.html');
  await page.waitForLoadState('networkidle');
  if (await page.locator('.skip').isVisible().catch(() => false)) {
    await page.click('.skip button'); // fresh profile boots tutorial-first
    await page.waitForTimeout(400);
    if (await page.locator('.nameprompt').isVisible().catch(() => false)) await page.click('.nameprompt [data-n=skip]'); // guest name screen after the tutorial
  }
  await page.click('button[data-m="standard"]');
  await page.waitForSelector('.readyzone', { timeout: 8000 });
}

/** Park in the holster, land a few QTE hits (small bloom), wait for DRAW. */
async function toDraw(page: Page): Promise<void> {
  await page.waitForSelector('.readyzone', { timeout: 15000 });
  const z = await page.locator('.readyzone').boundingBox();
  expect(z).not.toBeNull();
  await page.mouse.move(z!.x + z!.width / 2, z!.y + z!.height / 2);
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('FOCUS'), { timeout: 8000 });
  await page.evaluate(() => new Promise<void>((resolve) => {
    const g = (window as unknown as { __gamey: Gamey }).__gamey;
    const loop = () => {
      const q = g.qte();
      if (q.phase !== 'focus') { resolve(); return; }
      if (!q.frozen && !q.paused && Math.abs(q.needle - q.zoneC) < (q.zoneW / 2) * 0.6) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      }
      setTimeout(loop, 4);
    };
    loop();
  }));
}

/** Synthetic left click through the real pointerdown path (no frame wait). */
const CLICK = `(x, y) => document.elementFromPoint(x, y)?.dispatchEvent(new PointerEvent('pointerdown',
  { clientX: x, clientY: y, button: 0, pointerType: 'mouse', bubbles: true }))`;

/** Force a double KO from a fresh best-of round 1 and wait for the
    sudden-death round to load. */
async function doubleKo(page: Page): Promise<void> {
  await startStandard(page);

  // Retry until both bullets land (either can miss); 8m keeps both accurate.
  let ko = false;
  for (let attempt = 0; attempt < 6 && !ko; attempt++) {
    await page.evaluate(() => (window as unknown as { __gamey: Gamey }).__gamey.round(0, 8));
    await toDraw(page);
    const r = await page.evaluate((click) => new Promise<string>((resolve) => {
      const g = (window as unknown as { __gamey: Gamey }).__gamey;
      const fire = eval(click) as (x: number, y: number) => void;
      g.hp(1, 1);
      const ammo0 = g.state().foeAmmo;
      // The foe's shot repaints its ammo pips; the observer is a microtask,
      // so the answer is fired before any frame steps the foe's bullet (at
      // 8m it would land within one headless frame).
      const mo = new MutationObserver(() => {
        const s = g.state();
        if (s.foeAmmo < ammo0 && s.playerHP > 0 && s.foeHP > 0 && !s.roundOver) {
          mo.disconnect();
          const p = g.aimAt('foe');
          fire(p.x, p.y);
        }
      });
      mo.observe(document.querySelector('.foeammo')!, { subtree: true, attributes: true, childList: true });
      const t0 = performance.now();
      const loop = () => {
        const s = g.state();
        if (s.roundOver || performance.now() - t0 > 20000) { mo.disconnect(); resolve(document.querySelector('.cue')?.textContent ?? ''); return; }
        setTimeout(loop, 20);
      };
      loop();
    }), CLICK);
    console.log(`attempt ${attempt}: ${r}`);
    ko = r.includes('DOUBLE KO');
  }
  expect(ko).toBe(true);

  // Sudden death loads on the same map and series.
  await page.waitForFunction(() => (window as unknown as { __gamey: Gamey }).__gamey.state().hell, null, { timeout: 15000 });
  await expect(page.locator('.roundline')).toContainText('SUDDEN DEATH');
}

/** Play the sudden-death round out (the player shooting from the moment
    the gun clears the holster, or holding fire) and return the cue. */
async function suddenDeath(page: Page, shoot: boolean): Promise<string> {
  await toDraw(page);
  const cue = await page.evaluate(([click, shoot]) => new Promise<string>((resolve) => {
    const g = (window as unknown as { __gamey: Gamey }).__gamey;
    const fire = eval(click as string) as (x: number, y: number) => void;
    const t0 = performance.now();
    const loop = () => {
      const s = g.state();
      if (s.roundOver || performance.now() - t0 > 30000) { resolve(document.querySelector('.cue')?.textContent ?? ''); return; }
      const k = g.gun('player');
      if (shoot && k.drawTick >= 0 && k.tick - k.drawTick >= 10) { const p = g.aimAt('foe'); fire(p.x, p.y); }
      setTimeout(loop, 20);
    };
    loop();
  }), [CLICK, shoot] as const);
  console.log(`sudden death: ${cue}`);
  return cue;
}

/** Sudden death never repeats: the next best-of round carries its result. */
async function expectNextRound(page: Page, score: string): Promise<void> {
  await page.waitForFunction(() => {
    const g = (window as unknown as { __gamey: Gamey }).__gamey;
    return !g.state().hell && (document.querySelector('.roundline')?.textContent ?? '').startsWith('ROUND 2');
  }, null, { timeout: 15000 });
  await expect(page.locator('.roundline')).toContainText(score);
}

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  return errors;
}

test('double KO -> sudden death, player hits first -> YOU 1 – 0', async ({ page }) => {
  const errors = trackErrors(page);
  await doubleKo(page);
  const cue = await suddenDeath(page, true);
  expect(cue).toContain('FOE DOWN');
  await expectNextRound(page, 'YOU 1 – 0');
  expect(errors).toEqual([]);
});

test('double KO -> sudden death, player holds fire -> the foe takes the point', async ({ page }) => {
  const errors = trackErrors(page);
  await doubleKo(page);
  const cue = await suddenDeath(page, false);
  // Six foe shots at 8m nearly always land; all six missing is a drawn
  // round (no repeat), which must leave the score untouched.
  if (cue.includes('NO BLOOD DRAWN')) await expectNextRound(page, 'YOU 0 – 0');
  else {
    expect(cue).toContain("YOU'RE DOWN");
    await expectNextRound(page, 'YOU 0 – 1');
  }
  expect(errors).toEqual([]);
});
