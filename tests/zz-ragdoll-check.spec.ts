import { test, expect } from '@playwright/test';

// Ragdoll / model health: kill the foe with real headshots (retry loop —
// one bloom-spread shot can land body), then assert the corpse is coherent:
// all parts present, finite, bounded spread (no starfish), above the ground.
test('foe corpse coordinates at death', async ({ page }) => {
  // Tutorial duel (passive dummy, never fires back): the ONLY deterministic
  // way to kill — a live standard foe wins the damage race ~half the time
  // (both deal ~45/shot, both need 3 hits). Kill path is identical
  // (killFoe → doll.hit → step/sync), so corpse coherence reads the same.
  // Fresh contexts boot tutorial-first; kill → endRound → showHome ~1500ms
  // later, so the dump must land fast (same 400ms rule as round advance).
  await page.goto('/basic.html');
  await page.waitForLoadState('networkidle');
  await page.waitForSelector('.readyzone', { timeout: 8000 });
  const z = await page.locator('.readyzone').boundingBox();
  await page.mouse.move(z!.x + z!.width / 2, z!.y + z!.height / 2);
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('TAP'), { timeout: 8000 });
  for (let i = 0; i < 10; i++) { await page.keyboard.press('Space'); await page.waitForTimeout(100); }
  await page.waitForFunction(() => (document.querySelector('.cue')?.textContent ?? '').includes('DRAW'), { timeout: 15000 });
  // Fire the instant DRAW lands: the foe's first shot leaves ~700ms after
  // DRAW, so idling here donates free hits. (Hit logic is capsule-based —
  // no need to wait for the async GLB swap.)
  await page.waitForTimeout(300);
  type G = { __gamey: { aimAt(s: string, p?: string): { x: number; y: number } } };
  // Up to a full cylinder at center mass (body r=0.62 beats head r=0.34
  // under recoil bloom): 3 body hits kill via the same doll.hit ragdoll
  // path as a headshot. Break the moment either duelist drops.
  for (let i = 0; i < 6; i++) {
    const dead = await page.evaluate(() => parseFloat(((document.querySelector('.hp.foe i') as HTMLElement | null)?.style.width || '100')) <= 0);
    if (dead) break;
    const cue = await page.evaluate(() => document.querySelector('.cue')?.textContent ?? '');
    if (/DOWN|VICTORY|DEFEAT/.test(cue)) break;
    const p = await page.evaluate(() => (window as unknown as G).__gamey.aimAt('foe'));
    await page.mouse.move(p.x, p.y);
    await page.waitForTimeout(200);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(500); // beats the 380ms cooldown, minimal AI exposure
  }
  await page.waitForFunction(() => parseFloat(((document.querySelector('.hp.foe i') as HTMLElement | null)?.style.width || '100')) <= 0, { timeout: 15000 });
  // Dump fast: endRound routes to a fresh duel ~1500ms after resolve (plus
  // up to ~1s bullet-settle defer), which rebuilds the duelists — the probe
  // would then read the new STANDING foe instead of the corpse.
  type G2 = { __gamey: { parts(s: string): Record<string, [number, number, number] | null> } };
  const diag = await page.evaluate(() => ({
    parts: (window as unknown as G2).__gamey.parts('foe'),
    cue: document.querySelector('.cue')?.textContent ?? '<no cue>',
    canvas: !!document.querySelector('canvas'),
    foeBar: ((document.querySelector('.hp.foe i') as HTMLElement | null)?.style.width ?? '<no bar>'),
  }));
  console.log('FOE-PARTS-T0:', JSON.stringify(diag.parts));
  // Physics joint gaps while the sim is live. The round's cleanup() disposes
  // the ragdoll ~1.3-1.5s post-kill (constraints gone, visuals frozen), and
  // kill detection itself lags, so sample early: T0 and T0+400ms. The old
  // twist-reference tear showed up immediately (elbow 0.6-0.9 at T0).
  type G4 = { __gamey: { jointErrors(s: string): Record<string, number> | null } };
  const gapSamples: Array<Record<string, number>> = [];
  for (const wait of [0, 400]) {
    if (wait) await page.waitForTimeout(wait);
    const g = await page.evaluate(() => (window as unknown as G4).__gamey.jointErrors('foe'));
    if (g && Object.keys(g).length) gapSamples.push(g);
  }
  console.log('FOE-JOINT-GAPS:', JSON.stringify(gapSamples));
  // Settled read at +1000ms: the corpse needs ~600ms to hit the dirt.
  // Safe vs the 1500ms routeAfter rebuild (endRound runs ~0-50ms post-kill).
  await page.waitForTimeout(600);
  const diag2 = await page.evaluate(() => ({
    parts: (window as unknown as G2).__gamey.parts('foe'),
    cue: document.querySelector('.cue')?.textContent ?? '<no cue>',
  }));
  console.log('FOE-PARTS-T1000:', JSON.stringify(diag2.parts));
  type G3 = { __gamey: { bodies(s: string): Array<[number, number, number]> | null } };
  const sim = await page.evaluate(() => (window as unknown as G3).__gamey.bodies('foe'));
  console.log('FOE-BODIES-T1000:', JSON.stringify(sim));
  console.log('DIAG:', JSON.stringify({ cue: diag.cue, canvas: diag.canvas, foeBar: diag.foeBar }));
  const dump = diag2.parts;
  await page.screenshot({ path: 'test-results/fc-corpse.png' }); // before asserts: routeAfter rebuilds ~1500ms post-kill
  const pts = Object.values(dump).filter((v): v is [number, number, number] => v !== null);
  expect(pts.length).toBeGreaterThanOrEqual(5); // rig present, GLB swap didn't drop parts
  for (const [x, y, zc] of pts) {
    expect(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(zc)).toBe(true);
    expect(y).toBeGreaterThan(-0.5); // no ground sink
    expect(y).toBeLessThan(1.7); // fallen, not standing (standing head = 1.9)
  }
  // Corpse must LIE on the dirt: before the ownBox fix the pelvis box
  // swallowed the whole subtree and the settled pelvis hovered at y 0.7-1.0.
  const pelvisY = dump.pelvis?.[1];
  if (pelvisY != null) expect(pelvisY).toBeLessThan(0.6);
  // Joint integrity: limbs must stay attached. Rest shoulder->elbow is ~0.34m
  // and hip->knee ~0.3m. History: the world-vs-local pivot bug floated a
  // forearm 0.8-1.0m away; the stock cannon twist reference (RagdollJoint in
  // ragdoll.ts) tore the shoulder/elbow to 0.4-0.8 on most deaths. With both
  // fixed every joint holds within ~1cm (measured 0.33-0.36 / 0.29-0.31).
  const dist = (a?: [number, number, number] | null, b?: [number, number, number] | null) =>
    a && b ? Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) : 0;
  expect(dist(dump.upperArmR, dump.forearmR)).toBeLessThan(0.45);
  expect(dist(dump.thighL, dump.shinL)).toBeLessThan(0.45);
  expect(dist(dump.thighR, dump.shinR)).toBeLessThan(0.45);
  // Physics truth (not the synced visuals): every joint's pivot gap.
  expect(gapSamples.length, 'no live joint sample (ragdoll disposed too early?)').toBeGreaterThan(0);
  for (const s of gapSamples) for (const [k, g] of Object.entries(s)) expect(g, `joint ${k}`).toBeLessThan(0.1);
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), zs = pts.map((p) => p[2]);
  const spread = Math.max(...xs) - Math.min(...xs) + Math.max(...ys) - Math.min(...ys) + Math.max(...zs) - Math.min(...zs);
  expect(spread).toBeLessThan(6); // crumple stays within ~1m per axis, never starfish
});
