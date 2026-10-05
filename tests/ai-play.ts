import { chromium, Page } from 'playwright';

interface GameState {
  phase: string;
  playerHP: number;
  foeHP: number;
  ammoLeft: number;
  bloomSize: number;
  roundIndex: number;
}

// Set by main() from VIEWPORT before any observe() call.
let shotDir = 'test-results/ai-play/1920x1080';

class AIGameController {
  private page: Page;
  private screenshotIndex = 0;
  private observations: string[] = [];

  constructor(page: Page) {
    this.page = page;
  }

  async observe(label: string): Promise<void> {
    this.screenshotIndex++;
    const filename = `${shotDir}/step-${String(this.screenshotIndex).padStart(3, '0')}-${label}.png`;
    await this.page.screenshot({ path: filename, fullPage: false });
    this.observations.push(`[${this.screenshotIndex}] ${label}`);
    console.log(`📸 ${label}`);
  }

  async getGameState(): Promise<Partial<GameState>> {
    const state = await this.page.evaluate(() => {
      const cue = document.querySelector('.cue')?.textContent || '';
      // Current HUD (see home.ts): .hpwrap > .hp.you/.hp.foe > i (width %)
      // and .cylinder > svg .chamber.live. Older selectors (.hpbar .fill,
      // .foehp .fill, .pip) no longer exist — querying them silently
      // returned the 100%/6 fallbacks forever.
      const youBar = document.querySelector('.hp.you i') as HTMLElement | null;
      const foeBar = document.querySelector('.hp.foe i') as HTMLElement | null;
      const cylinder = document.querySelector('.cylinder');
      const ammoLive = cylinder
        ? cylinder.querySelectorAll('.chamber.live').length
        : 6;
      const crosshair = document.querySelector('.crosshair') as HTMLElement;
      // Bloom now drives the crosshair line gap (lines+dot, no ring):
      // --gap holds the bloom radius in px, so diameter = gap * 2.
      const gap = crosshair ? parseFloat(getComputedStyle(crosshair).getPropertyValue('--gap') || '0') : 0;
      
      return {
        phase: cue,
        playerHP: youBar ? parseFloat(youBar.style.width || '100') : 100,
        foeHP: foeBar ? parseFloat(foeBar.style.width || '100') : 100,
        ammoLeft: ammoLive,
        bloomSize: gap * 2,
      };
    });
    
    return state;
  }

  async reportState(): Promise<void> {
    const state = await this.getGameState();
    console.log(`   State: phase="${state.phase}" playerHP=${state.playerHP}% foeHP=${state.foeHP}% ammo=${state.ammoLeft}/6 bloom=${Math.round(state.bloomSize)}px`);
  }

  async clickStandardMode(): Promise<void> {
    console.log('\n🎯 ACTION: Click STANDARD mode');
    await this.page.click('button[data-m="standard"]');
    await this.page.waitForLoadState('networkidle');
    await this.observe('clicked-standard');
    await this.reportState();
  }

  async enterHolsterZone(): Promise<void> {
    console.log('\n🖱️ ACTION: Enter holster zone to start countdown');
    // Round transitions rebuild the DOM: re-query until a live zone answers.
    let holster: { x: number; y: number; width: number; height: number } | null = null;
    for (let i = 0; i < 10 && !holster; i++) {
      holster = await this.page.locator('.readyzone').boundingBox({ timeout: 1000 }).catch(() => null);
    }
    if (holster) {
      await this.page.mouse.move(holster.x + holster.width / 2, holster.y + holster.height / 2);
      await this.page.waitForTimeout(300);
      await this.observe('entered-holster');
      await this.reportState();
    } else {
      console.warn('⚠️ Holster zone not found');
    }
  }

  /** Focus timing QTE: press Space while the needle is in the gold zone,
      chaining up to `count` hits before DRAW (reads the DEV __gamey probe,
      presses through the real window keydown path). */
  async focusTaps(count: number): Promise<void> {
    console.log(`\n⌨️ ACTION: Time SPACE into the gold zone (up to ${count} hits)`);
    const r = await this.page.evaluate((want) => new Promise<{ hits: number; misses: number }>((resolve) => {
      type Q = { needle: number; zoneC: number; zoneW: number; frozen: boolean; hits: number; misses: number; phase: string; paused: boolean };
      const g = (window as unknown as { __gamey?: { qte(): Q } }).__gamey;
      if (!g) { resolve({ hits: 0, misses: 0 }); return; }
      const t0 = performance.now();
      const loop = () => {
        const q = g.qte();
        if (q.hits >= want || q.phase !== 'focus' || performance.now() - t0 > 8000) {
          resolve({ hits: q.hits, misses: q.misses });
          return;
        }
        if (!q.frozen && !q.paused && Math.abs(q.needle - q.zoneC) < (q.zoneW / 2) * 0.6) {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', bubbles: true }));
        }
        setTimeout(loop, 4);
      };
      loop();
    }), count);
    const state = await this.getGameState();
    console.log(`   QTE hits ${r.hits}, misses ${r.misses} - bloom now ${Math.round(state.bloomSize || 0)}px`);
    await this.observe('focus-complete');
    await this.reportState();
  }

