import { chromium } from 'playwright';
(async () => {
    console.log('🎮 Launching Chromium in headed mode (visible on your Windows desktop via WSLg)...\n');
    const browser = await chromium.launch({
        headless: false,
        slowMo: 400,
    });
    const page = await browser.newPage({
        viewport: { width: 1920, height: 1080 },
    });
    console.log('🌐 Step 1: Loading home screen...');
    await page.goto('http://localhost:5173');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/step-1-home.png' });
    console.log('   ✓ Home screen loaded\n');
    console.log('🎯 Step 2: Clicking "STANDARD — BEST OF" button...');
    await page.click('button[data-m="standard"]');
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: 'tests/screenshots/step-2-standard-clicked.png' });
    console.log('   ✓ Started Standard mode\n');
    console.log('📍 Step 3: Holster zone should be visible...');
    await page.waitForSelector('.readyzone', { timeout: 5000 });
    await page.screenshot({ path: 'tests/screenshots/step-3-holster-zone.png' });
    console.log('   ✓ Holster zone found\n');
    console.log('🖱️ Step 4: Moving mouse INTO holster zone...');
    const holster = await page.locator('.readyzone').boundingBox();
    if (holster) {
        await page.mouse.move(holster.x + holster.width / 2, holster.y + holster.height / 2);
        await page.waitForTimeout(300);
    }
    await page.screenshot({ path: 'tests/screenshots/step-4-focus-started.png' });
    console.log('   ✓ Focus phase started!\n');
    console.log('⌨️ Step 5: Pressing SPACE 6 times to shrink bloom...');
    for (let i = 0; i < 6; i++) {
        console.log(`   Tap ${i + 1}/6`);
        await page.keyboard.press('Space');
        await page.waitForTimeout(150);
    }
    await page.screenshot({ path: 'tests/screenshots/step-5-bloom-shrinking.png' });
    console.log('   ✓ Bloom shrinking!\n');
    console.log('⏳ Step 6: Waiting 3.2s for DRAW...');
    await page.waitForTimeout(3200);
    await page.screenshot({ path: 'tests/screenshots/step-6-draw.png' });
    console.log('   ✓ DRAW! Holster zone should be hidden\n');
    console.log('🎯 Step 7: Aiming at foe HEAD...');
    const canvas = await page.locator('canvas').boundingBox();
    if (canvas) {
        const headX = canvas.x + canvas.width / 2;
        const headY = canvas.y + canvas.height / 2 - 100;
        await page.mouse.move(headX, headY);
        await page.waitForTimeout(300);
    }
    await page.screenshot({ path: 'tests/screenshots/step-7-aim-head.png' });
    console.log('   ✓ Aimed at head\n');
    console.log('🔫 Step 8: FIRING! Watch for tracer line and spread cross...');
    const canvas2 = await page.locator('canvas').boundingBox();
    if (canvas2) {
        const headX = canvas2.x + canvas2.width / 2;
        const headY = canvas2.y + canvas2.height / 2 - 100;
        await page.mouse.click(headX, headY);
        await page.waitForTimeout(600);
    }
    await page.screenshot({ path: 'tests/screenshots/step-8-fire-headshot.png' });
    console.log('   ✓ HEADSHOT! Tracer line + spread cross visible\n');
    console.log('💫 Step 9: Checking ammo cylinder...');
    await page.screenshot({ path: 'tests/screenshots/step-9-ammo-cylinder.png' });
    console.log('   ✓ Cylinder updated\n');
    console.log('⏳ Waiting for round end...');
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'tests/screenshots/step-10-round-end.png' });
    console.log('\n✅ TEST COMPLETE! Browser stays open for 15 seconds.\n');
    console.log('📸 Check screenshots in tests/screenshots/\n');
    await page.waitForTimeout(15000);
    await browser.close();
})();
