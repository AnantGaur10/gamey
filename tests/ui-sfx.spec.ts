import { test, expect, Page } from '@playwright/test';

// Menu sounds (src/ui/uiSfx.ts): every button hovers + clicks through the SFX
// bus. Counts synth voices started (oscillators + noise sources) per action.

declare global {
  interface Window { __voices: number; }
}

function countVoices(): void {
  window.__voices = 0;
  for (const P of [OscillatorNode.prototype, AudioBufferSourceNode.prototype]) {
    const start = P.start;
    P.start = function (this: AudioScheduledSourceNode, ...a: [number?, number?, number?]) {
      window.__voices++;
      return start.apply(this, a as never);
    } as typeof P.start;
  }
}

const voices = (page: Page) => page.evaluate(() => window.__voices);

async function toHome(page: Page): Promise<void> {
  await page.goto('/basic.html?nosdk=1');
  await page.waitForSelector('.skip button, .menu.home', { timeout: 60000 });
  if (await page.locator('.skip button').isVisible()) {
    await page.click('.skip button');
    await page.waitForSelector('.nameprompt, .menu.home');
    if (await page.locator('.nameprompt').isVisible()) await page.click('.nameprompt [data-n=skip]');
  }
  await page.waitForSelector('.menu.home');
}

test('buttons tick on hover and cock on click; silent when muted', async ({ page }) => {
  const warnings: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') warnings.push(m.text()); });
  await page.addInitScript(countVoices);
  await toHome(page);
  await page.mouse.move(5, 5);
  await page.waitForTimeout(100);

  const map = page.locator('.menu.home button', { hasText: 'MAP' }).first();
  const v0 = await voices(page);
  await map.hover();
  await page.waitForTimeout(80);
  const v1 = await voices(page);
  expect(v1 - v0, 'hover = tick (noise + ping)').toBe(2);

  await map.click(); // map picker
  await page.waitForTimeout(80);
  const v2 = await voices(page);
  expect(v2 - v1, 'click = hammer cock (2 x noise + ping)').toBeGreaterThanOrEqual(4);

  await page.click('[data-b=back]');
  await page.waitForSelector('.menu.home');
  await page.waitForTimeout(80);

  // Mute: nothing plays.
  await page.click('.mute-btn');
  await page.waitForTimeout(80);
  const v3 = await voices(page);
  await map.hover();
  await page.mouse.move(5, 5);
  await map.hover();
  await page.waitForTimeout(80);
  expect(await voices(page)).toBe(v3);

  expect(warnings.filter((w) => /AudioContext/i.test(w))).toEqual([]);
});
