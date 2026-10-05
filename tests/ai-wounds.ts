// Wound-pose close-ups (gameplay cam + profile cam) and the objective numbers:
// visible head/pelvis/torso world Y per pose vs the hit capsule in projectiles.ts.
//   HEADLESS=1 npx tsx tests/ai-wounds.ts            (SIDE=foe|player, default foe)
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const [W, H] = (process.env.VIEWPORT || '1920x1080').split('x').map(Number);
const side = (process.env.SIDE || 'foe') as 'foe' | 'player';
const out = `test-results/ai-wounds/${W}x${H}`; mkdirSync(out, { recursive: true });
const CAP: Record<string, { headY: number; lo: number; hi: number }> = {
  none: { headY: 1.9, lo: 0.4, hi: 1.62 }, bend: { headY: 1.68, lo: 0.75, hi: 1.42 },
  crouch: { headY: 1.32, lo: 0.5, hi: 1.12 }, prone: { headY: 0.55, lo: 0.08, hi: 0.72 },
};
(async () => {
  const b = await chromium.launch({ headless: process.env.HEADLESS !== '0' });
  const p = await (await b.newContext({ viewport: { width: W, height: H } })).newPage();
  p.on('pageerror', (e) => console.error('❌', e.message));
  await p.goto('http://localhost:5174/basic.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.readyzone', { timeout: 8000 });
  await p.waitForTimeout(2000);
  if (process.env.DRAW === '1') {
    // Tutorial duel (passive dummy, never fires): foe gun arm is DRIVEN in DRAW,
    // which is where wound-pose arm compensation matters.
    const z = (await p.locator('.readyzone').boundingBox())!;
    await p.mouse.move(z.x + z.width / 2, z.y + z.height / 2);
    await p.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('TAP'), { timeout: 8000 });
    for (let i = 0; i < 10; i++) { await p.keyboard.press('Space'); await p.waitForTimeout(100); }
    await p.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('DRAW'), { timeout: 15000 });
    await p.waitForTimeout(1200);
  }
  // TUNE='{"crouch":{"drop":-0.42,...}}' live-edits the pose tables (no rebuild).
  const tune = process.env.TUNE ? JSON.parse(process.env.TUNE) : {};
  for (const [k, v] of Object.entries(tune)) await p.evaluate(([pp, vv]) => (window as any).__gamey.setPose(pp, vv), [k, v]);
  for (const pose of ['none', 'bend', 'crouch', 'prone']) {
    await p.evaluate(([s, w]) => (window as any).__gamey.force(s, w), [side, pose]);
    await p.waitForTimeout(1800);
    const m = await p.evaluate((s) => { const pp = (window as any).__gamey.parts(s); return { gun: (window as any).__gamey.gunElev(s), head: pp.head?.[1], pelvis: pp.pelvis?.[1], torso: pp.torso?.[1], thigh: pp.thighL?.[1] }; }, side);
    const c = CAP[pose];
    console.log(`${pose.padEnd(7)} headY=${m.head} (capsule ${c.headY}, Δ${(m.head - c.headY).toFixed(2)})  pelvisY=${m.pelvis} torsoY=${m.torso} thighY=${m.thigh}  body window ${c.lo}-${c.hi}  gunElev=${m.gun}°`);
    const clip = side === 'foe'
      ? { x: W * 0.34, y: H * 0.2, width: W * 0.24, height: H * 0.6 }
      : { x: W * 0.44, y: H * 0.4, width: W * 0.24, height: H * 0.58 };
    await p.screenshot({ path: `${out}/${side}-${pose}.png`, clip });
    if (await p.evaluate(() => !!(window as any).__gamey.sideView)) {
      await p.evaluate(() => (window as any).__gamey.sideView(true));
      await p.waitForTimeout(250);
      await p.screenshot({ path: `${out}/${side}-${pose}-side.png`, clip: { x: W * 0.2, y: H * 0.1, width: W * 0.6, height: H * 0.8 } });
      await p.evaluate(() => (window as any).__gamey.sideView(false));
    }
  }
  await b.close();
})();
