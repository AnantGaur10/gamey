import { chromium } from 'playwright';

// Fast probe: fire once, screenshot ~120ms later while smoke is mid-life.
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto('http://localhost:5199/basic.html');
await page.waitForTimeout(1500);
// Fresh profile -> tutorial duel with SKIP button; skip to home, then standard.
const skip = page.locator('.skip button');
if (await skip.count()) { await skip.click(); await page.waitForTimeout(500); }
await page.click('button[data-m="standard"]');
await page.waitForTimeout(800);
const zone = await page.locator('.readyzone').boundingBox();
await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2);
// Wait for DRAW (focus countdown ~3s while holstered).
await page.waitForFunction(() => document.querySelector('.cue')?.textContent === 'DRAW!', null, { timeout: 15000 });
// Aim: move to foe upper body (screen approx from prior shots).
await page.mouse.move(800, 420, { steps: 5 });
await page.waitForTimeout(400);
await page.mouse.click(800, 420);
await page.waitForTimeout(120);
await page.screenshot({ path: 'test-results/smoke-probe.png' });
await page.waitForTimeout(800);
await page.screenshot({ path: 'test-results/smoke-probe-late.png' });
console.log('errors:', errors.length ? errors : 'none');
await browser.close();
