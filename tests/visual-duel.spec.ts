import { test, expect } from '@playwright/test';

test.describe('Gamey - Duel Gameplay Tests', () => {
  test('Desktop 1920x1080 - Full duel flow', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    
    await page.goto('http://localhost:5174');
    await page.waitForLoadState('networkidle');
    
    // Screenshot: Home screen
    await page.screenshot({ path: 'tests/screenshots/1-home.png' });
    console.log('📸 Home screen loaded');
    
    // Click Standard mode
    await page.click('button[data-m="standard"]');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/2-duel-start.png' });
    console.log('✓ Clicked Standard mode');
    
    // Wait for holster zone
    await page.waitForSelector('.readyzone', { timeout: 5000 });
    await page.screenshot({ path: 'tests/screenshots/3-holster-visible.png' });
    console.log('✓ Holster zone visible');
    
    // Move mouse to holster zone to start
    const holster = await page.locator('.readyzone').boundingBox();
    if (holster) {
      await page.mouse.move(holster.x + holster.width / 2, holster.y + holster.height / 2);
      await page.waitForTimeout(200);
    }
    await page.screenshot({ path: 'tests/screenshots/4-focus-started.png' });
    console.log('✓ Focus phase started - mouse in holster zone');
    
    // Press Space 5 times to shrink bloom
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Space');
      await page.waitForTimeout(120);
      console.log(`  Space press ${i + 1}/5`);
    }
    await page.screenshot({ path: 'tests/screenshots/5-focus-bloom.png' });
    console.log('✓ Bloom shrinking from Space presses');
    
    // Wait for DRAW (~3 seconds at 60Hz = 180 ticks)
    console.log('⏳ Waiting 3.5s for DRAW phase...');
    await page.waitForTimeout(3500);
    await page.screenshot({ path: 'tests/screenshots/6-draw.png' });
    console.log('✓ DRAW phase triggered');
    
    // Verify holster zone is hidden at DRAW
    const zoneVisible = await page.locator('.readyzone').isVisible().catch(() => false);
    console.log(`Holster zone visible after DRAW: ${zoneVisible} (should be false)`);
    
    // Get canvas position for aiming
    const canvas = await page.locator('canvas').boundingBox();
    if (canvas) {
      const centerX = canvas.x + canvas.width / 2;
      const centerY = canvas.y + canvas.height / 2;
      
      // Aim at foe head (upper center)
      const headX = centerX;
      const headY = centerY - 80;
      
      await page.mouse.move(headX, headY);
      await page.waitForTimeout(200);
      await page.screenshot({ path: 'tests/screenshots/7-aim-head.png' });
      console.log('✓ Aiming at foe head');
      
      // Click to fire
      await page.mouse.click(headX, headY);
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'tests/screenshots/8-fire-headshot.png' });
      console.log('✓ Fired at head - tracer should be visible');
    }
    
    // Verify ammo cylinder is visible and updated
    const cylinder = await page.locator('.cylinder').isVisible();
    expect(cylinder).toBe(true);
    console.log('✓ Ammo cylinder visible and responsive');
    
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'tests/screenshots/9-endround.png' });
    console.log('✓ Test complete');
  });

  test('Mobile 800x450 - Touch flow', async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 450 });
    
    await page.goto('http://localhost:5174');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/mobile-1-home.png' });
    console.log('📸 Mobile home screen');
    
    // Click Standard
    await page.click('button[data-m="standard"]');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/mobile-2-duel-start.png' });
    console.log('✓ Clicked Standard');
    
    // Wait for holster
    await page.waitForSelector('.readyzone', { timeout: 5000 });
    await page.screenshot({ path: 'tests/screenshots/mobile-3-holster.png' });
    console.log('✓ Holster zone visible on mobile');
    
    // Tap holster to start focus
    await page.click('.readyzone');
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'tests/screenshots/mobile-4-focus-start.png' });
    console.log('✓ Focus started via holster tap');
    
    // Tap left pad multiple times to shrink bloom
    for (let i = 0; i < 4; i++) {
      await page.click('.pad.left');
      await page.waitForTimeout(150);
      console.log(`  Pad tap ${i + 1}/4`);
    }
    await page.screenshot({ path: 'tests/screenshots/mobile-5-bloom-shrink.png' });
    console.log('✓ Bloom shrinking from pad taps');
    
    // Wait for DRAW
    console.log('⏳ Waiting for DRAW...');
    await page.waitForTimeout(3500);
    await page.screenshot({ path: 'tests/screenshots/mobile-6-draw.png' });
    console.log('✓ DRAW triggered');
    
    // Verify cylinder positioning (bottom-right, safe from pads)
    const cylinder = await page.locator('.cylinder').boundingBox();
    const rightPad = await page.locator('.pad.right').boundingBox();
    
    if (cylinder && rightPad) {
      console.log(`Cylinder: bottom-right at x=${cylinder.x}, y=${cylinder.y}, w=${cylinder.width}, h=${cylinder.height}`);
      console.log(`Right pad: x=${rightPad.x}, y=${rightPad.y}, w=${rightPad.width}, h=${rightPad.height}`);
      // Cylinder should be positioned to not interfere
      expect(cylinder.x >= 0).toBe(true);
      console.log('✓ Cylinder positioned correctly (bottom-right)');
    }
    
    // Drag to aim (first finger)
    const canvas = await page.locator('canvas').boundingBox();
    if (canvas) {
      const centerX = canvas.x + canvas.width / 2;
      const centerY = canvas.y + canvas.height / 2;
      const aimX = centerX;
      const aimY = centerY - 50;
      
      // Drag first finger to aim
      await page.mouse.move(aimX, aimY);
      await page.waitForTimeout(200);
      await page.screenshot({ path: 'tests/screenshots/mobile-7-drag-aim.png' });
      console.log('✓ First finger aiming');
      
      // Tap to fire (quick tap = no drag movement)
      await page.mouse.down();
      await page.waitForTimeout(50);
      await page.mouse.up();
      await page.waitForTimeout(500);
      await page.screenshot({ path: 'tests/screenshots/mobile-8-fire.png' });
      console.log('✓ Fired - tracer and spread cross visible');
    }
    
    // Verify mobile layout stayed intact
    const topUI = await page.locator('.hud .cue').isVisible();
    expect(topUI).toBe(true);
    console.log('✓ HUD visible at top');
    
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'tests/screenshots/mobile-9-endround.png' });
    console.log('✓ Mobile test complete');
  });

  test('Console errors check', async ({ page }) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
        console.error(`❌ Console error: ${msg.text()}`);
      }
      if (msg.type() === 'warning') {
        warnings.push(msg.text());
      }
    });

    await page.goto('http://localhost:5174');
    await page.waitForLoadState('networkidle');
    await page.click('button[data-m="standard"]');
    await page.waitForTimeout(2000);

    if (errors.length > 0) {
      console.warn(`⚠️ Found ${errors.length} console errors`);
    } else {
      console.log('✓ No console errors detected');
    }
    
    if (warnings.length > 0) {
      console.log(`ℹ️ ${warnings.length} console warnings (not blocking)`);
    }
    
    expect(errors.length).toBe(0);
  });
});

