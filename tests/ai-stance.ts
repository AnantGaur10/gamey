// Standing-pose close-ups: joint rotations (probe) + crops of both duelists.
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
const [W, H] = (process.env.VIEWPORT || '1920x1080').split('x').map(Number);
const out = `test-results/ai-stance/${W}x${H}`; mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch({ headless: process.env.HEADLESS !== '0' });
  const p = await (await b.newContext({ viewport: { width: W, height: H } })).newPage();
  p.on('pageerror', (e) => console.error('❌', e.message));
  await p.goto('http://localhost:5174/basic.html', { waitUntil: 'networkidle' });
  await p.waitForSelector('.readyzone', { timeout: 8000 });
  await p.waitForTimeout(2500); // GLB swap + idle settle
  const j = await p.evaluate(() => { const g = (window as any).__gamey; return { player: g.joints('player'), foe: g.joints('foe') }; });
  console.log('JOINTS', JSON.stringify(j));
  await p.screenshot({ path: `${out}/stance-full.png` });
  await p.screenshot({ path: `${out}/stance-foe.png`, clip: { x: W * 0.36, y: H * 0.28, width: W * 0.2, height: H * 0.5 } });
  await p.screenshot({ path: `${out}/stance-player.png`, clip: { x: W * 0.46, y: H * 0.45, width: W * 0.2, height: H * 0.5 } });
  await b.close();
})();
