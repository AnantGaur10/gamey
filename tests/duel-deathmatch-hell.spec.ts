import { test, expect, Page } from '@playwright/test';

// Deathmatch sudden death (user 2026-11-02): ONLY when both cylinders are
// empty with equal HP. A double KO replays the duel instead.

type Gamey = {
  hp(p: number, f: number): void;
  ammo(p: number, f: number): void;
  aimAt(s: string): { x: number; y: number };
  state(): { phase: string; roundOver: boolean; playerHP: number; foeHP: number; foeAmmo: number; hell: boolean; live: number };
  qte(): { needle: number; zoneC: number; zoneW: number; frozen: boolean; hits: number; phase: string; paused: boolean };
};
const g = (page: Page) => page.evaluate(() => (window as unknown as { __gamey: Gamey }).__gamey.state());

async function startDeathmatch(page: Page): Promise<void> {
  await page.goto('/basic.html?nosdk=1');
  await page.waitForSelector('.skip button, .menu.home', { timeout: 60000 });
  if (await page.locator('.skip button').isVisible()) {
    await page.click('.skip button');
    await page.waitForSelector('.nameprompt, .menu.home');
    if (await page.locator('.nameprompt').isVisible()) await page.click('.nameprompt [data-n=skip]');
  }
  await page.waitForSelector('.menu.home');
  await page.click('button[data-m="deathmatch"]');
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


test('deathmatch: empty cylinders + equal HP -> sudden death', async ({ page }) => {
  await startDeathmatch(page);
  await toDraw(page);
  await page.evaluate(() => {
    const gm = (window as unknown as { __gamey: Gamey }).__gamey;
    gm.hp(40, 40);
    gm.ammo(0, 0);
  });
  await expect(page.locator('.cue')).toContainText('DEAD EVEN', { timeout: 10000 });
  await page.waitForFunction(() => (window as unknown as { __gamey: Gamey }).__gamey.state().hell, null, { timeout: 20000 });
  await expect(page.locator('.roundline')).toContainText('SUDDEN DEATH');
});

test('deathmatch: empty cylinders + different HP -> no sudden death', async ({ page }) => {
  await startDeathmatch(page);
  await toDraw(page);
  await page.evaluate(() => {
    const gm = (window as unknown as { __gamey: Gamey }).__gamey;
    gm.hp(60, 40);
    gm.ammo(0, 0);
  });
  await expect(page.locator('.cue')).toContainText('YOU TAKE IT', { timeout: 10000 });
  await page.waitForTimeout(4000);
  expect((await g(page)).hell).toBe(false);
});

test('deathmatch: a double KO replays the duel, never sudden death', async ({ page }) => {
  await startDeathmatch(page);
  let ko = false;
  for (let attempt = 0; attempt < 6 && !ko; attempt++) {
    if (attempt > 0) {
      await page.goto('about:blank');
      await startDeathmatch(page);
    }
    await toDraw(page);
    const r = await page.evaluate((click) => new Promise<string>((resolve) => {
      const gm = (window as unknown as { __gamey: Gamey }).__gamey;
      const fire = eval(click) as (x: number, y: number) => void;
      gm.hp(1, 1);
      const ammo0 = gm.state().foeAmmo;
      const mo = new MutationObserver(() => {
        const s = gm.state();
        if (s.foeAmmo < ammo0 && s.playerHP > 0 && s.foeHP > 0 && !s.roundOver) {
          mo.disconnect();
          const p = gm.aimAt('foe');
          fire(p.x, p.y);
        }
      });
      mo.observe(document.querySelector('.foeammo')!, { subtree: true, attributes: true, childList: true });
      const t0 = performance.now();
      const loop = () => {
        const s = gm.state();
        if (s.roundOver || performance.now() - t0 > 20000) { mo.disconnect(); resolve(document.querySelector('.cue')?.textContent ?? ''); return; }
        setTimeout(loop, 20);
      };
      loop();
    }), CLICK);
    console.log(`attempt ${attempt}: ${r}`);
    ko = r.includes('DOUBLE KO');
  }
  expect(ko).toBe(true);
  // The next duel loads as a normal deathmatch duel, not sudden death.
  await page.waitForFunction(() => {
    const s = (window as unknown as { __gamey: Gamey }).__gamey.state();
    return !s.roundOver && (s.phase === 'ready' || s.phase === 'focus');
  }, null, { timeout: 20000 });
  expect((await g(page)).hell).toBe(false);
  await expect(page.locator('.roundline')).toContainText('DEATHMATCH');
});
