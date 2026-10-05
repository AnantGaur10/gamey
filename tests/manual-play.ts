import { chromium } from 'playwright';

const VIEWPORT = process.env.VIEWPORT || '1920x1080';
const SLOW_MO = parseInt(process.env.SLOW_MO || '300');
const [width, height] = VIEWPORT.split('x').map(Number);

(async () => {
  console.log(`🎮 Manual Play Mode`);
  console.log(`   Viewport: ${width}x${height}`);
  console.log(`   SlowMo: ${SLOW_MO}ms`);
  console.log(`   Browser window will appear on your Windows desktop (WSLg)`);
  console.log(``);

  const browser = await chromium.launch({
    headless: false,
    slowMo: SLOW_MO,
    args: [
      '--disable-blink-features=AutomationControlled',
    ],
  });

  const context = await browser.newContext({
    viewport: { width, height },
    recordVideo: process.env.RECORD_VIDEO ? { dir: 'test-results/videos' } : undefined,
  });

  const page = await context.newPage();

  page.on('console', (msg) => {
    const type = msg.type();
    const text = msg.text();
    if (type === 'error') console.error(`❌ ${text}`);
    else if (type === 'warning') console.warn(`⚠️ ${text}`);
  });

  page.on('pageerror', (err) => {
    console.error(`❌ Page error: ${err.message}`);
  });

  console.log('🌐 Loading game...');
  try {
    await page.goto('http://localhost:5174/basic.html', { 
      waitUntil: 'domcontentloaded',
      timeout: 10000 
    });
    console.log('✅ Game loaded! Play freely.');
  } catch (err: any) {
    console.error(`❌ Failed to load: ${err.message}`);
    console.log('Attempting to continue anyway...');
  }
  console.log('');
  console.log('💡 Tips:');
  console.log('   - Click "STANDARD — BEST OF" to start a duel');
  console.log('   - Move mouse into holster zone (dashed box) to begin countdown');
  console.log('   - Press SPACE/ENTER rapidly to shrink bloom circle');
  console.log('   - After "DRAW!" appears, aim with mouse and click to fire');
  console.log('');
  console.log('⏳ Browser stays open for 10 minutes. Press Ctrl+C to exit early.');
  console.log('');

  await page.waitForTimeout(600000);

  if (process.env.RECORD_VIDEO) {
    await context.close();
    console.log('📹 Video saved to test-results/videos/');
  }
  
  await browser.close();
  console.log('👋 Session ended.');
})();
