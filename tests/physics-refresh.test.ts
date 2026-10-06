// Refresh-rate independence of the physics (spec: consistent across 60/144/165Hz,
// delta-time not frame count). Pure Node, no WebGL: drives the REAL fixed
// stepper + ragdoll + projectile sim at many frame rates and checks that
//  (a) the same number of fixed steps run per second of sim time,
//  (b) rendered ragdoll positions agree across refresh rates,
//  (c) the render is smooth at high refresh (no stalled/duplicate frames),
//  (d) nothing explodes at low fps,
//  (e) bullets fly identically and never hop.
// Run: npx tsx tests/physics-refresh.test.ts   (npm run test:physics)
import * as THREE from "three";
import { createRagdoll, type RagdollParts } from "../src/render/ragdoll";
import { createFixedStepper, STEP } from "../src/game/fixedStep";
import { ProjectileSim } from "../src/game/projectiles";
import { TimingQte } from "../src/game/timingQte";
import { DuelMachine } from "../src/game/DuelMachine";
import { falloffRetention } from "../src/game/damage";

let failures = 0;
const ok = (cond: boolean, msg: string) => { if (!cond) { failures++; console.log(`  ✗ ${msg}`); } else console.log(`  ✓ ${msg}`); };

// ---- synthetic 10-part rig (same part keys the game uses) ----
function box(w: number, h: number, d: number): THREE.Mesh { return new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshBasicMaterial()); }
function buildRig() {
  const root = new THREE.Group();
  const at = (o: THREE.Object3D, x: number, y: number, z: number, parent: THREE.Object3D) => { o.position.set(x, y, z); parent.add(o); return o; };
  const pelvis = at(box(0.5, 0.35, 0.3), 0, 0.95, 0, root);
  const torso = at(box(0.55, 0.6, 0.32), 0, 0.45, 0, pelvis);
  const head = at(box(0.32, 0.34, 0.32), 0, 0.5, 0, torso);
  const upperArmL = at(box(0.15, 0.5, 0.15), -0.36, 0, 0, torso);
  const upperArmR = at(new THREE.Group(), 0.36, 0.2, 0, torso);
  upperArmR.add(box(0.15, 0.5, 0.15));
  const forearmR = at(new THREE.Group(), 0, -0.3, 0, upperArmR);
  forearmR.add(box(0.13, 0.3, 0.13));
  const thighL = at(box(0.2, 0.4, 0.2), -0.15, -0.4, 0, pelvis);
  const thighR = at(box(0.2, 0.4, 0.2), 0.15, -0.4, 0, pelvis);
  const shinL = at(box(0.16, 0.4, 0.16), 0, -0.4, 0, thighL);
  const shinR = at(box(0.16, 0.4, 0.16), 0, -0.4, 0, thighR);
  root.updateMatrixWorld(true);
  const parts = { pelvis, torso, head, upperArmL, upperArmR, thighL, thighR, shinL, shinR, forearmR } as unknown as RagdollParts;
  return { root, parts, pelvis, head, torso };
}

type Sample = { t: number; p: THREE.Vector3; h: THREE.Vector3; to: THREE.Vector3 };
function simulate(hz: number | "jitter", seconds = 2.0): { samples: Sample[]; steps: number; finite: boolean } {
  const { root, parts, pelvis, head, torso } = buildRig();
  const doll = createRagdoll(new THREE.Scene(), parts, "default");
  if (!doll) throw new Error("ragdoll failed to build");
  doll.hit(new THREE.Vector3(0.1, 1.5, 0), new THREE.Vector3(1, 0, 0), 9);
  const stepper = createFixedStepper();
  const d: any = doll; // new API (fixedStep/sync(alpha)) or old (step/sync) so the test can show the BEFORE failure
  let seed = 12345; const rnd = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296;
  const samples: Sample[] = [];
  let t = 0; let finite = true;
  while (t < seconds - 1e-9) {
    const dt = hz === "jitter" ? (1 / 60) * (0.7 + rnd() * 0.6) : 1 / hz;
    t += dt;
    let alpha = 0;
    if (typeof d.fixedStep === "function") {
      alpha = stepper.advance(dt, (h) => d.fixedStep(h));
      d.sync(alpha);
    } else {
      d.step(dt); d.sync(); // OLD: per-frame step + latest-state sync
    }
    root.updateMatrixWorld(true);
    const w = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
    const s = { t, p: w(pelvis), h: w(head), to: w(torso) };
    if (![s.p.x, s.p.y, s.p.z, s.h.y].every(Number.isFinite)) finite = false;
    samples.push(s);
  }
  return { samples, steps: stepper.steps, finite };
}

