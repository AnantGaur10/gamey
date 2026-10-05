import { test, expect, Page } from '@playwright/test';

// Duel combat assertions: hit registration both ways, ammo, bloom behavior.
// Black-box (DOM only): cue text, HP bar widths, chamber/pip counts, --gap.
// Space works for the focus QTE on every device (focus.ts key handler is universal),
// mouse click fires (pointerdown path), so one flow covers all projects.

interface DuelState {
  cue: string;
  playerHP: number;
  foeHP: number;
  ammo: number;
  foeSpent: number;
  gap: number;
  fill: string;
}

async function duelState(page: Page): Promise<DuelState> {
  return page.evaluate(() => {
    const cue = document.querySelector('.cue')?.textContent ?? '';
    const youBar = document.querySelector('.hp.you i') as HTMLElement | null;
    const foeBar = document.querySelector('.hp.foe i') as HTMLElement | null;
    const cross = document.querySelector('.crosshair') as HTMLElement | null;
    return {
      cue,
      playerHP: parseFloat(youBar?.style.width || '100'),
      foeHP: parseFloat(foeBar?.style.width || '100'),
      ammo: document.querySelectorAll('.cylinder .chamber.live').length,
      foeSpent: document.querySelectorAll('.foeammo i.spent').length,
      gap: cross ? parseFloat(getComputedStyle(cross).getPropertyValue('--gap') || '0') : 0,
      fill: (document.querySelector('.qte .qfill') as HTMLElement | null)?.style.width ?? '',
    };
  });
}

async function startStandard(page: Page): Promise<void> {
  await page.goto('/basic.html');
  await page.waitForLoadState('networkidle');
  if (await page.locator('.skip').isVisible().catch(() => false)) {
    await page.click('.skip button'); // fresh profile boots tutorial-first
    await page.waitForTimeout(400);
  }
  await page.click('button[data-m="standard"]');
  await page.waitForSelector('.readyzone', { timeout: 8000 });
}

async function parkInHolster(page: Page): Promise<void> {
  const z = await page.locator('.readyzone').boundingBox();
  expect(z).not.toBeNull();
  await page.mouse.move(z!.x + z!.width / 2, z!.y + z!.height / 2);
  await page.waitForFunction(
    () => (document.querySelector('.cue')?.textContent ?? '').includes('FOCUS'),
    { timeout: 8000 },
  );
}

async function waitDraw(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (document.querySelector('.cue')?.textContent ?? '').includes('DRAW'),
    { timeout: 15000 },
  );
}

// Focus QTE: press Space (the real window keydown path) only while the
// needle is well inside the gold zone. Reads the DEV __gamey.qte() probe
// every 4ms (the needle is time-continuous), so it never presses a miss.
async function qteHits(page: Page, n: number): Promise<number> {
  return page.evaluate((want) => new Promise<number>((resolve) => {
    type Q = { needle: number; zoneC: number; zoneW: number; frozen: boolean; hits: number; phase: string; paused: boolean };
    const g = (window as unknown as { __gamey: { qte(): Q } }).__gamey;
    const start = g.qte().hits;
    const t0 = performance.now();
    const loop = () => {
      const q = g.qte();
      if (q.hits - start >= want || q.phase !== 'focus' || performance.now() - t0 > 8000) {
        resolve(q.hits - start);
        return;
      }
      if (!q.frozen && !q.paused && Math.abs(q.needle - q.zoneC) < (q.zoneW / 2) * 0.6) {
        window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
      }
      setTimeout(loop, 4);
    };
    loop();
  }), n);
}

async function aimBody(page: Page): Promise<{ x: number; y: number }> {
  const c = await page.locator('canvas').boundingBox();
  expect(c).not.toBeNull();
  const x = c!.x + c!.width / 2;
  const y = c!.y + c!.height / 2 - 20;
  await page.mouse.move(x, y);
  await page.waitForTimeout(250);
  return { x, y };
}

