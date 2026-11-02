import { test, expect, Page } from '@playwright/test';

// Duel pause (user 2026-11-02): P / the HUD button (never Esc: CrazyGames
// reserves it for leaving fullscreen) freezes the whole duel, foe included.

type G = { __gamey: { state(): { phase: string; playerHP: number; foeHP: number; foeAmmo: number }; gun(s: 'player'): { tick: number } } };
const st = (page: Page) => page.evaluate(() => (window as unknown as G).__gamey.state());
const tick = (page: Page) => page.evaluate(() => (window as unknown as G).__gamey.gun('player').tick);

async function toDraw(page: Page): Promise<void> {
  await page.goto('/basic.html?nosdk=1');
  await page.waitForSelector('.skip button, .menu.home', { timeout: 60000 });
  if (await page.locator('.skip button').isVisible()) {
    await page.click('.skip button');
    await page.waitForSelector('.nameprompt, .menu.home');
    if (await page.locator('.nameprompt').isVisible()) await page.click('.nameprompt [data-n=skip]');
  }
  await page.click('button[data-m="standard"]');
  await page.waitForSelector('.readyzone', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.boot'), undefined, { timeout: 60000 });
  const z = (await page.locator('.readyzone').boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2);
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('DRAW'), undefined, { timeout: 60000 });
}

test('P pauses the duel (clock + foe frozen), RESUME carries on, LEAVE goes home', async ({ page }) => {
  await toDraw(page);
  await page.keyboard.press('KeyP');
  await expect(page.locator('.pausemenu')).toBeVisible();
  await expect(page.locator('.pausemenu input[data-s=sfx]')).toBeVisible();
  const s0 = await st(page);
  const t0 = await tick(page);
  await page.waitForTimeout(3000); // longer than any foe reaction
  expect(await tick(page)).toBe(t0);
  const s1 = await st(page);
  expect(s1.foeAmmo).toBe(s0.foeAmmo);
  expect(s1.playerHP).toBe(s0.playerHP);
  // A click on the menu's veil never fires the gun.
  await page.mouse.click(30, 300);
  expect((await st(page)).phase).toBe(s0.phase);

  await page.click('.pausemenu [data-p=resume]');
  await expect(page.locator('.pausemenu')).toHaveCount(0);
  await page.waitForFunction((t) => (window as unknown as G).__gamey.gun('player').tick > t + 10, t0, { timeout: 20000 });
  // The held foe shot still comes.
  await page.waitForFunction((a) => { const s = (window as unknown as G).__gamey.state(); return s.foeAmmo < a || s.phase !== 'fire' && s.phase !== 'draw'; }, s0.foeAmmo, { timeout: 30000 });

  // Button path + LEAVE.
  if (await page.locator('.pause-btn').isVisible()) {
    await page.click('.pause-btn');
    await page.click('.pausemenu [data-p=leave]');
    await expect(page.locator('.menu.home')).toBeVisible();
  }
});