const at = (s: Sample[], T: number) => s.reduce((best, x) => (Math.abs(x.t - T) < Math.abs(best.t - T) ? x : best));

console.log("== ragdoll, 2.0s of sim time at several refresh rates ==");
const rates: Array<number | "jitter"> = [30, 60, 120, 144, 165, 240, "jitter"];
const runs = new Map<number | "jitter", ReturnType<typeof simulate>>();
for (const r of rates) runs.set(r, simulate(r));
const ref = runs.get(60)!;

// (a) steps per sim time (only meaningful for the new stepper; old code has none)
const hasNew = (() => { const { parts } = buildRig(); const dd: any = createRagdoll(new THREE.Scene(), parts, "default"); return typeof dd.fixedStep === "function"; })();
if (hasNew) {
  for (const r of rates) ok(Math.abs(runs.get(r)!.steps - 120) <= 1, `${r}Hz: ${runs.get(r)!.steps} fixed steps in 2.0s (expect 120 ±1)`);
} else console.log("  (old ragdoll API: no fixed stepper — step-count check skipped)");

// (d) stability
for (const r of rates) ok(runs.get(r)!.finite, `${r}Hz: all positions finite`);
ok(runs.get(30)!.samples.every((s) => s.p.y > -0.5 && s.p.y < 3), "30Hz: no explosion / ground sink");

// (b) agreement across refresh rates at exact common frame times (1.0s, 2.0s are integer frames for every rate)
for (const T of [1.0, 2.0]) {
  const a = at(ref.samples, T);
  for (const r of [30, 120, 144, 165, 240] as const) {
    const b = at(runs.get(r)!.samples, T);
    const dev = Math.max(a.p.distanceTo(b.p), a.h.distanceTo(b.h), a.to.distanceTo(b.to));
    ok(dev < 0.02, `t=${T}s: ${r}Hz vs 60Hz max part deviation ${(dev * 100).toFixed(2)}cm (< 2cm)`);
  }
}
{
  const a = at(ref.samples, 2.0), b = runs.get("jitter")!.samples[runs.get("jitter")!.samples.length - 1];
  const dev = Math.max(a.p.distanceTo(b.p), a.h.distanceTo(b.h));
  ok(dev < 0.03, `jittered 60Hz final pose vs 60Hz: ${(dev * 100).toFixed(2)}cm (< 3cm)`);
}

// (c) smoothness: while the corpse is moving, consecutive rendered frames must not stall
// (duplicate pose) and the step size must stay even. Mean-based (a stalled run has median ~0).
console.log("== smoothness (pelvis+head displacement per rendered frame, t in [0.1,0.6]s) ==");
for (const r of [60, 120, 144, 165, 240] as const) {
  const s = runs.get(r)!.samples.filter((x) => x.t >= 0.1 && x.t <= 0.6);
  const d = s.slice(1).map((x, i) => x.p.distanceTo(s[i].p) + x.h.distanceTo(s[i].h));
  const mean = d.reduce((a, c) => a + c, 0) / d.length;
  const stalled = d.filter((v) => v < 0.05 * mean).length / d.length;
  const spread = Math.max(...d) / Math.max(mean, 1e-9);
  ok(stalled < 0.05, `${r}Hz: stalled (duplicate-pose) frames ${(stalled * 100).toFixed(0)}% (< 5%)`);
  ok(spread < 3, `${r}Hz: max/mean per-frame step ${spread.toFixed(2)} (< 3)`);
}

