// Ragdoll footage capture. Kills the foe (tutorial dummy = deterministic) with
// head / body shots, bursts screenshots right after the kill, and logs part
// positions over time. Also captures the PLAYER dying (standard duel, idle).
//   HEADLESS=1 VIEWPORT=1920x1080 npx tsx tests/ai-ragdoll.ts
import { chromium, Page } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'fs';

const [W, H] = (process.env.VIEWPORT || '1920x1080').split('x').map(Number);
const headless = process.env.HEADLESS !== '0';
const outDir = `test-results/ai-ragdoll/${W}x${H}`;
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

type G = {
  __gamey: {
    aimAt(s: string, p?: string): { x: number; y: number };
    parts(s: string): Record<string, [number, number, number] | null>;
  };
};
const cue = (p: Page) => p.evaluate(() => document.querySelector('.cue')?.textContent ?? '');
const foeHp = (p: Page) =>
  p.evaluate(() => parseFloat((document.querySelector('.hp.foe i') as HTMLElement | null)?.style.width || '100'));
const youHp = (p: Page) =>
  p.evaluate(() => parseFloat((document.querySelector('.hp.you i') as HTMLElement | null)?.style.width || '100'));

async function toDraw(page: Page) {
  await page.waitForSelector('.readyzone', { timeout: 8000 });
  const z = (await page.locator('.readyzone').boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2);
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('FOCUS'), { timeout: 8000 });
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(100); }
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('DRAW'), { timeout: 15000 });
}

// CDP screencast: page.screenshot() is ~1s/frame headless — slower than the
// ~1.5s kill->home window, so every frame landed after the ragdoll was gone.
// Screencast streams frames fast; we keep those from the kill moment on.
type Cast = { frames: Array<{ t: number; data: string }>; stop(): Promise<void> };
async function startCast(page: Page): Promise<Cast> {
  const cdp = await page.context().newCDPSession(page);
  const frames: Cast['frames'] = [];
  cdp.on('Page.screencastFrame', (f: any) => {
    frames.push({ t: Date.now(), data: f.data });
    cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80, everyNthFrame: 1 });
  return { frames, stop: async () => { await cdp.send('Page.stopScreencast').catch(() => {}); } };
}

// Keep screencast frames from the kill on; log part positions meanwhile.
// `from` = wall time to keep frames from (the lethal shot); HP polling detects
// the kill up to ~0.5s late, which would drop the pose -> ragdoll hand-off.
async function burst(page: Page, cast: Cast, side: 'foe' | 'player', tag: string, ms = 1400, from?: number) {
  const tKill = Date.now();
  const log: string[] = [];
  while (Date.now() - tKill < ms) {
    const parts = await page.evaluate((s) => (window as unknown as G).__gamey.parts(s), side).catch(() => null);
    if (parts) {
      const ys = Object.values(parts).filter((v): v is [number, number, number] => !!v).map((v) => v[1]);
      log.push(`t=${Date.now() - tKill}ms minY=${Math.min(...ys).toFixed(2)} maxY=${Math.max(...ys).toFixed(2)} ${JSON.stringify(parts)}`);
    }
    await page.waitForTimeout(100);
  }
  await cast.stop();
  const kept = cast.frames.filter((f) => f.t >= (from ?? tKill) - 150);
  kept.forEach((f, i) =>
    writeFileSync(`${outDir}/${tag}-${String(i).padStart(2, '0')}-t${f.t - tKill}.jpg`, Buffer.from(f.data, 'base64')));
  console.log(`\n== ${tag}: ${kept.length} frames, parts timeline ==\n${log.join('\n')}`);
}

async function killFoe(page: Page, part: 'mid' | 'head', tag: string, pre?: string) {
  await page.goto('http://localhost:5174/basic.html', { waitUntil: 'networkidle' });
  await toDraw(page);
  if (pre) {
    // Wound pose first (probe skips the hit): checks the pose -> ragdoll hand-off has no snap.
    await page.evaluate((w) => (window as any).__gamey.force('foe', w), pre);
    await page.waitForTimeout(1800);
  }
  await page.waitForTimeout(300);
  const cast = await startCast(page);
  let tShot = Date.now();
  for (let i = 0; i < 6; i++) {
    if ((await foeHp(page)) <= 0 || /DOWN|VICTORY|DEFEAT/.test(await cue(page))) break;
    const p = await page.evaluate(([s, pt]) => (window as unknown as G).__gamey.aimAt(s, pt), ['foe', part] as const);
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(200);
    tShot = Date.now();
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(500);
  }
  await page.waitForFunction(() => parseFloat((document.querySelector('.hp.foe i') as HTMLElement | null)?.style.width || '100') <= 0, { timeout: 15000 });
  await burst(page, cast, 'foe', tag, 1400, tShot);
}

async function playerDies(page: Page, tag: string) {
  await page.goto('http://localhost:5174/basic.html', { waitUntil: 'networkidle' });
  if (await page.locator('.skip').isVisible().catch(() => false)) { await page.click('.skip button'); await page.waitForTimeout(400); }
  await page.click('button[data-m="standard"]');
  await toDraw(page);
  // Idle: never shoot; the foe kills us.
  const cast = await startCast(page);
  await page.waitForFunction(() => parseFloat((document.querySelector('.hp.you i') as HTMLElement | null)?.style.width || '100') <= 0, { timeout: 20000 });
  await burst(page, cast, 'player', tag);
}

(async () => {
  const browser = await chromium.launch({ headless });
  const errors: string[] = [];
  for (const [name, fn] of [
    ['foe-body', (p: Page) => killFoe(p, 'mid', 'foe-body')],
    ['foe-head', (p: Page) => killFoe(p, 'head', 'foe-head')],
    ['foe-from-crouch', (p: Page) => killFoe(p, 'mid', 'foe-from-crouch', 'crouch')],
    ['foe-from-prone', (p: Page) => killFoe(p, 'mid', 'foe-from-prone', 'prone')],
    ['player-dies', (p: Page) => playerDies(p, 'player-dies')],
  ] as const) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H } });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => { errors.push(`${name}: ${e.message}`); console.error('❌', e.message); });
    page.on('console', (m) => { if (m.type() === 'error') { errors.push(`${name}: ${m.text()}`); console.error('❌', m.text()); } });
    try { await fn(page); } catch (e: any) { console.error(`❌ ${name} failed: ${e.message}`); errors.push(`${name}: ${e.message}`); await page.screenshot({ path: `${outDir}/${name}-ERROR.png` }); }
    await ctx.close();
  }
  await browser.close();
  console.log(errors.length ? `\n⚠️ ${errors.length} errors:\n${errors.join('\n')}` : '\n✓ no errors');
  console.log(`📂 ${outDir}`);
})();
