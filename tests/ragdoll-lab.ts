// Ragdoll rest-pose statistics, no screencast (it slows the sim): many foe
// deaths per wound pose through the DEV `__gamey.ragdollLab` probe, each a
// throwaway doll stepped on the fixed clock, then how the corpse came to rest.
//   HEADLESS=1 [FOE=bandido] [N=40] npx tsx tests/ragdoll-lab.ts
// Needs the dev server on 5174. A "seated" corpse rests with the torso more
// than 30 deg off the dirt (up > 0.5) or the head above 0.6m.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'fs';

const foe = process.env.FOE || 'outlaw';
const n = Number(process.env.N || 40);
const dist = Number(process.env.DIST || 10);
// 1.4s ~= when the round's cleanup() freezes the corpse on screen.
const secs = Number(process.env.SECS || 2.5);
const outDir = `test-results/ragdoll-lab/${foe}`;
mkdirSync(outDir, { recursive: true });

type Row = { i: number; head: number; pelvis: number; torso: number; headY: number; up: number; maxY: number; still: number; gap: number; gapAt: string };
type Lab = { wound: string; rows: Row[]; img: string | null } | null;
type G = { __gamey: { tutorial(f?: string, d?: number): void; ragdollLab(o: object): Lab; where(): { foe: string } } };

(async () => {
  const browser = await chromium.launch({ headless: process.env.HEADLESS !== '0' });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('http://localhost:5174/basic.html?nosdk=1');
  await page.waitForFunction(() => !!(window as unknown as G).__gamey, null, { timeout: 15000 });
  await page.evaluate(([f, d]) => (window as unknown as G).__gamey.tutorial(f as string, d as number), [foe, dist]);
  await page.waitForSelector('.readyzone', { timeout: 8000 });
  const z = (await page.locator('.readyzone').boundingBox())!;
  await page.mouse.move(z.x + z.width / 2, z.y + z.height / 2);
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('FOCUS'), { timeout: 8000 });
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('DRAW'), { timeout: 15000 });
  await page.waitForTimeout(1200); // gun arm levelled on the player
  const summary: string[] = [];
  for (const wound of (process.env.WOUNDS || 'none,crouch,prone').split(',')) {
    const r = await page.evaluate(([w, k, t]) => (window as unknown as G).__gamey.ragdollLab({ wound: w, n: k, secs: t }), [wound, n, secs] as const);
    if (!r) { summary.push(`${wound}: lab returned null`); continue; }
    writeFileSync(`${outDir}/${wound}.json`, JSON.stringify(r.rows, null, 1));
    const seated = r.rows.filter((x) => x.up > 0.5 || x.headY > 0.6);
    const avg = (k: keyof Row) => (r.rows.reduce((s, x) => s + (x[k] as number), 0) / r.rows.length).toFixed(2);
    const maxGap = Math.max(...r.rows.map((x) => x.gap));
    const unsettled = r.rows.filter((x) => x.still < 0).length;
    summary.push(`${wound}: seated ${seated.length}/${r.rows.length} [${seated.map((x) => `#${x.i}${x.head ? 'h' : 'b'} up${x.up} head${x.headY}`).join(', ')}]  avg pelvis ${avg('pelvis')} torso ${avg('torso')} head ${avg('headY')} up ${avg('up')} still ${avg('still')}s unsettled ${unsettled}  maxGap ${maxGap}`);
  }
  const shots = (process.env.SHOTS || '').split(',').filter(Boolean);
  for (const s of shots) {
    const [wound, idx] = s.split(':');
    const r = await page.evaluate(([w, i, a]) => (window as unknown as G).__gamey.ragdollLab({ wound: w, n: Number(i) + 1, shot: Number(i), view: Number(a) }), [wound, idx, process.env.ANGLE ?? '90'] as const);
    if (r?.img) writeFileSync(`${outDir}/${wound}-${idx}-a${process.env.ANGLE ?? 90}.jpg`, Buffer.from(r.img.split(',')[1], 'base64'));
  }
  console.log(`FOE ${foe} d=${dist}m (${await page.evaluate(() => (window as unknown as G).__gamey.where().foe)})`);
  for (const s of summary) console.log(s);
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
  await browser.close();
})();