  async waitForDraw(): Promise<void> {
    console.log('\n⏳ ACTION: Wait for DRAW phase');
    // Any post-Focus state: on slow software GL the round can already be
    // resolving (cue past DRAW!, or a result screen) by the time we poll.
    await this.page.waitForFunction(
      () => !/FOCUS|HOLSTER/.test(document.querySelector('.cue')?.textContent ?? 'gone'),
      undefined,
      { timeout: 15000 },
    );
    await this.page.waitForTimeout(300);
    await this.observe('draw-triggered');
    await this.reportState();
  }

  async aimAt(target: 'head' | 'body' | 'miss-left' | 'miss-right'): Promise<{ x: number; y: number } | null> {
    // Round may already be over (result screen, no canvas): skip, don't hang.
    const canvas = await this.page.locator('canvas').boundingBox({ timeout: 2000 }).catch(() => null);
    if (!canvas) return null;

    const centerX = canvas.x + canvas.width / 2;
    const centerY = canvas.y + canvas.height / 2;

    let targetX = centerX;
    let targetY = centerY;

    switch (target) {
      case 'head':
        targetY = centerY - 100;
        break;
      case 'body':
        targetY = centerY - 20;
        break;
      case 'miss-left':
        targetX = centerX - 200;
        targetY = centerY - 50;
        break;
      case 'miss-right':
        targetX = centerX + 200;
        targetY = centerY - 50;
        break;
    }

    console.log(`\n🎯 ACTION: Aim at ${target} (${Math.round(targetX)}, ${Math.round(targetY)})`);
    await this.page.mouse.move(targetX, targetY);
    await this.page.waitForTimeout(200);
    
    return { x: targetX, y: targetY };
  }

  async fire(at: { x: number; y: number }): Promise<void> {
    console.log('\n🔫 ACTION: FIRE!');
    await this.page.mouse.click(at.x, at.y);
    await this.page.waitForTimeout(600);
    await this.observe('fired');
    await this.reportState();
  }

  async waitForRoundEnd(): Promise<void> {
    console.log('\n⏳ Waiting for round to end...');
    await this.page.waitForTimeout(2000);
    await this.observe('round-ended');
    await this.reportState();
  }

  async checkForErrors(): Promise<string[]> {
    const errors: string[] = [];
    this.page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });
    this.page.on('pageerror', (err) => {
      errors.push(err.message);
    });
    return errors;
  }

  async diagnose(): Promise<void> {
    console.log('\n🔍 DIAGNOSIS: Checking game elements...');
    
    const checks = await this.page.evaluate(() => {
      return {
        holsterExists: !!document.querySelector('.readyzone'),
        canvasExists: !!document.querySelector('canvas'),
        hudExists: !!document.querySelector('.hud'),
        crosshairExists: !!document.querySelector('.crosshair'),
        cylinderExists: !!document.querySelector('.cylinder'),
        qteBarExists: !!document.querySelector('.qte .qtrack'),
        buttonsExist: document.querySelectorAll('button').length,
      };
    });

    console.log('   Elements present:');
    for (const [key, value] of Object.entries(checks)) {
      const icon = value ? '✓' : '✗';
      console.log(`     ${icon} ${key}: ${value}`);
    }
  }

  printSummary(): void {
    console.log('\n📋 SESSION SUMMARY');
    console.log('━'.repeat(60));
    console.log(`Total observations: ${this.observations.length}`);
    console.log('\nActions taken:');
    this.observations.forEach(obs => console.log(`  ${obs}`));
    console.log(`\n📂 Screenshots saved to: ${shotDir}/`);
    console.log('━'.repeat(60));
  }
}