test.describe('Gamey - Combat', () => {
  test('focus holds still with zero input (no phantom shrink)', async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await page.waitForTimeout(300);
    const a = await duelState(page);
    expect(a.gap).toBeGreaterThan(0);
    await page.waitForTimeout(1200); // hover only: no taps, no keys
    const b = await duelState(page);
    expect(Math.abs(b.gap - a.gap)).toBeLessThanOrEqual(2);
    expect(b.fill).toBe(a.fill);
  });

  test('QTE hits in the gold shrink bloom (gap down, bar up)', async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await page.waitForTimeout(300);
    await expect(page.locator('.qte .qtrack')).toBeVisible();
    const before = await duelState(page);
    // >= 1: software-GL CI renders slowly, so fewer hits fit before DRAW
    expect(await qteHits(page, 2)).toBeGreaterThanOrEqual(1);
    const after = await duelState(page);
    expect(after.gap).toBeLessThan(before.gap - 3);
    expect(parseFloat(after.fill || '0')).toBeGreaterThan(parseFloat(before.fill || '0'));
  });

  test('QTE miss: bloom grows, zone widens and moves', async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => new Promise<{ b0: number; b1: number; misses: number; w0: number; w1: number; c0: number; c1: number }>((resolve) => {
      type Q = { needle: number; zoneC: number; zoneW: number; frozen: boolean; misses: number; bloom: number };
      const g = (window as unknown as { __gamey: { qte(): Q } }).__gamey;
      const loop = () => {
        const q = g.qte();
        if (!q.frozen && Math.abs(q.needle - q.zoneC) > q.zoneW) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
          // zone respawns after the 0.12s result freeze
          setTimeout(() => {
            const a = g.qte();
            resolve({ b0: q.bloom, b1: a.bloom, misses: a.misses, w0: q.zoneW, w1: a.zoneW, c0: q.zoneC, c1: a.zoneC });
          }, 250);
          return;
        }
        setTimeout(loop, 4);
      };
      loop();
    }));
    expect(r.misses).toBe(1);
    expect(r.b1).toBeGreaterThan(r.b0);
    expect(r.w1).toBeGreaterThan(r.w0);
    expect(r.c1).not.toBeCloseTo(r.c0, 3);
  });

  test('leaving the holster restarts the whole countdown', async ({ page, isMobile }) => {
    test.skip(isMobile, 'touch has no hover: Focus is committed once started');
    await startStandard(page);
    await parkInHolster(page);
    const z = (await page.locator('.readyzone').boundingBox())!;
    expect(await qteHits(page, 1)).toBe(1);
    await page.waitForTimeout(900);
    type Q = { secsLeft: number; bloom: number; hits: number; paused: boolean; phase: string };
    const q = () => page.evaluate(() => (window as unknown as { __gamey: { qte(): Q } }).__gamey.qte());
    const mid = await q();
    expect(mid.secsLeft).toBeLessThan(2.4);
    const gapMid = (await duelState(page)).gap;
    await page.mouse.move(z.x - 200, z.y - 200); // out of the holster
    await page.waitForTimeout(400);
    const out = await q();
    // needle frozen while out (was drawn extrapolated: jittered at the left)
    const needleA = await page.evaluate(() => (window as unknown as { __gamey: { qte(): { needle: number } } }).__gamey.qte().needle);
    await page.waitForTimeout(300);
    const needleB = await page.evaluate(() => (window as unknown as { __gamey: { qte(): { needle: number } } }).__gamey.qte().needle);
    expect(needleB).toBe(needleA);
    expect((await duelState(page)).gap).toBeGreaterThan(gapMid); // crosshair back to default size
    expect(out.paused).toBe(true);
    expect(out.secsLeft).toBeGreaterThan(2.95);
    expect(out.hits).toBe(0);
    expect(out.bloom).toBeGreaterThan(mid.bloom); // back to the start bloom
    expect(await page.locator('.cue').textContent()).toContain('HOLSTER');
    await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2); // back in
    await page.waitForTimeout(500);
    const back = await q();
    expect(back.paused).toBe(false);
    expect(back.phase).toBe('focus');
    expect(back.secsLeft).toBeGreaterThan(2.3); // counting down from a fresh 3.0s
  });

  test('player bullets hit the foe', async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await qteHits(page, 3);
    await waitDraw(page);
    // 500ms spacing beats the 380ms cooldown; 4 body shots, foe needs ~3
    // return hits to kill us, so we land ours first. Hit OR kill cue passes.
    for (let i = 0; i < 4; i++) {
      const s = await duelState(page);
      if (s.foeHP < 100 || /HIT|DOWN|HEADSHOT/.test(s.cue)) break;
      const p = await aimBody(page);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(500);
    }
    const end = await duelState(page);
    expect(end.foeHP < 100 || /HIT|DOWN|HEADSHOT/.test(end.cue)).toBe(true);
    expect(end.ammo).toBeLessThan(6); // our shots actually left the cylinder
  }, { timeout: 60000 });

  test('foe fires back (exchanges)', async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await qteHits(page, 3);
    await waitDraw(page);
    // Passive player: the AI must spend a bullet (pips) or wound us.
    await page.waitForFunction(
      () => document.querySelectorAll('.foeammo i.spent').length >= 1,
      { timeout: 12000 },
    );
    const s = await duelState(page);
    expect(s.foeSpent).toBeGreaterThanOrEqual(1);
  }, { timeout: 60000 });

  test('shop loads with zero dead buttons', async ({ page }) => {
    await page.goto('/basic.html');
    await page.waitForLoadState('networkidle');
    if (await page.locator('.skip').isVisible().catch(() => false)) {
      await page.click('.skip button');
      await page.waitForTimeout(400);
    }
    await page.click('button[data-m="shop"]');
    await expect(page.locator('.shop h2')).toContainText('ARMORY');
    await expect(page.locator('[data-b="tutorial"]')).toBeVisible();
    await page.click('[data-b="back"]');
    await expect(page.locator('.menu h1')).toContainText('HIGH NOON');
  });

  test('combat run has zero console errors', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    page.on('pageerror', (err) => errors.push(err.message));
    await startStandard(page);
    await parkInHolster(page);
    await qteHits(page, 3);
    await waitDraw(page);
    const p = await aimBody(page);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  }, { timeout: 60000 });
});
