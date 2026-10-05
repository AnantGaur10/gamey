import { test, expect, Page } from '@playwright/test';

// Duel combat assertions: hit registration both ways, ammo, bloom behavior.
// Black-box (DOM only): cue text, HP bar widths, chamber/pip counts, --gap.
// Space works for focus on every device (focus.ts key handler is universal),
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
      fill: (document.querySelector('.keybar .kfill') as HTMLElement | null)?.style.width ?? '',
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
    () => (document.querySelector('.cue')?.textContent ?? '').includes('TAP'),
    { timeout: 8000 },
  );
}

async function waitDraw(page: Page): Promise<void> {
  await page.waitForFunction(
    () => (document.querySelector('.cue')?.textContent ?? '').includes('DRAW'),
    { timeout: 15000 },
  );
}

async function tapSpace(page: Page, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await page.keyboard.press('Space');
    await page.waitForTimeout(110);
  }
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

  test('focus taps shrink bloom (gap down, bar up)', async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await page.waitForTimeout(300);
    const before = await duelState(page);
    await tapSpace(page, 6);
    const after = await duelState(page);
    expect(after.gap).toBeLessThan(before.gap - 3);
    // Progress readout is layout-split: PC keybar fill vs touch pads.
    const keybar = await page.locator('.keybar .kfill').count();
    if (keybar > 0) {
      expect(parseFloat(after.fill || '0')).toBeGreaterThan(parseFloat(before.fill || '0'));
    } else {
      expect(await page.locator('.pad.left, .pad.right').count()).toBeGreaterThan(0);
    }
  });

  test('player bullets hit the foe', async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await tapSpace(page, 6);
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
    await tapSpace(page, 4);
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
    await tapSpace(page, 5);
    await waitDraw(page);
    const p = await aimBody(page);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(1500);
    expect(errors).toEqual([]);
  }, { timeout: 60000 });
});
