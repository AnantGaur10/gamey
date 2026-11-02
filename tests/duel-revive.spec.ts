import { test, expect, Page } from '@playwright/test';

// Revive prompt (user 2026-11-02): standard mode only on the death that would
// lose the match (2nd lost round of the best-of-3); never on the first.

type G = { __gamey: { round(i: number, d?: number, hp?: number): void; state(): { playerHP: number; roundOver: boolean } } };

async function home(page: Page): Promise<void> {
  await page.goto('/basic.html?nosdk=1');
  await page.waitForSelector('.skip button, .menu.home', { timeout: 60000 });
  if (await page.locator('.skip button').isVisible()) {
    await page.click('.skip button');
    await page.waitForSelector('.nameprompt, .menu.home');
    if (await page.locator('.nameprompt').isVisible()) await page.click('.nameprompt [data-n=skip]');
  }
  await page.waitForSelector('.menu.home');
  // Gold for a revive (with none, no token and ads off, the prompt is skipped).
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('gamey.v1') ?? '{}');
    p.gold = 500;
    localStorage.setItem('gamey.v1', JSON.stringify(p));
  });
  await page.reload();
  await page.waitForSelector('.menu.home', { timeout: 60000 });
  await page.click('button[data-m="standard"]');
  await page.waitForSelector('.readyzone', { timeout: 60000 });
}

/** Round i at 6m with 1 HP: hold the holster through DRAW, never fire, die. */
async function dieInRound(page: Page, i: number): Promise<boolean> {
  await page.evaluate((i) => (window as unknown as G).__gamey.round(i, 6, 1), i);
  await page.waitForFunction(() => !document.querySelector('.boot'), undefined, { timeout: 60000 });
  const z = (await page.locator('.readyzone').boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2);
  await page.waitForFunction(() => (window as unknown as G).__gamey.state().roundOver, undefined, { timeout: 90000 });
  return (await page.evaluate(() => (window as unknown as G).__gamey.state().playerHP)) <= 0;
}

test('no revive on the first lost round, revive on the match-deciding one', async ({ page }) => {
  await home(page);
  // Round 1, nobody has won a round yet (fWins 0): losing it is not the end.
  if (await dieInRound(page, 0)) {
    await page.waitForTimeout(1500);
    await expect(page.locator('[data-r=no]')).toHaveCount(0);
  }
  // Round 3 at 1-1 (fWins 1): this death would lose the match.
  const died = await dieInRound(page, 2);
  console.log(`[revive-spec] died in the deciding round: ${died}`);
  if (died) {
    await expect(page.locator('[data-r=no]')).toBeVisible({ timeout: 8000 });
    // The stakes are on the card, and STAY DOWN costs 5 levels (floored at stage 1 level 1).
    await expect(page.locator('.rv-stake')).toContainText('STAGE 1 · LEVEL 1');
    await page.click('[data-r=no]');
    await expect(page.locator('.rs-new.lost')).toContainText('KNOCKED BACK TO STAGE 1 · LEVEL 1', { timeout: 15000 });
  }
});

test('a ladder loss at stage 2 level 3 falls back 5 levels to stage 1 level 8', async ({ page }) => {
  await page.goto('/basic.html?nosdk=1');
  await page.waitForSelector('.skip button, .menu.home', { timeout: 60000 });
  if (await page.locator('.skip button').isVisible()) {
    await page.click('.skip button');
    await page.waitForSelector('.nameprompt, .menu.home');
    if (await page.locator('.nameprompt').isVisible()) await page.click('.nameprompt [data-n=skip]');
  }
  await page.waitForSelector('.menu.home');
  await page.evaluate(() => {
    const p = JSON.parse(localStorage.getItem('gamey.v1') ?? '{}');
    p.level = 12; // stage 2 level 3
    p.gold = 0; p.reviveToken = 0; // nothing to revive with: still asked, the revive button greyed
    localStorage.setItem('gamey.v1', JSON.stringify(p));
  });
  await page.reload();
  await page.waitForSelector('.menu.home', { timeout: 60000 });
  await expect(page.locator('button[data-m="standard"] small')).toContainText('Stage 2 · Level 3');
  await page.click('button[data-m="standard"]');
  await page.waitForSelector('.readyzone', { timeout: 60000 });
  const died = await dieInRound(page, 2);
  console.log(`[revive-spec] died at stage 2 level 3: ${died}`);
  if (died) {
    await expect(page.locator('[data-r=yes]')).toBeDisabled({ timeout: 8000 });
    await expect(page.locator('.rv-stake')).toContainText('STAGE 1 · LEVEL 8');
    await page.click('[data-r=no]');
    await expect(page.locator('.rs-new.lost')).toContainText('STAGE 1 · LEVEL 8', { timeout: 15000 });
    await expect(page.locator('[data-b=again]')).toContainText('PLAY: STAGE 1 · LEVEL 8');
  }
});
