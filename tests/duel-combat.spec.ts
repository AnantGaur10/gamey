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
  // Foe body on screen (shoulder cam: the foe stands right of centre).
  const { x, y } = await page.evaluate(() => (window as unknown as {
    __gamey: { aimAt(s: string): { x: number; y: number } };
  }).__gamey.aimAt('foe'));
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

  test('QTE miss: bloom grows, needle stalls, zone keeps its width and moves', async ({ page }) => {
    // Anti-spam (user 2026-10-06): a miss stalls the needle 0.4s and no longer
    // widens the zone.
    await startStandard(page);
    await parkInHolster(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => new Promise<{ b0: number; b1: number; misses: number; w0: number; w1: number; c0: number; c1: number; stalled: boolean }>((resolve) => {
      type Q = { needle: number; zoneC: number; zoneW: number; frozen: boolean; misses: number; bloom: number };
      const g = (window as unknown as { __gamey: { qte(): Q } }).__gamey;
      const loop = () => {
        const q = g.qte();
        if (!q.frozen && Math.abs(q.needle - q.zoneC) > q.zoneW) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
          // still stalled past the old 0.12s freeze; the zone respawns once the 0.4s stall ends
          setTimeout(() => {
            const stalled = g.qte().frozen;
            setTimeout(() => {
              const a = g.qte();
              resolve({ b0: q.bloom, b1: a.bloom, misses: a.misses, w0: q.zoneW, w1: a.zoneW, c0: q.zoneC, c1: a.zoneC, stalled });
            }, 700);
          }, 200);
          return;
        }
        setTimeout(loop, 4);
      };
      loop();
    }));
    expect(r.misses).toBe(1);
    expect(r.stalled).toBe(true);
    expect(r.b1).toBeGreaterThan(r.b0);
    expect(r.w1).toBeCloseTo(r.w0, 6);
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

  test('hell is one round: first hit wins, never repeats (no soft lock)', async ({ page }) => {
    // User 2026-10-05: hell soft-locked after a non-lethal hit, and must be a
    // one-time round where the first shot that lands wins.
    type S = { roundOver: boolean; hell: boolean; ammo: number; foeAmmo: number; live: number; playerHP: number; foeHP: number };
    const state = () => page.evaluate(() => (window as unknown as { __gamey: { state(): S } }).__gamey.state());
    await startStandard(page);
    await page.evaluate(() => (window as unknown as { __gamey: { hell(): void } }).__gamey.hell());
    await page.waitForSelector('.readyzone', { timeout: 8000 });
    expect((await state()).hell).toBe(true);
    await parkInHolster(page);
    await waitDraw(page);
    // Empty the cylinder into the sky; the foe's first landed hit (or all
    // twelve misses) must end it.
    for (let i = 0; i < 6 && !(await state()).roundOver; i++) {
      await page.mouse.click(30, 30);
      await page.waitForTimeout(450);
    }
    await page.waitForFunction(
      () => (window as unknown as { __gamey: { state(): S } }).__gamey.state().roundOver,
      undefined, { timeout: 15000 },
    );
    const end = await state();
    // Any hit is decisive: a hit duelist is down, never left wounded.
    expect(end.playerHP === 0 || end.playerHP === 100).toBe(true);
    expect(end.foeHP).toBe(100);
    // Next round is a normal duel, never another hell.
    await page.waitForFunction(
      () => (document.querySelector('.cue')?.textContent ?? '').includes('HOLSTER UP')
        || !!document.querySelector('.menu h1'),
      undefined, { timeout: 12000 },
    );
    if (await page.locator('.readyzone').isVisible().catch(() => false)) expect((await state()).hell).toBe(false);
  }, { timeout: 90000 });
  test('guns start holstered, quick-draw at DRAW, no shot before the gun clears', async ({ page }) => {
    // User 2026-10-05: revolver tucked in the holster with the hand on it
    // until DRAW, then pulled fast. Clicks are ignored while it clears.
    type G = { state: string; pos: number[]; drawTick: number; tick: number };
    const gun = (side: string) => page.evaluate((s) => (window as unknown as { __gamey: { gun(x: string): G } }).__gamey.gun(s), side);
    await startStandard(page);
    expect((await gun('player')).state).toBe('holster');
    expect((await gun('foe')).state).toBe('holster');
    await parkInHolster(page);
    expect((await gun('foe')).state).toBe('holster'); // still holstered through Focus
    // Fire the instant DRAW lands (in-page, same frame): must be ignored.
    const early = await page.evaluate(() => new Promise<{ ammo0: number; ammo1: number; dt: number }>((resolve) => {
      type W = { __gamey: { gun(s: string): G; state(): { ammo: number } } };
      const g = (window as unknown as W).__gamey;
      const loop = () => {
        const f = g.gun('foe');
        if (f.drawTick < 0) { setTimeout(loop, 2); return; }
        const ammo0 = g.state().ammo;
        const c = document.querySelector('canvas')!.getBoundingClientRect();
        document.querySelector('canvas')!.dispatchEvent(new PointerEvent('pointerdown', { clientX: c.left + c.width / 2, clientY: c.top + c.height / 2, bubbles: true, pointerType: 'mouse' }));
        resolve({ ammo0, ammo1: g.state().ammo, dt: f.tick - f.drawTick });
      };
      loop();
    }));
    expect(early.dt).toBeLessThan(10);
    expect(early.ammo1).toBe(early.ammo0);
    await page.waitForTimeout(600);
    expect((await gun('player')).state).toBe('hand');
    expect((await gun('foe')).state).toBe('hand');
    // Gun cleared: a click now fires.
    const p = await aimBody(page);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(200);
    expect((await duelState(page)).ammo).toBeLessThan(6);
  }, { timeout: 60000 });
  test('a shot kicks the crosshair x1.5, then it returns to the pre-shot size', async ({ page }) => {
    // User 2026-10-05 (anti-spam): 6px -> 9px on a shot, back to 6px faster
    // and faster. Tutorial duel: the dummy never fires, so no hit flinch.
    await page.goto('/basic.html');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.readyzone', { timeout: 8000 }); // fresh profile = tutorial
    await parkInHolster(page);
    await waitDraw(page);
    await page.waitForTimeout(500); // gun clear of the holster
    type Q = { bloom: number };
    const r = await page.evaluate(() => {
      const g = (window as unknown as { __gamey: { qte(): Q } }).__gamey;
      const gap = () => parseFloat(getComputedStyle(document.querySelector('.crosshair')!).getPropertyValue('--gap') || '0');
      const b0 = g.qte().bloom, gap0 = gap();
      const c = document.querySelector('canvas')!.getBoundingClientRect();
      document.querySelector('canvas')!.dispatchEvent(new PointerEvent('pointerdown', { clientX: c.left + 30, clientY: c.top + 30, bubbles: true, pointerType: 'mouse' }));
      return { b0, b1: g.qte().bloom, gap0 };
    });
    expect(r.b1 / r.b0).toBeCloseTo(1.5, 2);
    await page.waitForTimeout(150);
    const gapKick = await page.evaluate(() => parseFloat(getComputedStyle(document.querySelector('.crosshair')!).getPropertyValue('--gap') || '0'));
    expect(gapKick).toBeGreaterThan(r.gap0 * 1.2); // the drawn ring follows
    await page.waitForTimeout(900);
    const b2 = await page.evaluate(() => (window as unknown as { __gamey: { qte(): Q } }).__gamey.qte().bloom);
    expect(b2).toBeCloseTo(r.b0, 3); // back on the pre-shot size
  }, { timeout: 60000 });
});
