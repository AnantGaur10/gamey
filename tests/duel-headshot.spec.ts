import { test, expect, Page } from '@playwright/test';

// Hat = head (user 2026-10-21: "i am hitting the hat constantly and its not
// counting it as a headshot"). Shoots the passive tutorial dummy of every
// outfit through its crown top and its brim edge, each must kill as a
// headshot; a control shot just past the brim must not. Targets come from
// the rig's measured hat profile (DEV __gamey.dims), screen spots from
// __gamey.aimHead. Bloom is focused down with QTE hits first.

type Hat = { y0: number; step: number; r: number[] };
type Gamey = {
  tutorial(foe?: string, d?: number): void;
  dims(s: string): { hat: Hat | null; glb: boolean };
  aimHead(s: string, dy: number, lateral?: number): { x: number; y: number };
  gun(s: string): { drawTick: number; tick: number };
  state(): { phase: string; roundOver: boolean; foeHP: number; ammo: number };
  qte(): { needle: number; zoneC: number; zoneW: number; frozen: boolean; phase: string; paused: boolean; bloom: number };
  bloom(deg: number): void;
};

async function boot(page: Page): Promise<void> {
  await page.goto('/basic.html');
  await page.waitForLoadState('networkidle');
  if (await page.locator('.skip').isVisible().catch(() => false)) {
    await page.click('.skip button');
    await page.waitForTimeout(400);
    if (await page.locator('.nameprompt').isVisible().catch(() => false)) await page.click('.nameprompt [data-n=skip]'); // guest name screen after the tutorial
  }
}

/** Fresh passive dummy at 10m, GLBs in, Focus QTE chained until DRAW, gun clear. */
async function dummyAtDraw(page: Page, foe: string): Promise<void> {
  await page.evaluate((f) => (window as unknown as { __gamey: Gamey }).__gamey.tutorial(f, 10), foe);
  await page.waitForFunction(() => { const g = (window as unknown as { __gamey: Gamey }).__gamey; return g.dims('foe').glb && g.state().phase === 'ready'; }, null, { timeout: 15000 });
  const z = await page.locator('.readyzone').boundingBox();
  await page.mouse.move(z!.x + z!.width / 2, z!.y + z!.height / 2);
  await page.waitForFunction(() => (window as unknown as { __gamey: Gamey }).__gamey.qte().phase === 'focus', null, { timeout: 8000 });
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
  await page.waitForFunction(() => { const k = (window as unknown as { __gamey: Gamey }).__gamey.gun('player'); return k.drawTick >= 0 && k.tick - k.drawTick >= 12; }, null, { timeout: 15000 });
}

/** One shot at (dy above the head centre, lateral m) with the bloom pinned
    to 0.03 deg (the regrow after DRAW would open it ~0.5 deg/s); returns
    foe HP once the bullet is done. */
async function shoot(page: Page, dy: number, lateral: number): Promise<{ foeHP: number; sub: string }> {
  const before = await page.evaluate(() => (window as unknown as { __gamey: Gamey }).__gamey.state().ammo);
  await page.evaluate(([dy, lat]) => {
    const g = (window as unknown as { __gamey: Gamey }).__gamey;
    const p = g.aimHead('foe', dy, lat);
    g.bloom(0.03);
    document.elementFromPoint(p.x, p.y)?.dispatchEvent(new PointerEvent('pointerdown',
      { clientX: p.x, clientY: p.y, button: 0, pointerType: 'mouse', bubbles: true }));
  }, [dy, lateral]);
  await page.waitForFunction((n) => (window as unknown as { __gamey: Gamey }).__gamey.state().ammo < n, before, { timeout: 5000 });
  // 10m at 110m/s is ~6 ticks; give the bullet + kill routing a moment
  // (and the shot kick its 0.6s return before a next shot).
  await page.waitForTimeout(900);
  return page.evaluate(() => ({
    foeHP: (window as unknown as { __gamey: Gamey }).__gamey.state().foeHP,
    sub: document.querySelector('.hud .sub')?.textContent ?? '',
  }));
}

const FOES = ['outlaw', 'greenhorn', 'prospector', 'bandido', 'kate', 'ghost', 'ruby', 'dandy', 'marshal', 'widow'];

test('head priority: chin is a headshot, collar is body, crouched head is a headshot', async ({ page }) => {
  // The body capsule's top cap used to catch head-bound bullets first
  // (84% of dead-centre head shots, every chin shot, scored as body).
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await boot(page);
  await dummyAtDraw(page, 'outlaw');
  const chin = await shoot(page, -0.15, 0);
  expect(chin.foeHP).toBe(0);
  expect(chin.sub).toContain('Headshot');

  await dummyAtDraw(page, 'outlaw');
  const collar = await shoot(page, -0.32, 0); // 1.58m: below the visible head
  expect(collar.foeHP).toBeGreaterThan(0);
  expect(collar.foeHP).toBeLessThan(100);
  // First hit -> crouch; aimHead follows the crouched capsule.
  await page.waitForTimeout(600);
  const crouched = await shoot(page, 0, 0);
  expect(crouched.foeHP).toBe(0);
  expect(crouched.sub).toContain('Headshot');
  expect(errors).toEqual([]);
});

for (const foe of FOES) {
  test(`hat counts as the head: ${foe}`, async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    await boot(page);

    // Crown top (above the old 0.34 head sphere for every hat).
    await dummyAtDraw(page, foe);
    const hat = (await page.evaluate(() => (window as unknown as { __gamey: Gamey }).__gamey.dims('foe'))).hat!;
    expect(hat).not.toBeNull();
    const top = hat.y0 + hat.step * (hat.r.length - 1.5); // mid of the last full band
    const brimR = Math.max(...hat.r.slice(0, 2));
    // Control: past the brim at brim height -> no hit at all.
    const ctl = await shoot(page, hat.y0 + hat.step, brimR + 0.12);
    expect(ctl.foeHP).toBe(100);
    const crown = await shoot(page, top, 0);
    console.log(`${foe} crown dy ${top.toFixed(2)}: hp ${crown.foeHP} "${crown.sub}"`);
    expect(crown.foeHP).toBe(0);
    expect(crown.sub).toContain('Headshot');

    // Brim, halfway between the head sphere (r 0.25) and the brim edge.
    await dummyAtDraw(page, foe);
    const lat = (brimR + 0.25) / 2;
    const brim = await shoot(page, hat.y0 + hat.step, lat);
    console.log(`${foe} brim lateral ${lat.toFixed(2)} of ${brimR}: hp ${brim.foeHP} "${brim.sub}"`);
    expect(brim.foeHP).toBe(0);
    expect(brim.sub).toContain('Headshot');
    expect(errors).toEqual([]);
  });
}
