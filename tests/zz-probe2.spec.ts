import { test } from '@playwright/test';
test('joint readout', async ({ page }) => {
  await page.goto('/basic.html');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.readyzone', { timeout: 8000 });
  const z = await page.locator('.readyzone').boundingBox();
  await page.mouse.move(z!.x + z!.width / 2, z!.y + z!.height / 2);
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('TAP'), { timeout: 8000 });
  for (let i = 0; i < 6; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(110); }
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('DRAW'), { timeout: 15000 });
  await page.waitForTimeout(2000);
  type G = { __gamey: {
    force(s: string, w: string): void;
    joints(s: string): unknown;
  } };
  console.log('BASE:', JSON.stringify(await page.evaluate(() => (window as unknown as G).__gamey.joints('foe'))));
  await page.evaluate(() => (window as unknown as G).__gamey.force('foe', 'crouch'));
  await page.waitForTimeout(2500);
  console.log('CROUCH:', JSON.stringify(await page.evaluate(() => (window as unknown as G).__gamey.joints('foe'))));
  await page.evaluate(() => (window as unknown as G).__gamey.force('foe', 'none'));
  await page.waitForTimeout(1500);
  console.log('RESET:', JSON.stringify(await page.evaluate(() => (window as unknown as G).__gamey.joints('foe'))));
});