// (e) bullets: same flight at every rate, rendered position never hops.
// Reference = positions after n whole fixed steps (what the 60Hz sim produces);
// the interpolated render at frame time t must equal that curve at (t - STEP).
console.log("== bullets ==");
{
  const SUB = 8;
  const mk = () => {
    const sim = new ProjectileSim();
    const b = sim.fire({ from: { x: 0, y: 1.4, z: 0 }, dir: { x: 1, y: 0, z: 0 }, distM: 20, shooter: "player", gunId: "default", lethal: false })!;
    return { sim, b };
  };
  const X: number[] = [];
  { const { sim, b } = mk(); X.push(b.pos[0]); for (let n = 0; n < 30; n++) { for (let i = 0; i < SUB; i++) sim.step(STEP / SUB); X.push(b.pos[0]); } }
  const curve = (tau: number) => { const n = Math.floor(tau / STEP + 1e-9); const f = tau / STEP - n; return X[n] + (X[n + 1] - X[n]) * f; };
  for (const hz of [60, 120, 144, 165, 240]) {
    const { sim, b } = mk();
    const st = createFixedStepper();
    let prev = b.pos[0], cur = b.pos[0];
    let t = 0, maxErr = 0, minStep = Infinity, maxStep = 0, last: number | null = null;
    while (t < 0.2) {
      const dt = 1 / hz; t += dt;
      const alpha = st.advance(dt, () => { prev = b.pos[0]; for (let i = 0; i < SUB; i++) sim.step(STEP / SUB); cur = b.pos[0]; });
      const x = prev + (cur - prev) * alpha;
      if (t > 3 * STEP) {
        maxErr = Math.max(maxErr, Math.abs(x - curve(t - STEP)));
        if (last !== null) { minStep = Math.min(minStep, x - last); maxStep = Math.max(maxStep, x - last); }
      }
      last = x;
    }
    ok(maxErr < 0.01, `${hz}Hz: rendered bullet matches the fixed-step curve (max err ${(maxErr * 100).toFixed(2)}cm < 1cm)`);
    ok(minStep > 0 && maxStep / minStep < 1.15, `${hz}Hz: per-frame bullet step even (max/min ${(maxStep / minStep).toFixed(2)}), no hops/stalls`);
  }
}

console.log("== focus QTE needle ==");
{
  // The needle advances only on the fixed clock and renders at peek(alpha *
  // STEP), so at wall time t it must sit exactly on the ping-pong curve of t
  // at every refresh rate (what you see = what gets judged).
  const T = new TimingQte(42).traverseSec;
  const curve = (t: number) => { const x = (t / T) % 2; return x <= 1 ? x : 2 - x; };
  for (const hz of [30, 60, 144, 165, 240]) {
    const q = new TimingQte(42);
    const st = createFixedStepper();
    let t = 0, maxErr = 0;
    while (t < 2.0 - 1e-9) {
      t += 1 / hz;
      const alpha = st.advance(1 / hz, () => q.advance(STEP));
      maxErr = Math.max(maxErr, Math.abs(q.peek(alpha * STEP) - curve(t)));
    }
    ok(maxErr < 1e-6, `${hz}Hz: rendered needle on the fixed-clock curve (max err ${maxErr.toExponential(1)})`);
  }
}