function parseViewport(): { width: number; height: number; label: string } {
  const raw = process.env.VIEWPORT || '1920x1080';
  const [w, h] = raw.split('x').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w < 320 || h < 240) {
    console.warn(`⚠️ Bad VIEWPORT="${raw}", falling back to 1920x1080`);
    return { width: 1920, height: 1080, label: '1920x1080' };
  }
  return { width: w, height: h, label: `${w}x${h}` };
}

(async () => {
  const vp = parseViewport();
  const headless = process.env.HEADLESS === '1';
  const inspectSecs = Math.max(0, parseInt(process.env.INSPECT_SECS || '30'));
  shotDir = `test-results/ai-play/${vp.label}`;

  console.log('🤖 AI-DRIVEN GAME TEST');
  console.log('━'.repeat(60));
  console.log(`Viewport: ${vp.width}x${vp.height} (${headless ? 'headless' : 'headed, visible via WSLg'})`);
  console.log('This test allows the AI to observe and interact with the game.\n');

  const browser = await chromium.launch({
    headless,
    slowMo: headless ? 0 : 400,
  });

  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    recordVideo: { dir: `test-results/ai-play-videos/${vp.label}` },
  });

  const page = await context.newPage();
  // tsx/esbuild wraps named functions inside page.evaluate callbacks in a
  // __name() helper that only exists in Node: define a no-op in the page.
  await page.addInitScript('window.__name = (f) => f;');
  const ai = new AIGameController(page);

  const errors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      errors.push(msg.text());
      console.error(`❌ Console: ${msg.text()}`);
    }
  });
  page.on('response', (r) => {
    if (r.status() >= 400) console.error(`❌ HTTP ${r.status()} ${r.url()}`);
  });
  page.on('pageerror', (err) => {
    errors.push(err.message);
    console.error(`❌ Error: ${err.message}`);
  });

  try {
    console.log('🌐 Loading game at http://localhost:5174/basic.html\n');
    await page.goto('http://localhost:5174/basic.html', { 
      waitUntil: 'networkidle',
      timeout: 10000 
    });
    await ai.observe('initial-load');

    await ai.diagnose();

    const isTutorial = await page.locator('.skip').isVisible().catch(() => false);
    if (isTutorial) {
      console.log('\n📚 Tutorial mode detected (first launch) - skipping to home');
      await page.click('.skip button');
      await page.waitForTimeout(500);
      await ai.observe('skipped-tutorial');
    }

    await ai.clickStandardMode();

    await page.waitForSelector('.readyzone', { timeout: 5000 });
    await ai.observe('holster-visible');

    await ai.enterHolsterZone();

    await ai.focusTaps(7);

    await ai.waitForDraw();

    const headPos = await ai.aimAt('head');
    if (headPos) {
      await ai.observe('aimed-head');
      await ai.fire(headPos);
    }

    await ai.waitForRoundEnd();

    console.log('\n🔄 Attempting second round (if available)...');
    await page.waitForTimeout(1000);
    
    // The next round's runDuel rebuilds the DOM: wait for ITS holster cue
    // instead of racing the old round's zone.
    const holsterStillExists = await page.waitForFunction(
      () => (document.querySelector('.cue')?.textContent ?? '').includes('HOLSTER UP'),
      undefined,
      { timeout: 15000 },
    ).then(() => true).catch(() => false);
    if (holsterStillExists) {
      console.log('✓ Next round started automatically');
      await ai.enterHolsterZone();
      await ai.focusTaps(5);
      await ai.waitForDraw();
      
      const bodyPos = await ai.aimAt('body');
      if (bodyPos) {
        await ai.observe('aimed-body');
        await ai.fire(bodyPos);
      }
      
      await ai.waitForRoundEnd();
    } else {
      console.log('ℹ️ Game ended or no second round available');
    }

    console.log('\n✅ AI TEST COMPLETE');
    
    if (errors.length > 0) {
      console.log(`\n⚠️ ${errors.length} errors detected:`);
      errors.forEach(err => console.log(`   - ${err}`));
    } else {
      console.log('\n✓ No errors detected');
    }

    ai.printSummary();

    console.log(`\n⏳ Browser stays open for ${inspectSecs} seconds for inspection...`);
    await page.waitForTimeout(inspectSecs * 1000);

  } catch (err: any) {
    console.error(`\n❌ TEST FAILED: ${err.message}`);
    await ai.observe('error-state').catch(() => {});
    await ai.diagnose().catch(() => {});
  } finally {
    await context.close();
    await browser.close();
    console.log('\n👋 Session ended.');
  }
})();
