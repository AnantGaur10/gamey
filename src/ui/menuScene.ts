import * as THREE from "three";
import { createArena, stagePositions, faceToward, createShadowDecal } from "../render/arena";
import { createCowboy, paintGun, type Cowboy } from "../render/cowboy";
import { loadCowboyGlb, type CowboyGlb } from "../render/cowboyGlb";
import { loadStreetGlb } from "../render/streetGlb";
import { loadMapSet } from "../render/setGlb";
import { MAPS, MAP_IDS, type MapChoice, type MapId } from "../render/maps";
import { FOE_LOOKS, type FoeLookId } from "../render/foes";
import { createGunsmoke } from "../render/smoke";
import { createAmbient } from "../render/ambient";
import { createSway, type Sway } from "../render/sway";
import { createRagdoll, bindAccessories, type Ragdoll } from "../render/ragdoll";
import { createFixedStepper, STEP } from "../game/fixedStep";
import { quickDraw, gunOut, QD_END, type ArmPose } from "../render/quickDraw";

// Live menu backdrop (user 2026-10-14: "the background is not static and
// moving (has animations or gameplay)"). A looping showdown on the chosen
// map (Random = a new map per loop): the hero (holding the equipped gun's
// finish) stands off against a foe outfit, both quick-draw, the hero fires
// first and the foe drops in the game's ragdoll, then a fade to the next
// standoff (noon / dusk alternate). Never night: the foe would vanish.
//
// Lives in its own fixed layer (#menu-bg) behind #app, so the home, shop and
// map screens (which clear #app) keep it running; runDuel hides it before it
// builds its own arena (one GL context at a time). Purely cosmetic and
// muted. The ragdoll and hat sway step on the shared fixed clock like the
// duel. On any failure (no WebGL, no GLBs) the CSS sky stays as before.

const DIST = 8;
const FOES: FoeLookId[] = ["outlaw", "bandido", "ghost", "dandy"];
/** Seconds of standoff before the draw (first loop shorter). */
const STANDOFF = [3.2, 5.2];
const FADE_S = 0.8;

interface SetView {
  group: THREE.Object3D;
  tick(tSec: number): void;
  look(stage: number): void;
  dispose(): void;
}

interface MenuScene {
  setMap(choice: MapChoice): void;
  setGun(gunId: string): void;
  dispose(): void;
}

let live: MenuScene | null = null;

/** Start (or retarget) the menu backdrop. Idempotent across menu screens. */
export function showMenuScene(choice: MapChoice, gunId: string): void {
  if (live) {
    live.setMap(choice);
    live.setGun(gunId);
    return;
  }
  try {
    live = createMenuScene(choice, gunId);
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[gamey] menu backdrop failed", err);
    live = null;
    document.getElementById("menu-bg")?.replaceChildren();
  }
}

/** Tear the backdrop down (frees its GL context): a duel is starting. */
export function hideMenuScene(): void {
  live?.dispose();
  live = null;
}

function hostEl(): HTMLElement {
  let h = document.getElementById("menu-bg");
  if (!h) {
    h = document.createElement("div");
    h.id = "menu-bg";
    document.body.insertBefore(h, document.body.firstChild);
  }
  return h;
}

const ease = (u: number) => u * u * (3 - 2 * u);

function disposeCowboy(c: Cowboy | null, scene: THREE.Scene): void {
  if (!c) return;
  scene.remove(c.group);
  // Geometry is per load; the flat cowboy material is shared (never disposed).
  c.group.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
}

