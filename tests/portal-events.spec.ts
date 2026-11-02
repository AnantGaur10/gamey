import { test, expect, Page } from '@playwright/test';

// What the CrazyGames SDK hears from the game: the gameplay Start/Stop pair and
// the site's mute setting. On localhost the real SDK runs in `local` mode; this
// records calls on their way to it, and can change its mute setting mid-session.

declare global {
  interface Window {
    __calls: string[];
    __siteMute?: boolean;
    __settingsListeners: Array<() => void>;
  }
}

function recordSdk(): void {
  window.__calls = [];
  window.__settingsListeners = [];
  const recorded = ['gameplayStart', 'gameplayStop'];
  const wrapGame = (g: any) => new Proxy(g, {
    get(t, k: string) {
      const v = Reflect.get(t, k);
      if (k === 'settings') return { ...v, muteAudio: window.__siteMute ?? v?.muteAudio };
      if (k === 'addSettingsChangeListener') return (cb: () => void) => window.__settingsListeners.push(cb);
      if (recorded.includes(k)) return (...a: unknown[]) => { window.__calls.push(k); return v.apply(t, a); };
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  const wrapSdk = (s: any) => new Proxy(s, {
    get(t, k: string) {
      const v = Reflect.get(t, k);
      if (k === 'game' && v) return wrapGame(v);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
  let cg: any;
  Object.defineProperty(window, 'CrazyGames', {
    configurable: true,
    get: () => cg,
    set: (v) => {
      cg = new Proxy(v ?? {}, {
        get(t, k: string) {
          const x = Reflect.get(t, k);
          return k === 'SDK' && x ? wrapSdk(x) : x;
        },
      });
    },
  });
}

const calls = (page: Page) => page.evaluate(() => window.__calls);

/** Guests get the name prompt; the SDK's local mode is signed in, so it goes straight home. */
async function leaveNamePrompt(page: Page): Promise<void> {
  await page.waitForSelector('.nameprompt, .menu.home');
  if (await page.locator('.nameprompt').isVisible()) await page.click('.nameprompt [data-n=skip]');
}

async function toHome(page: Page, query = ''): Promise<void> {
  await page.goto(`/basic.html${query}`);
  await page.waitForSelector('.skip button, .menu.home', { timeout: 60000 });
  if (await page.locator('.skip button').isVisible()) {
    await page.click('.skip button');
    await leaveNamePrompt(page);
  }
  await page.waitForSelector('.menu.home');
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(recordSdk);
});

test('SKIP during Focus closes the gameplay pair', async ({ page }) => {
  await page.goto('/basic.html');
  await page.waitForSelector('.readyzone', { timeout: 60000 });
  await page.waitForFunction(() => !document.querySelector('.boot'));
  const z = (await page.locator('.readyzone').boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2);
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('FOCUS'), undefined, { timeout: 60000 });
  expect(await calls(page)).toEqual(['gameplayStart']);

  await page.click('.skip button', { force: true });
  await leaveNamePrompt(page);
  await page.waitForSelector('.menu.home');
  expect(await calls(page)).toEqual(['gameplayStart', 'gameplayStop']);
});

test('the speaker button cannot override the site mute', async ({ page }) => {
  await toHome(page, '?muteAudio=true');
  const speaker = page.locator('.mute-btn');
  await expect(speaker).toHaveClass(/off/);
  await speaker.click();
  await expect(speaker).toHaveClass(/off/);

  // The player's own choice survives: back to sound once the site lets go.
  await toHome(page);
  await expect(speaker).not.toHaveClass(/off/);
});

test('the site mute applies while the game is running', async ({ page }) => {
  await toHome(page);
  const speaker = page.locator('.mute-btn');
  await expect(speaker).not.toHaveClass(/off/);
  const setSiteMute = (m: boolean) => page.evaluate((m) => {
    window.__siteMute = m;
    window.__settingsListeners.forEach((f) => f());
  }, m);
  await setSiteMute(true);
  await expect(speaker).toHaveClass(/off/);
  await setSiteMute(false);
  await expect(speaker).not.toHaveClass(/off/);
});

test('SETTINGS has no music slider while no music ships', async ({ page }) => {
  await toHome(page);
  await page.click('button[data-m="settings"]');
  await expect(page.locator('input[data-s=sfx]')).toBeVisible();
  await expect(page.locator('input[data-s=music]')).toHaveCount(0);
});