console.log("== crosshair shot kick + hit rubber band ==");
{
  // User 2026-10-05: a shot kicks the crosshair x1.5, which returns to the
  // pre-shot size faster and faster (0.6s); a hit mid-return rubber-bands it
  // out past the post-hit size (overshoot) and the return starts over. All
  // on the fixed clock: identical at any refresh rate.
  const mk = () => new DuelMachine({ seed: 7, bloomStartDeg: 2.4, bloomMinDeg: 0.12, focusPerTapDeg: 0.3, duelDistM: 12 });
  const BASE = 1.2;
  const run = (hz: number, flinchAtTick: number | null) => {
    const m = mk();
    m.bloomDeg = BASE;
    m.phase = "fire";
    m.applyShotKick();
    const kicked = m.bloomDeg;
    const st = createFixedStepper();
    let t = 0, tick = 0, peak = 0;
    const byTick: number[] = [];
    while (t < 2.0 - 1e-9) {
      t += 1 / hz;
      st.advance(1 / hz, () => {
        tick++;
        if (flinchAtTick !== null && tick === flinchAtTick) m.applyFlinch(0, 1.1);
        m.recoverKick(STEP);
        byTick.push(m.bloomDeg);
        if (flinchAtTick !== null && tick > flinchAtTick) peak = Math.max(peak, m.bloomDeg);
      });
    }
    return { kicked, byTick, peak };
  };
  const ref = run(60, null);
  ok(Math.abs(ref.kicked - BASE * 1.5) < 1e-9, `shot kicks x1.5 (${BASE} -> ${ref.kicked.toFixed(3)} deg)`);
  {
    const m = mk(); m.bloomDeg = 3.9; m.phase = "fire"; m.applyShotKick();
    ok(Math.abs(m.bloomDeg - 3.9 * 1.5) < 1e-9, `full x1.5 even at bloomMax (3.9 -> ${m.bloomDeg.toFixed(3)})`);
    m.applyShotKick();
    ok(m.bloomDeg <= 3.9 * 1.5 + 1e-9, `stacked spam stays bounded (${m.bloomDeg.toFixed(3)} <= ${(3.9 * 1.5).toFixed(3)})`);
  }
  const ex = (i: number) => ref.byTick[i - 1] - BASE;
  const k0 = ref.kicked - BASE;
  ok(Math.abs(ex(18) - k0 * 0.75) < 1e-9 && ex(18) > k0 * 0.5, `ease-in: only 25% of the kick gone at 0.3s (${(1 - ex(18) / k0).toFixed(2)}), the rest in the second half`);
  ok(Math.abs(ref.byTick[35] - BASE) < 1e-12, `back on the pre-shot size at 0.6s (${ref.byTick[35].toFixed(4)})`);
  const hit = run(60, 18);
  const target = Math.min((2.4 + 1.5) * 1.5, BASE + k0 * 0.75 + 1.1);
  ok(hit.peak > target * 1.03, `hit mid-return rubber-bands past the post-hit size (peak ${hit.peak.toFixed(3)} > ${target.toFixed(3)})`);
  ok(Math.abs(hit.byTick[hit.byTick.length - 1] - BASE) < 1e-9, `then returns to the pre-shot size (${hit.byTick[hit.byTick.length - 1].toFixed(4)})`);
  for (const hz of [30, 144, 165, 240]) {
    const r = run(hz, 18);
    const n = Math.min(r.byTick.length, hit.byTick.length);
    let d = 0;
    for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(r.byTick[i] - hit.byTick[i]));
    ok(d === 0, `${hz}Hz: kick + rubber band bit-identical per tick to 60Hz`);
  }
}

console.log("== focus QTE multipliers ==");
{
  // User 2026-10-06: good x0.5, perfect x0.25, any miss x1.3 (bloomMin..bloomMax).
  const mk = () => {
    const m = new DuelMachine({ seed: 7, bloomStartDeg: 2.4, bloomMinDeg: 0.12, focusPerTapDeg: 0.3, duelDistM: 12 });
    m.startFocus();
    return m;
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
  let m = mk();
  m.addQte("good");
  ok(near(m.bloomDeg, 1.2), `good halves 2.4 -> ${m.bloomDeg.toFixed(3)}`);
  m.addQte("perfect");
  ok(near(m.bloomDeg, 0.3), `perfect quarters 1.2 -> ${m.bloomDeg.toFixed(3)}`);
  m.addQte("miss");
  ok(near(m.bloomDeg, 0.39), `miss x1.3 0.3 -> ${m.bloomDeg.toFixed(3)}`);
  m.addQte("perfect");
  m.addQte("perfect");
  ok(near(m.bloomDeg, 0.12), `floored at bloomMin -> ${m.bloomDeg.toFixed(3)}`);
  m = mk();
  m.addMiss();
  ok(near(m.bloomDeg, 3.12), `click miss x1.3 too: 2.4 -> ${m.bloomDeg.toFixed(3)}`);
  m = new DuelMachine({ seed: 7, bloomStartDeg: 2.4, bloomMinDeg: 0.12, bloomMaxDeg: 3.0, focusPerTapDeg: 0.3, duelDistM: 12 });
  m.startFocus();
  m.addMiss();
  ok(near(m.bloomDeg, 3.0), `capped at bloomMax (game max 3.0) -> ${m.bloomDeg.toFixed(3)}`);
}

console.log("== damage falloff (6-25m) ==");
{
  const want: Array<[number, number]> = [[6, 1], [9, 1], [11, 0.92], [14, 0.7], [15, 0.7 - 0.22 / 3], [17, 0.55], [25, 0.55]];
  for (const [d, r] of want) ok(Math.abs(falloffRetention(d) - r) < 1e-9, `${d}m -> ${falloffRetention(d).toFixed(3)} (want ${r.toFixed(3)})`);
}

console.log(failures === 0 ? "\nPHYSICS REFRESH-RATE CHECK: PASS" : `\nPHYSICS REFRESH-RATE CHECK: ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
