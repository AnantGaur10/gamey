import { test, expect, Page } from '@playwright/test';

// Wound lottery assertions (locked 2026-10-02): taken hits produce persistent
// bend/crouch/prone poses, the capsule follows the pose, wounds reset per
// duel. Reads the DEV-only window.__gamey probe (zero prod surface).

interface Wounds {
  player: string;
  playerHits: number;
  foe: string;
  foeHits: number;
}

async function wounds(page: Page): Promise<Wounds> {
  return page.evaluate(() => (window as unknown as { __gamey: { wounds(): Wounds } }).__gamey.wounds());
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

async function foeHP(page: Page): Promise<number> {
  return page.evaluate(() => parseFloat(
    ((document.querySelector('.hp.foe i') as HTMLElement | null)?.style.width || '100'),
  ));
}

test.describe('Gamey - Wounds', () => {
  // Visual-vs-hitbox guard (2026-10-04): the old poses sat 0.2-0.33m ABOVE
  // their hit capsules, so shots at the visible head missed. Pose tables are
  // tuned to the capsules; prone must also keep the muzzle above the dirt
  // (bullets spawn at the muzzle).
  test('wound poses visibly match their hit capsules (head height, prone muzzle above ground)', async ({ page }) => {
    // Tutorial duel (fresh profile): passive dummy never shoots, so nobody dies
    // mid-test and the round never resets the forced poses. Must be in DRAW:
    // the gun arm is only driven there (wounds never exist before it).
    await page.goto('/basic.html');
    await page.waitForLoadState('networkidle');
    await page.waitForSelector('.readyzone', { timeout: 8000 });
    await parkInHolster(page);
    await tapSpace(page, 10);
    await waitDraw(page);
    await page.waitForTimeout(1200);
    type G = { __gamey: {
      force(s: string, w: string): void;
      capsule(s: string): { headY: number };
      parts(s: string): Record<string, [number, number, number] | null>;
      armChain(s: string): { gunTip: [number, number, number] };
    } };
    for (const side of ['foe', 'player']) {
      for (const pose of ['bend', 'crouch', 'prone']) {
        await page.evaluate(([s, w]) => (window as unknown as G).__gamey.force(s, w), [side, pose]);
        await page.waitForTimeout(1800); // damped chase settles
        const m = await page.evaluate((s) => {
          const g = (window as unknown as G).__gamey;
          return { cap: g.capsule(s), head: g.parts(s).head, chain: g.armChain(s) };
        }, side);
        expect(m.head, `${side} ${pose} head part`).not.toBeNull();
        expect(Math.abs(m.head![1] - m.cap.headY), `${side} ${pose} visible head vs capsule headY ${m.cap.headY}`).toBeLessThan(0.1);
        if (pose === 'prone') expect(m.chain.gunTip[1], `${side} prone muzzle height`).toBeGreaterThan(0.05);
      }
    }
  });

  test('lottery: hit 1 never prone, hit 0 always none', { timeout: 150000 }, async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    const r = await page.evaluate(() => {
      const g = (window as unknown as { __gamey: { roll(n: number): string } }).__gamey;
      const one: string[] = [];
      const two: string[] = [];
      for (let i = 0; i < 300; i++) one.push(g.roll(1));
      for (let i = 0; i < 400; i++) two.push(g.roll(2));
      return { zero: g.roll(0), one, two };
    });
    expect(r.zero).toBe('none');
    expect(r.one.every((w) => w === 'bend' || w === 'crouch')).toBe(true);
    expect(r.two.every((w) => w === 'bend' || w === 'crouch' || w === 'prone')).toBe(true);
    expect(r.two).toContain('prone'); // 25% over 400 draws: essentially certain
  });

  test('first body wound poses the foe (bend or crouch)', { timeout: 150000 }, async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await tapSpace(page, 6);
    await waitDraw(page);
    // Up to 6 body shots; stop at the first damaging (non-lethal) hit.
    let wounded = false;
    for (let i = 0; i < 6; i++) {
      const hp = await foeHP(page);
      if (hp < 100 && hp > 0) { wounded = true; break; }
      if (hp <= 0) break; // headshot kill: no wound expected, death rules win
      const p = await aimBody(page);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(600);
    }
    const w = await wounds(page);
    if (wounded) {
      expect(w.foeHits).toBe(1);
      expect(['bend', 'crouch']).toContain(w.foe);
    } else {
      // Foe died before a non-lethal hit landed — wounds correctly untouched.
      expect(await foeHP(page)).toBeLessThanOrEqual(0);
      expect(w.foe).toBe('none');
    }
  });

  test('capsule follows the wound (lowered hitbox)', { timeout: 150000 }, async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await tapSpace(page, 6);
    await waitDraw(page);
    for (let i = 0; i < 6; i++) {
      const hp = await foeHP(page);
      if (hp < 100 && hp > 0) break;
      if (hp <= 0) break;
      const p = await aimBody(page);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(600);
    }
    const w = await wounds(page);
    const cap = await page.evaluate(() => (window as unknown as {
      __gamey: { capsule(s: string): { headY: number; bodyLoY: number; bodyHiY: number } };
    }).__gamey.capsule('foe'));
    if (w.foe === 'none') {
      expect(cap.headY).toBe(1.9); // standing capsule untouched
    } else {
      expect(cap.headY).toBeLessThan(1.9); // wounded: hitbox moved with visual
      expect(cap.bodyHiY).toBeLessThan(1.55);
    }
  });

  test('prone duelists keep fighting both ways (forced prone)', { timeout: 150000 }, async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await tapSpace(page, 6);
    await waitDraw(page);
    // Force the foe prone: capsule drops, and the player can still hit it
    // (center-screen body aim stays inside the low capsule). The capsule
    // switches synchronously in force(), so only a short visual settle is
    // needed — the foe fires back live, so every idle ms risks dying before
    // landing a hit (round advance resets wounds and fails the test).
    await page.evaluate(() => (window as unknown as { __gamey: { force(s: string, w: string): void } })
      .__gamey.force('foe', 'prone'));
    await page.waitForTimeout(200); // damped pose settles
    const cap = await page.evaluate(() => (window as unknown as {
      __gamey: { capsule(s: string): { headY: number } };
    }).__gamey.capsule('foe'));
    expect(cap.headY).toBe(0.55);
    // Aim at the lowered capsule mid (viewport-proof via the DEV probe).
    // Full cylinder + tight cadence: win the race against the live AI.
    let hitProneFoe = false;
    for (let i = 0; i < 6; i++) {
      const hp = await foeHP(page);
      if (hp < 100) { hitProneFoe = true; break; }
      const cue = await page.evaluate(() => document.querySelector('.cue')?.textContent ?? '');
      if (/DOWN|HEADSHOT|VICTORY|DEFEAT/.test(cue)) break; // round over: no more hits possible
      const p = await page.evaluate(() => (window as unknown as {
        __gamey: { aimAt(s: string): { x: number; y: number } };
      }).__gamey.aimAt('foe'));
      await page.mouse.move(p.x, p.y);
      await page.waitForTimeout(200);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(500); // beats the 380ms cooldown, minimal AI exposure
    }
    expect(hitProneFoe).toBe(true);
    // Force the player prone: the AI still tracks and hits the low capsule.
    await page.evaluate(() => (window as unknown as { __gamey: { force(s: string, w: string): void } })
      .__gamey.force('player', 'prone'));
    await page.waitForFunction(
      () => parseFloat((document.querySelector('.hp.you i') as HTMLElement | null)?.style.width || '100') < 100,
      { timeout: 20000 },
    );
  });

  test('wounds reset when the next round starts', { timeout: 150000 }, async ({ page }) => {
    await startStandard(page);
    await parkInHolster(page);
    await tapSpace(page, 6);
    await waitDraw(page);
    // Play round 1 out (either side may win — the foe shoots back). Stop
    // firing once the round resolves.
    for (let i = 0; i < 10; i++) {
      const hp = await foeHP(page);
      const php = await page.evaluate(() => parseFloat(
        ((document.querySelector('.hp.you i') as HTMLElement | null)?.style.width || '100'),
      ));
      if (hp <= 0 || php <= 0) break;
      const c = await page.evaluate(() => document.querySelector('.cue')?.textContent ?? '');
      if (/DOWN|HEADSHOT|VICTORY|DEFEAT|HELL/.test(c)) break;
      const p = await aimBody(page);
      await page.mouse.click(p.x, p.y);
      await page.waitForTimeout(600);
    }
    // Series auto-advances (Round 2, or hell on a double KO) with fresh state.
    await page.waitForFunction(
      () => {
        const t = document.querySelector('.roundline')?.textContent ?? '';
        return t.includes('ROUND 2') || t.includes('HELL');
      },
      { timeout: 30000 },
    );
    await page.waitForTimeout(500);
    const w = await wounds(page);
    expect(w.foe).toBe('none');
    expect(w.foeHits).toBe(0);
    expect(w.player).toBe('none');
    expect(w.playerHits).toBe(0);
  });
});