function createMenuScene(initialChoice: MapChoice, initialGun: string): MenuScene {
  const host = hostEl();
  host.replaceChildren();
  host.classList.add("loading");
  const arena = createArena(DIST);
  const { scene, camera, renderer } = arena;
  host.appendChild(renderer.domElement);
  const fade = document.createElement("div");
  fade.className = "mfade";
  host.appendChild(fade);
  arena.fitCamera();

  const base = import.meta.env.BASE_URL;
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const still = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  const { player: pPos, foe: fPos } = stagePositions(DIST);
  const fwd = fPos.clone().sub(pPos).setY(0).normalize();
  const yaw = Math.atan2(fwd.x, fwd.z);
  const side = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw)); // same gun-side axis as the arena camera

  const gunsmoke = createGunsmoke(scene);
  const ambient = createAmbient(scene, DIST);
  const heroShadow = createShadowDecal(scene);
  const foeShadow = createShadowDecal(scene);
  const stepper = createFixedStepper();

  // Map sets stay loaded for the backdrop's life (switching maps between
  // loops is a visibility flip). setGlb caches parsed GLBs per session too.
  const sets = new Map<MapId, Promise<SetView | null>>();
  function loadSet(id: MapId): Promise<SetView | null> {
    let p = sets.get(id);
    if (p) return p;
    const def = MAPS[id];
    p = def.glb === null
      ? loadStreetGlb(`${base}models/street.glb`, DIST).then((s) => s && {
        group: s.group,
        tick: s.tick,
        look: (k: number) => s.setGlow([0, 0.55, 1][k]),
        dispose: () => s.group.removeFromParent(),
      })
      : loadMapSet(`${base}models/${def.glb}`, DIST, def.paintGain).then((s) => s && {
        group: s.group,
        tick: s.tick,
        look: (k: number) => {
          s.setHell(false);
          s.setGlow(def.glow[k]);
          s.setWindow(def.window[k]);
          s.setShaft(def.shaft[k]);
          s.setNightVis(null);
        },
        dispose: s.dispose,
      });
    p = p.then((v) => {
      if (v) {
        v.group.visible = false;
        scene.add(v.group);
      }
      return v;
    });
    sets.set(id, p);
    return p;
  }
  let shownSet: SetView | null = null;

  let choice = initialChoice;
  let gunId = initialGun;
  const order = [...MAP_IDS].sort(() => Math.random() - 0.5);
  let mapId: MapId = choice === "random" ? order[0] : choice;
  let loop = 0;
  let foeIdx = Math.floor(Math.random() * FOES.length);

  let hero: Cowboy | null = null;
  let foe: Cowboy | null = null;
  let heroSway: Sway | null = null;
  let foeSway: Sway | null = null;
  let foeDoll: Ragdoll | null = null;

  type Phase = "build" | "standoff" | "draw" | "after";
  let phase: Phase = "build";
  let alive = true;
  let tPhase = 0; // seconds in the current phase
  let tShot = 0; // seconds since the standoff began (camera push)
  let standoffS = STANDOFF[0];
  let drawT = 0;
  let heroFired = false;
  let foeFired = false;
  let killT = -1;
  let fadingOut = false;
  let kick = 0;
  let punch = -1;
  let wantMap: MapId | null = null; // a map picked mid-loop: cut to it
  const from = { hero: { s: 0.55, z: 0, e: -0.25 } as ArmPose, foe: { s: 0.55, z: 0, e: -0.25 } as ArmPose };

  // Tracer streaks (head + 0.7m tail) for the two shots.
  const tracerGeo = new THREE.BoxGeometry(0.035, 0.035, 0.7);
  tracerGeo.translate(0, 0, -0.35);
  const tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, fog: false, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  const tracers = [0, 1].map(() => {
    const mesh = new THREE.Mesh(tracerGeo, tracerMat);
    mesh.visible = false;
    scene.add(mesh);
    return { mesh, a: new THREE.Vector3(), b: new THREE.Vector3(), t: 0, dur: 0 };
  });
  function shoot(i: number, a: THREE.Vector3, b: THREE.Vector3): void {
    const tr = tracers[i];
    tr.a.copy(a);
    tr.b.copy(b);
    tr.t = 0;
    tr.dur = a.distanceTo(b) / 220; // ~bullet speed, a few frames
    tr.mesh.visible = true;
  }

  async function buildShot(): Promise<void> {
    if (wantMap) {
      mapId = wantMap;
      wantMap = null;
    } else if (loop > 0) {
      mapId = choice === "random" ? order[loop % order.length] : choice;
    }
    const def = MAPS[mapId];
    const stage = loop % 2 === 0 ? 1 : 0; // dusk first, then noon, ...
    foeIdx = (foeIdx + 1) % FOES.length;
    const look = FOE_LOOKS[FOES[foeIdx]];
    const gid = gunId;
    const [set, heroGlb, foeGlb] = await Promise.all([
      loadSet(mapId),
      loadCowboyGlb(`${base}models/cowboy_hero.glb`, "H"),
      loadCowboyGlb(`${base}models/${look.glb}`, "O"),
    ]);
    if (!alive) return;

    // Set + light for this loop.
    if (shownSet) shownSet.group.visible = false;
    shownSet = set;
    if (set) set.group.visible = true;
    for (const n of ["ProceduralStreet", "ProceduralDressing"]) {
      const o = scene.getObjectByName(n);
      if (o) o.visible = mapId === "street" && !set;
    }
    arena.setFloor(def.floor);
    arena.setTimeOfDay(def.tod(stage, false));
    // Dusk haze is a duel difficulty, not a look: keep the backdrop clear.
    const fog = scene.fog as THREE.FogExp2;
    fog.density = Math.min(fog.density, 0.02);
    set?.look(stage);
    ambient.setTimeOfDay(Math.min(stage, def.ambientMaxStage), false);
    gunsmoke.setAmbient([1, 0.8][stage]);
    for (const d of [heroShadow, foeShadow]) d.setStrength([0.62, 0.66][stage] * def.shadow);

    // Fresh duelists every loop (the foe's corpse is ragdoll-posed).
    try { foeDoll?.dispose(); } catch { /* noop */ }
    foeDoll = null;
    disposeCowboy(hero, scene);
    disposeCowboy(foe, scene);
    hero = heroGlb ?? createCowboy({ coat: 0x4a6fa5, hat: 0x3a2a1a, skin: 0xd9a066, facing: 1 });
    foe = foeGlb ?? createCowboy({ ...look.fallback, facing: -1 });
    hero.group.position.copy(pPos);
    faceToward(hero.group, pPos, fPos);
    foe.group.position.copy(fPos);
    faceToward(foe.group, fPos, pPos);
    paintGun(hero.gun, gid);
    hero.holster?.();
    foe.holster?.();
    scene.add(hero.group, foe.group);
    heroSway = heroGlb ? createSway(heroGlb.sway) : null;
    foeSway = foeGlb ? createSway(foeGlb.sway) : null;
    try {
      bindAccessories(foe.group, foe.parts);
      foeDoll = createRagdoll(scene, foe.parts, "default");
    } catch { foeDoll = null; }

    standoffS = STANDOFF[0] + (loop === 0 ? 0 : (STANDOFF[1] - STANDOFF[0]) * Math.random());
    heroFired = foeFired = fadingOut = false;
    killT = -1;
    kick = 0;
    punch = -1;
    camera.zoom = 1;
    camera.updateProjectionMatrix();
    loop++;
    host.classList.remove("loading");
    fade.classList.remove("on");
    phase = "standoff";
    tPhase = 0;
    tShot = 0;
  }

  function startBuild(): void {
    phase = "build";
    void buildShot().catch((err) => {
      if (import.meta.env.DEV) console.warn("[gamey] menu backdrop shot failed", err);
    });
  }

  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  const _feet = new THREE.Vector3();
  function heroFire(): void {
    if (!hero || !foe) return;
    heroFired = true;
    hero.gunTip.getWorldPosition(_a);
    _b.copy(fPos).setY(1.3);
    gunsmoke.spawn(_a, false);
    shoot(0, _a, _b);
    kick = 1;
    punch = 0;
  }
  function foeHit(): void {
    if (!foe || killT >= 0) return;
    killT = 0;
    const dir = fPos.clone().sub(pPos).setY(0).normalize();
    const point = fPos.clone().setY(1.3);
    gunsmoke.dust(point, dir, "body");
    let ragdolled = false;
    try {
      if (foeDoll) { foeDoll.hit(point, dir, 49 / 6); ragdolled = true; }
    } catch { /* authored fall below */ }
    const g = foe as CowboyGlb;
    try { g.stopClips?.(); } catch { /* noop */ }
    if (!ragdolled) {
      if (g.hasClip?.("fall_back")) g.playClip("fall_back");
      else foe.setFall(true);
    }
  }
  function foeFire(): void {
    if (!foe) return;
    foeFired = true;
    foe.gunTip.getWorldPosition(_a);
    // A dying shot that goes wide past the hero's gun shoulder.
    _b.copy(pPos).addScaledVector(side, -1.6).setY(1.9).addScaledVector(fwd, -3);
    gunsmoke.spawn(_a, false);
    shoot(1, _a, _b);
  }

  function poseDraw(c: Cowboy, f: ArmPose): void {
    const q = quickDraw(drawT, f);
    c.armR.rotation.x = q.s;
    c.armR.rotation.z = q.z;
    c.elbowR.rotation.x = q.e;
    c.drawStep?.(gunOut(drawT));
  }

  function update(dt: number, now: number): void {
    tPhase += dt;
    tShot += dt;
    if (phase === "standoff" && tPhase >= standoffS && hero && foe) {
      // Same hand-off as the duel: read the hand-on-grip pose, stop the
      // idle clips, then the quick-draw owns both gun arms.
      from.hero = { s: hero.armR.rotation.x, z: hero.armR.rotation.z, e: hero.elbowR.rotation.x };
      from.foe = { s: foe.armR.rotation.x, z: foe.armR.rotation.z, e: foe.elbowR.rotation.x };
      try { (hero as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      try { (foe as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      phase = "draw";
      tPhase = 0;
      drawT = 0;
    }
    if (phase === "draw" && hero && foe) {
      drawT += dt;
      poseDraw(hero, from.hero);
      if (killT < 0) poseDraw(foe, from.foe);
      if (!heroFired && drawT >= QD_END + 0.04) heroFire();
      if (heroFired && killT < 0 && drawT >= QD_END + 0.1) foeHit();
      if (!foeFired && drawT >= QD_END + 0.14) foeFire();
      if (killT >= 0 && foeFired) {
        phase = "after";
        tPhase = 0;
      }
    }
    if (killT >= 0) killT += dt;
    if (phase === "after" && hero) {
      if (kick > 0) {
        kick = Math.max(0, kick - dt * 3);
        hero.armR.rotation.x = 0.05 - 0.22 * kick * kick; // recoil lifts the muzzle, then settles
      }
      if (tPhase >= 1.2) {
        // It's over: the gun comes down to the standoff pose (muzzle to the dirt).
        const k = 1 - Math.exp(-dt * 2.5);
        hero.armR.rotation.x += (0.55 - hero.armR.rotation.x) * k;
        hero.armR.rotation.z += (0 - hero.armR.rotation.z) * k;
        hero.elbowR.rotation.x += (-0.25 - hero.elbowR.rotation.x) * k;
      }
      if (!fadingOut && tPhase >= 3.4) {
        fadingOut = true;
        fade.classList.add("on");
      }
      if (fadingOut && tPhase >= 3.4 + FADE_S) startBuild();
    }
    if (wantMap && phase === "standoff" && !fadingOut) {
      // A new map picked while a standoff runs: fade straight to it.
      fadingOut = true;
      fade.classList.add("on");
      phase = "after";
      tPhase = 3.4;
    }

    // Tracers fly muzzle -> target.
    for (const tr of tracers) {
      if (!tr.mesh.visible) continue;
      tr.t += dt;
      const u = Math.min(1, tr.t / Math.max(tr.dur, 1e-3));
      tr.mesh.position.lerpVectors(tr.a, tr.b, u);
      tr.mesh.lookAt(tr.b);
      if (u >= 1) tr.mesh.visible = false;
    }

    // Camera: over the gun shoulder like the duel, set further back and
    // turned so the standoff sits right of centre (menu on the left). Slow
    // push-in + drift; a small punch on the shot.
    const push = still ? 0.5 : ease(Math.min(1, tShot / 9));
    const drift = still ? 0 : 1;
    const back = 6.4 - 0.7 * push;
    const lat = -2.4 + 0.15 * drift * Math.sin(now * 0.31);
    const up = 1.8 + 0.06 * drift * Math.sin(now * 0.23 + 1);
    camera.position.copy(pPos).addScaledVector(fwd, -back).addScaledVector(side, lat);
    camera.position.y += up;
    _feet.copy(pPos).addScaledVector(fwd, DIST).addScaledVector(side, 4.6 + 0.12 * drift * Math.sin(now * 0.27));
    _feet.y += 1.0;
    camera.lookAt(_feet);
    if (punch >= 0 && punch < 1.2) {
      punch += dt;
      const u = Math.min(1, punch / 0.45);
      camera.zoom = 1 + (still ? 0 : 0.05) * (1 - (1 - u) ** 3);
      camera.updateProjectionMatrix();
    }
  }

  let raf = 0;
  let last = performance.now();
  function frame(): void {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const now = performance.now();
    const rawDt = (now - last) / 1000;
    if (coarse && rawDt < 1 / 32) return; // ~30fps on touch devices: battery
    last = now;
    const dt = Math.min(rawDt, 0.1);
    arena.noteFrame(rawDt);
    const nowSec = now / 1000;
    if (phase !== "build") update(dt, nowSec);
    heroSway?.sense(dt);
    foeSway?.sense(dt);
    const alpha = stepper.advance(dt, () => {
      try { if (foeDoll?.fallen) foeDoll.fixedStep(STEP); } catch { /* noop */ }
      heroSway?.fixedStep(STEP);
      foeSway?.fixedStep(STEP);
    });
    (hero as CowboyGlb | null)?.update?.(dt);
    (foe as CowboyGlb | null)?.update?.(dt);
    try {
      if (foeDoll && !foeDoll.fallen) foeDoll.follow();
      else if (foeDoll?.fallen) foeDoll.sync(alpha);
    } catch { /* noop */ }
    if (hero) heroShadow.place((hero.parts.pelvis ?? hero.group).getWorldPosition(_feet), 1.9, false);
    if (foe) foeShadow.place((foe.parts.pelvis ?? foe.group).getWorldPosition(_feet), 1.9, killT > 0.5);
    gunsmoke.update(dt);
    shownSet?.tick(nowSec);
    ambient.tick(nowSec, renderer.getPixelRatio());
    heroSway?.render(alpha);
    foeSway?.render(alpha);
    arena.render();
  }

  const onResize = () => arena.fitCamera();
  window.addEventListener("resize", onResize);
  window.visualViewport?.addEventListener("resize", onResize);

  if (import.meta.env.DEV) {
    (window as unknown as { __menu?: unknown }).__menu = {
      state: () => ({ phase, loop, map: mapId, tPhase, killT }),
    };
  }

  startBuild();
  raf = requestAnimationFrame(frame);

  return {
    setMap(c) {
      if (c === choice) return;
      choice = c;
      if (c !== "random" && c !== mapId) wantMap = c;
    },
    setGun(id) {
      gunId = id; // the next loop's hero carries it
    },
    dispose() {
      alive = false;
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onResize);
      window.visualViewport?.removeEventListener("resize", onResize);
      try { foeDoll?.dispose(); } catch { /* noop */ }
      for (const p of sets.values()) void p.then((v) => { try { v?.dispose(); } catch { /* noop */ } });
      ambient.dispose();
      heroShadow.dispose();
      foeShadow.dispose();
      tracerGeo.dispose();
      tracerMat.dispose();
      arena.disposePost();
      renderer.dispose();
      renderer.forceContextLoss(); // one GL context at a time (the duel builds its own)
      host.replaceChildren();
      host.classList.remove("loading");
      if (import.meta.env.DEV) delete (window as unknown as { __menu?: unknown }).__menu;
    },
  };
}
