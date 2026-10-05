import * as THREE from "three";
import { createArena, stagePositions, faceToward, timeOfDayForRound, cssSkyForRound } from "../render/arena";
import { createCowboy, type Cowboy } from "../render/cowboy";
import { loadCowboyGlb, swapCowboy, type CowboyGlb } from "../render/cowboyGlb";
import { loadStreetGlb, type StreetSet } from "../render/streetGlb";
import { createGunsmoke } from "../render/smoke";
import { createFixedStepper, STEP, MAX_FRAME_DT } from "../game/fixedStep";
import { createRagdoll, bindAccessories, type Ragdoll } from "../render/ragdoll";
import { DuelMachine, type WoundPose } from "../game/DuelMachine";
import { bodyDamage, BASE_HP, LIFESTEAL_CAP_PER_HIT } from "../game/damage";
import { GUNS, AI_ROSTER, GOLD_WIN_BESTOF, GOLD_WIN_DEATHMATCH, GOLD_LOSS_CONSOLATION, GOLD_KILL_BONUS, reviveDeathPrice } from "../game/economy";
import { ProjectileSim, testCapsuleHit, CAPSULE_FOR_POSE, capsuleMid, type BulletState } from "../game/projectiles";
import { LocalTransport } from "../game/Transport";
import type { PortalAdapter } from "../portal/PortalAdapter";
import { mountFocusUI, isCoarsePointer, type FocusUI } from "./focus";
import { TimingQte } from "../game/timingQte";
import { storagePersisted } from "../store/SafeStore";
import { createAudioManager, type AudioManager } from "../audio/AudioManager";

export type Mode = "standard" | "deathmatch" | "tutorial";

const SHOTS_PER_DUEL = 6;
const BEST_OF = 3; // first to 2
const FIRST_TO = Math.ceil(BEST_OF / 2);

// Shop prices (proposed v1 — user approval needed before locking as final).
export const SHOP_PRICES = { lifesteal: 100, gold: 120, revive: 50 };

function el(html: string): HTMLElement {
  const d = document.createElement("div");
  d.innerHTML = html;
  return d.firstElementChild as HTMLElement;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function gauss(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function boot(root: HTMLElement, adapter: PortalAdapter): void {
  adapter.loadingStart();
  document.body.classList.remove("in-duel");
  root.innerHTML = "";
  const progress = adapter.loadProgress();
  const audio = createAudioManager();

  // iOS audio context resume on user gesture (per CrazyGames specs)
  document.addEventListener("touchend", () => audio.resumeAudioContext());

  // Restore mute state from progress
  if (progress.settings.mute) {
    audio.toggleMute();
  }

  adapter.loadingStop();

  // Tutorial-first for new players. Skippable, in-gameplay.
  const isNew =
    progress.gold === 0 &&
    progress.bestStreak === 0 &&
    progress.bestBestOf === 0 &&
    progress.reviveToken === 0 &&
    progress.gunsOwned.length <= 1;
  if (isNew) {
    runDuel(root, adapter, "tutorial", audio);
  } else {
    showHome(root, adapter, audio);
  }
}

export function showHome(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  audio.playMusic('home-screen');
  root.innerHTML = "";
  const menu = el(`<div class="menu">
    <h1>HIGH NOON DUEL</h1>
    <button class="primary" data-m="standard">STANDARD — BEST OF ${BEST_OF}</button>
    <button data-m="deathmatch">DEATHMATCH — STREAK</button>
    <button data-m="shop">SHOP</button>
    <div class="note">Holster first, then hit Space/Enter (PC) or tap (touch) when the moving line is in the gold, as many times as you can, to shrink bloom. Leaving the holster restarts the countdown. DRAW! → aim → fire. Headshot kills instantly.</div>
  </div>`);
  
  // Mute button (top-right)
  const muteBtn = document.createElement("button");
  muteBtn.className = "mute-btn";
  muteBtn.title = "Toggle audio";
  muteBtn.textContent = audio.isMuted() ? "🔇" : "🔊";
  muteBtn.addEventListener("click", () => {
    const progress = adapter.loadProgress();
    progress.settings.mute = audio.toggleMute();
    adapter.saveProgress(progress);
    muteBtn.textContent = audio.isMuted() ? "🔇" : "🔊";
  });
  root.appendChild(muteBtn);
  
  root.appendChild(menu);
  menu.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      const m = (b as HTMLElement).dataset.m as Mode | "shop";
      if (m === "shop") showShop(root, adapter, audio);
      else if (m === "standard") runSeries(root, adapter, m, audio);
      else if (m === "deathmatch") runDeathmatch(root, adapter, audio);
      else runDuel(root, adapter, m, audio);
    });
  });
}

function showShop(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  root.innerHTML = "";
  const p = adapter.loadProgress();
  const can = (price: number) => p.gold >= price;
  const shop = el(`<div class="shop">
    <h2>ARMORY</h2>
    <div>Gold: <b>${p.gold}</b> · Revive token: <b>${p.reviveToken}</b></div>
    <div>Guns owned: ${p.gunsOwned.join(", ")} · Equipped: ${p.equippedGun}</div>
    <div class="note">${storagePersisted() ? "" : "Won't save in private mode (inline note, never a popup)."}</div>
    <div class="srow"><button data-b="buy-life">LIFESTEAL GUN — ${SHOP_PRICES.lifesteal}g (heal 20% of dealt, cap 15/hit, weaker 38dmg)</button></div>
    <div class="srow"><button data-b="buy-gold">GOLD GUN — ${SHOP_PRICES.gold}g (+40% gold, weaker 37dmg)</button></div>
    <div class="srow"><button data-b="buy-revive">REVIVE TOKEN — ${SHOP_PRICES.revive}g (max 1 held, once per game)</button></div>
    <div class="srow"><button data-b="equip-default">EQUIP DEFAULT</button> <button data-b="equip-life">EQUIP LIFESTEAL</button> <button data-b="equip-gold">EQUIP GOLD</button></div>
    ${adapter.kind === "full" ? `<div class="srow"><button data-b="ad-gold">WATCH AD FOR +10g (Full only)</button></div>` : ``}
    <div class="smsg"></div>
    <div class="srow"><button data-b="tutorial">REPLAY TUTORIAL</button></div>
    <button data-b="back">BACK</button>
  </div>`);
  root.appendChild(shop);
  const msg = shop.querySelector(".smsg") as HTMLElement;
  const refresh = () => showShop(root, adapter, audio);
  const buy = (id: "lifesteal" | "gold", price: number) => {
    const q = adapter.loadProgress();
    if (q.gunsOwned.includes(id)) { msg.textContent = "Already owned — equip it."; return; }
    if (!can(price)) { msg.textContent = "Not enough gold — win duels first (never gated, starter is competitive)."; return; }
    q.gold -= price;
    q.gunsOwned.push(id);
    adapter.saveProgress(q);
    refresh();
  };
  shop.querySelector("[data-b=buy-life]")!.addEventListener("click", () => buy("lifesteal", SHOP_PRICES.lifesteal));
  shop.querySelector("[data-b=buy-gold]")!.addEventListener("click", () => buy("gold", SHOP_PRICES.gold));
  shop.querySelector("[data-b=buy-revive]")!.addEventListener("click", () => {
    const q = adapter.loadProgress();
    if (q.reviveToken >= 1) { msg.textContent = "Already holding 1 (max)."; return; }
    if (!can(SHOP_PRICES.revive)) { msg.textContent = "Not enough gold."; return; }
    q.gold -= SHOP_PRICES.revive;
    q.reviveToken = 1;
    adapter.saveProgress(q);
    refresh();
  });
  const equip = (id: string) => {
    const q = adapter.loadProgress();
    if (!q.gunsOwned.includes(id)) { msg.textContent = `Buy it first.`; return; }
    q.equippedGun = id;
    adapter.saveProgress(q);
    refresh();
  };
  shop.querySelector("[data-b=equip-default]")!.addEventListener("click", () => equip("default"));
  shop.querySelector("[data-b=equip-life]")!.addEventListener("click", () => equip("lifesteal"));
  shop.querySelector("[data-b=equip-gold]")!.addEventListener("click", () => equip("gold"));
  const adBtn = shop.querySelector("[data-b=ad-gold]");
  if (adBtn && adapter.kind === "full") {
    adBtn.addEventListener("click", async () => {
      const ok = await adapter.requestRewarded("shop-gold");
      if (ok) {
        const q = adapter.loadProgress();
        q.gold += 10;
        adapter.saveProgress(q);
        refresh();
      } else {
        msg.textContent = "No ad filled — try again later (gold alternative always available).";
      }
    });
  }
  shop.querySelector("[data-b=back]")!.addEventListener("click", () => showHome(root, adapter, audio));
  // Locked 2026-09-26 §9: tutorial replays from the shop footer, never forced.
  shop.querySelector("[data-b=tutorial]")!.addEventListener("click", () => runDuel(root, adapter, "tutorial", audio));
}

export interface SeriesState {
  roundIndex: number;
  pWins: number;
  fWins: number;
}

/** Standard Best-of loop entry: full-HP resets, most-rounds-wins. */
function runSeries(root: HTMLElement, adapter: PortalAdapter, mode: Mode, audio: AudioManager): void {
  runDuel(root, adapter, mode, audio, { roundIndex: 0, pWins: 0, fWins: 0 });
}

/** Deathmatch run (locked 2026-09-24 §7): endless loops of 3 duels vs the
    3 roster profiles, 1 life for the whole run (HP carries over, no refill),
    each win restores 10% of max HP (clamped to max). Lose once = run over. */
export interface DeathRun {
  /** Duels won this run (= score). Duel in loop = streak % 3, loop = streak / 3. */
  streak: number;
  /** Player HP carried into the next duel. */
  hp: number;
}

const DEATHMATCH_WIN_HEAL = 0.1 * BASE_HP;

function runDeathmatch(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  runDuel(root, adapter, "deathmatch", audio, undefined, false, false, { run: { streak: 0, hp: BASE_HP } });
}

// Slice: Ready (holster gate) -> Focus(3s) -> DRAW! -> projectile duel vs AI.
// Best-of series / deathmatch run + ToD + hell + economy ride on top; single
// duel when neither. `startHP` overrides the player's opening HP (revive = 1).
function runDuel(
  root: HTMLElement,
  adapter: PortalAdapter,
  mode: Mode,
  audio: AudioManager,
  series?: SeriesState,
  hellRound = false,
  reviveUsed = false,
  opts: { run?: DeathRun; startHP?: number } = {},
): void {
  const run = opts.run;
  audio.stopMusic();
  audio.playMusic('duel');
  root.innerHTML = "";
  document.body.classList.add("in-duel"); // OS cursor hidden; crosshair is the pointer
  const coarse = isCoarsePointer();
  const gun = GUNS[adapter.loadProgress().equippedGun] ?? GUNS.default;
  const distM = hellRound ? 11 : 9 + Math.random() * 5; // uniform(9,14) per-round variance
  // Round index drives time-of-day + the AI profile; deathmatch walks the
  // 3-profile roster per loop and the level (0.94^level) goes up each loop.
  const rIdx = series?.roundIndex ?? (run ? run.streak % AI_ROSTER.length : 0);
  const level = run ? Math.floor(run.streak / AI_ROSTER.length) : 0;

  const { scene, camera, renderer, getHalfH, fitCamera, setTimeOfDay } = createArena(distM);
  // Time-of-day driver: R1 noon → R2 evening → R3+ night. Hell overrides.
  setTimeOfDay(timeOfDayForRound(hellRound ? 2 : rIdx));
  document.body.style.background = hellRound
    ? "linear-gradient(#0d0202 0%, #3a0a06 60%, #ff3a12 100%)"
    : cssSkyForRound(rIdx);
  root.appendChild(renderer.domElement);
  fitCamera();
  // Hell visuals: lazy chunk, never in the initial payload (QA gate). The
  // import() splits into its own chunk; by the 2nd duel GameplayStart has
  // fired at least once, and single-duel hell is impossible (needs a double
  // KO first), so the load always lands post-GameplayStart in practice.
  let hellDispose: (() => void) | null = null;
  if (hellRound) {
    void import("../render/hell").then((m) => {
      if (!alive) return;
      try {
        const h = m.enterHell(scene);
        hellDispose = () => h.dispose();
      } catch { /* visual only — duel continues */ }
    });
  }
  // Pooled gunsmoke + muzzle flash (procedural, zero shipped bytes). Player
  // and foe share this pool (Slice-2 AI path calls the same spawn).
  const gunsmoke = createGunsmoke(scene);

  // True projectiles (Slice 1): pooled sim + visible bullet meshes. Net seam:
  // every shot emits Fire{pos,dir,gunId,tick} / Hit{tick,head,damage} over
  // LocalTransport (AI = remote peer today, CrazyRoom later).
  const sim = new ProjectileSim();
  const transport = new LocalTransport();
  transport.onCmd(() => { /* net-ready envelope; local sim resolves inline */ });
  const bulletGeo = new THREE.SphereGeometry(0.055, 8, 6);
  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xfff4d0, fog: false });
  // prev/cur = bullet position before/after the latest fixed step; rendered
  // interpolated by alpha so flight is smooth at any refresh rate (60Hz steps
  // alone made bullets hop 1.8m per step on 120/144/165Hz displays).
  type BulletView = { mesh: THREE.Mesh; b: BulletState | null; prev: THREE.Vector3; cur: THREE.Vector3 };
  const bulletViews: BulletView[] = [];
  for (let i = 0; i < 8; i++) {
    const mesh = new THREE.Mesh(bulletGeo, bulletMat);
    mesh.visible = false;
    scene.add(mesh);
    bulletViews.push({ mesh, b: null, prev: new THREE.Vector3(), cur: new THREE.Vector3() });
  }
  function showBullet(b: BulletState): void {
    const v = bulletViews.find((x) => x.b === null || x.b.alive === false);
    if (!v) return;
    v.b = b;
    v.mesh.visible = true;
    v.prev.set(b.pos[0], b.pos[1], b.pos[2]);
    v.cur.copy(v.prev);
    v.mesh.position.copy(v.prev);
  }
  /** Before a fixed step: prev <- cur. */
  function bulletsBeginStep(): void {
    for (const v of bulletViews) if (v.b && v.b.alive) v.prev.copy(v.cur);
  }
  /** After the fixed step(s): cur <- sim position. */
  function bulletsEndStep(): void {
    for (const v of bulletViews) if (v.b && v.b.alive) v.cur.set(v.b.pos[0], v.b.pos[1], v.b.pos[2]);
  }
  /** Per rendered frame. */
  function renderBullets(alpha: number): void {
    for (const v of bulletViews) {
      if (!v.b || !v.b.alive) { v.mesh.visible = false; continue; }
      v.mesh.visible = true;
      v.mesh.position.lerpVectors(v.prev, v.cur, alpha);
    }
  }

  const stage = stagePositions(distM);
  // Procedural cowboys render instantly (GameplayStart never waits on
  // assets); Blender GLBs swap in silently when loaded, pose transferred.
  let player: Cowboy = createCowboy({ coat: 0x4a6fa5, hat: 0x3a2a1a, skin: 0xd9a066, facing: 1 });
  player.group.position.copy(stage.player);
  faceToward(player.group, stage.player, stage.foe);
  let foe: Cowboy = createCowboy({ coat: 0x8a3b2e, hat: 0x1a1a1a, skin: 0xc98d5f, facing: -1, accent: 0x1a1a1a, moustache: true });
  foe.group.position.copy(stage.foe);
  faceToward(foe.group, stage.foe, stage.player);
  scene.add(player.group, foe.group);
  // Accessories (hat, pads, belt, boots…) ride the nearest body part so no
  // detail freezes mid-air on death. Done before doll creation (attach
  // preserves world transforms, so body snapshots stay exact).
  try { bindAccessories(player.group, player.parts); } catch { /* noop */ }
  try { bindAccessories(foe.group, foe.parts); } catch { /* noop */ }
  let playerDoll: Ragdoll | null = createRagdoll(scene, player.parts, gun.id);
  let foeDoll: Ragdoll | null = createRagdoll(scene, foe.parts, gun.id);
  const base = import.meta.env.BASE_URL;
  void loadCowboyGlb(`${base}models/cowboy_hero.glb`, "H").then((m) => {
    if (m && alive) {
      player = swapCowboy(scene, player, m);
      // Late swap after DRAW: procedural owns the arms, silence idle.
      if (tracking) (player as unknown as CowboyGlb).stopClips?.();
      // Post-mortem swap: the fresh corpse must arrive already fallen.
      if (playerHP <= 0) {
        try { (player as unknown as CowboyGlb).playFrozen?.(playerFallVariant); } catch { /* noop */ }
      }
      try { bindAccessories(player.group, player.parts); } catch { /* noop */ }
      if (playerDoll) playerDoll.dispose();
      playerDoll = createRagdoll(scene, player.parts, gun.id);
    }
  });
  void loadCowboyGlb(`${base}models/cowboy_outlaw.glb`, "O").then((m) => {
    if (m && alive) {
      foe = swapCowboy(scene, foe, m);
      if (tracking) (foe as unknown as CowboyGlb).stopClips?.();
      if (foeHP <= 0) {
        try { (foe as unknown as CowboyGlb).playFrozen?.(foeFallVariant); } catch { /* noop */ }
      }
      try { bindAccessories(foe.group, foe.parts); } catch { /* noop */ }
      if (foeDoll) foeDoll.dispose();
      foeDoll = createRagdoll(scene, foe.parts, gun.id);
    }
  });
  // Blender street set swaps over the procedural block when ready.
  // Its ambient life (signs, horse, tumbleweed) is posed from wall time in
  // frame(); windows/lanterns glow by time of day (noon dark -> night lit).
  let street: StreetSet | null = null;
  void loadStreetGlb(`${base}models/street.glb`, distM).then((s) => {
    if (!s || !alive) return;
    for (const n of ["ProceduralStreet", "ProceduralDressing"]) {
      const old = scene.getObjectByName(n);
      if (old) old.visible = false;
    }
    s.setGlow(hellRound ? 1 : [0, 0.55, 1][Math.min(rIdx, 2)]);
    scene.add(s.group);
    street = s;
  });
  const playerYaw = player.group.rotation.y;

  const hud = el(`<div class="hud">
    <div class="cue">HOLSTER UP</div><div class="sub"></div>
  </div>`);
  const cross = el(`<div class="crosshair" style="display:none"><i class="chl t"></i><i class="chl b"></i><i class="chl l"></i><i class="chl r"></i><i class="cdot"></i></div>`);
  const spreadCross = el(`<div class="crosshair spread" style="display:none"></div>`);
  hud.appendChild(cross);
  hud.appendChild(spreadCross);
  root.appendChild(hud);
  const roundLine = el(`<div class="roundline" style="position:absolute;top:calc(76px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);font-size:13px;font-weight:700;letter-spacing:.1em;color:#ffe9bd;text-shadow:0 1px 4px rgba(60,20,5,.9);pointer-events:none;"></div>`);
  root.appendChild(roundLine);
  function paintRound(): void {
    if (hellRound) { roundLine.textContent = "🔥 HELL SUDDEN-DEATH — 1 BULLET EACH"; return; }
    if (series) { roundLine.textContent = `ROUND ${series.roundIndex + 1} · YOU ${series.pWins} – ${series.fWins} FOE (1ST TO ${FIRST_TO})`; return; }
    if (run) { roundLine.textContent = `DEATHMATCH · STREAK ${run.streak} · DUEL ${rIdx + 1}/${AI_ROSTER.length} · LOOP ${level + 1}`; return; }
    roundLine.textContent = "";
  }
  paintRound();
  
  const cylinder = el(`<div class="cylinder">
    <svg viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="45" class="cyl-outline"/>
      ${Array.from({length: 6}, (_, i) => {
        const angle = (i * 60 - 90) * Math.PI / 180;
        const cx = 50 + 30 * Math.cos(angle);
        const cy = 50 + 30 * Math.sin(angle);
        return `<circle cx="${cx}" cy="${cy}" r="10" class="chamber live" data-idx="${i}"/>`;
      }).join('')}
    </svg>
  </div>`);
  root.appendChild(cylinder);
  const faceSVG = (hat: string, skin: string) =>
    `<svg viewBox="0 0 22 22"><rect x="3" y="2" width="16" height="3" rx="1" fill="${hat}"/><rect x="7" y="0" width="8" height="5" rx="1" fill="${hat}"/><rect x="5" y="6" width="12" height="12" rx="3" fill="${skin}"/><rect x="7.5" y="10" width="2.4" height="2.8" fill="#241407"/><rect x="12.2" y="10" width="2.4" height="2.8" fill="#241407"/><rect x="8.5" y="15" width="5" height="1.4" rx="0.7" fill="#5e2f16"/></svg>`;
  const hp = el(`<div class="hpwrap"><div class="hp you"><i></i><b class="star">★</b><b class="face">${faceSVG("#6b4a26", "#d9a066")}</b></div><div class="hp foe"><i></i><b class="star">★</b><b class="face">${faceSVG("#1a1a1a", "#c98d5f")}</b></div></div>`);
  root.appendChild(hp);
  // Foe ammo pips under the foe HP bar (fixed px, zoom-proof like all HUD).
  const foeAmmoEl = el(`<div class="foeammo" title="Foe ammo"><span>FOE</span>${"<i></i>".repeat(6)}</div>`);
  root.appendChild(foeAmmoEl);

  // Holster zone: just below the player's legs, gun-hand side (locked).
  const zone = el(`<div class="readyzone"><b>HOLSTER</b><small>${coarse ? "tap here" : "mouse here"}</small></div>`);
  root.appendChild(zone);

  let skip: HTMLElement | null = null;
  if (mode === "tutorial") {
    skip = el(`<div class="skip"><button>SKIP ▸</button></div>`);
    root.appendChild(skip);
    skip.querySelector("button")!.addEventListener("click", () => {
      cleanup();
      showHome(root, adapter, audio);
    });
  }

  const machine = new DuelMachine({
    seed: (Math.random() * 1e9) | 0,
    bloomStartDeg: gun.bloomStartDeg,
    bloomMinDeg: gun.bloomMinDeg,
    bloomMaxDeg: gun.bloomStartDeg + 0.6,
    focusPerTapDeg: gun.focusPerTapDeg,
    duelDistM: distM,
  });
  // Focus timing QTE: advanced on the fixed clock, judged at the time the
  // player actually saw (last render alpha + wall time since that frame).
  const qte = new TimingQte(machine.seed);
  let qteAlpha = 0;
  let qteFrameMs = performance.now();
  let focusEngaged = true;
  /** Seconds past the last fixed tick right now: render alpha + wall time
      since that frame, capped at what the next frame could advance. */
  const qteExtra = () =>
    machine.paused ? 0 : Math.min(MAX_FRAME_DT, qteAlpha * STEP + (performance.now() - qteFrameMs) / 1000);

  // Wound-pose targets (group-level: feet stay planted, no locomotion).
  // pitch = forward lean toward the foe (YXZ order: local +Z faces the foe
  // on both sides); roll = sideways crumple so the pose READS on the chase
  // cam (pure forward motion foreshortens along the view axis); drop = group
  // y offset. TUNED AGAINST THE HIT CAPSULES (projectiles.ts CAPSULE_FOR_POSE):
  // the visible head must land within ~0.08m of capsule headY or shots at the
  // visible head miss (the old numbers sat 0.2-0.33m too high). Measured with
  // __gamey.poseProbe/tests/ai-wounds.ts: bend head 1.73 (cap 1.68), crouch
  // 1.33 (1.32), prone 0.55 (0.55). Crouch = kneel: hips sink to ~0.55, shin
  // flat on the dirt (see WOUND_JOINTS). Prone = lying (~85deg), not a plank.
  const WOUND_POSE_TARGET: Record<WoundPose, { pitch: number; roll: number; drop: number }> = {
    none: { pitch: 0, roll: 0, drop: 0 },
    bend: { pitch: 0.4, roll: 0.12, drop: -0.15 },
    crouch: { pitch: 0.6, roll: 0.15, drop: -0.42 },
    prone: { pitch: 1.48, roll: 0.33, drop: 0 },
  };

  /** Damped wound-pose chase. Skipped for corpses and the dead
      (ragdoll/setFall own rotation there) — death from any pose hands off
      cleanly. Returns [drop, roll]: the sway lines consume drop, the firing-
      rock lines compose on top of roll (they share rotation.z). */
  function woundStep(c: Cowboy, wound: WoundPose, hp: number, doll: Ragdoll | null, dt: number, drop: number, roll: number): [number, number] {
    const t = WOUND_POSE_TARGET[wound];
    const k = 1 - Math.exp(-dt * 6);
    if (hp > 0 && !doll?.fallen) {
      c.group.rotation.x += (t.pitch - c.group.rotation.x) * k;
      c.group.rotation.z += (t.roll - c.group.rotation.z) * k;
      roll += (t.roll - roll) * k;
    }
    return [drop + (t.drop - drop) * k, roll];
  }

  /** Wound-joint targets, driven procedurally every frame (damped chase).
      Same code path as the gun arm: deterministic, debuggable, identical on
      GLB + procedural rigs. (Blender NLA clips proved un drivable in this
      setup — all mixer bindings resolve null — so joints are code-owned like
      armR/elbowR. The authored actions remain in the GLBs, inert.)
      Signs: waist follows group-pitch convention (+ tips top toward foe);
      thigh/knee signs tuned visually (hanging limbs swing opposite). */
  const WOUND_JOINTS: Record<WoundPose, { thigh: number; knee: number; waist: number }> = {
    none: { thigh: 0, knee: 0, waist: 0 },
    bend: { thigh: 0, knee: 0.4, waist: 0 },
    // Hip flexion (thigh) + knee fold put the shin on the ground = kneel. The
    // leg mesh pivots mid-thigh (Leg origin z 0.52), so the hips sink via the
    // group drop, not the thigh swing.
    crouch: { thigh: -1.07, knee: 1.69, waist: 0 },
    prone: { thigh: 0.4, knee: 1, waist: 0.05 },
  };

  /** Gun-arm stabilizer. Wound poses pitch AND roll the whole body (group),
      and the shoulder rides along, so armR/elbowR angles would aim wherever the
      body leans. The shoulder now sits on a mount whose rotation cancels the
      body's wound rotation (everything but yaw): arm angles from the chase,
      the choreography and the clips always mean the same WORLD direction as
      standing. Replaces the old pitch-only compensation (target + pitch),
      which matched for bend/crouch but let prone's sideways roll swing the
      gun ~18 deg off and ~10 deg high (measured with __gamey.gunVec).
      Parent-agnostic via world quaternions: the GLB armR hangs under the
      mirrored inner node (rotation.y = PI), the procedural one under waist.
      mount = P^-1 * Y * G^-1 * P (P = mount parent world, G = group, Y = its
      yaw), identity when upright. Dead/corpse duelists keep their last mount
      (the ragdoll owns the arm). */
  const armMounts = new WeakMap<Cowboy, THREE.Group>();
  const _qP = new THREE.Quaternion();
  const _qPi = new THREE.Quaternion();
  const _qG = new THREE.Quaternion();
  const _qY = new THREE.Quaternion();
  const _eY = new THREE.Euler();
  function stabilizeArm(c: Cowboy, hp: number, doll: Ragdoll | null): void {
    if (hp <= 0 || doll?.fallen) return;
    let m = armMounts.get(c);
    if (!m) {
      const parent = c.armR.parent;
      if (!parent) return;
      m = new THREE.Group();
      m.position.copy(c.armR.position);
      parent.add(m);
      c.armR.position.set(0, 0, 0);
      m.add(c.armR);
      armMounts.set(c, m);
    }
    m.parent!.getWorldQuaternion(_qP);
    c.group.getWorldQuaternion(_qG);
    _qY.setFromEuler(_eY.set(0, c.group.rotation.y, 0));
    _qPi.copy(_qP).invert();
    m.quaternion.copy(_qPi).multiply(_qY).multiply(_qG.invert()).multiply(_qP);
  }
  /** Lying down: the upper arm would hang straight into the dirt. Swing the
      shoulder forward and fold the elbow back by the same amount (muzzle
      direction unchanged) once the body is near horizontal; 0 when upright. */
  const armLift = (c: Cowboy): number => Math.min(0.9, Math.max(0, (c.group.rotation.x - 0.9) * 1.5));

  /** Damped joint chase. Skipped for corpses/dead like the group pose.
      Null-safe: rigs predating the joints keep the group-tilt fallback. */
  function driveJoints(c: Cowboy, wound: WoundPose, hp: number, doll: Ragdoll | null, dt: number): void {
    if (hp <= 0 || doll?.fallen) return;
    const t = WOUND_JOINTS[wound];
    const k = 1 - Math.exp(-dt * 6);
    const J = c.joints;
    if (!J) return;
    if (J.thighL) J.thighL.rotation.x += (t.thigh - J.thighL.rotation.x) * k;
    if (J.thighR) J.thighR.rotation.x += (t.thigh - J.thighR.rotation.x) * k;
    if (J.kneeL) J.kneeL.rotation.x += (t.knee - J.kneeL.rotation.x) * k;
    if (J.kneeR) J.kneeR.rotation.x += (t.knee - J.kneeR.rotation.x) * k;
    if (J.waist) J.waist.rotation.x += (t.waist - J.waist.rotation.x) * k;
  }

  // DEV-only probe for the wound test suite (zero prod surface).
  if (import.meta.env.DEV) {
    (window as unknown as { __gamey?: unknown }).__gamey = {
      wounds: () => ({ player: playerWound, playerHits: playerWounds, foe: foeWound, foeHits: foeWounds }),
      capsule: (side: "player" | "foe") => CAPSULE_FOR_POSE[side === "player" ? playerWound : foeWound],
      roll: (n: number) => machine.rollWound(n),
      /** Focus QTE readout: needle as rendered right now + zone + tallies. */
      qte: () => ({
        needle: qte.peek(qteExtra()),
        zoneC: qte.zoneC, zoneW: qte.zoneW, perfectW: qte.perfectW, frozen: qte.frozen,
        hits: qte.hits, misses: qte.misses, streak: qte.streak,
        phase: machine.phase, paused: machine.paused, bloom: machine.bloomDeg,
        secsLeft: machine.focusTicksLeft() / 60,
      }),
      /** Look-dev: force round i's time of day + street glow; hell=true
          also drops the hell set in (street captures, not gameplay). */
      tod: (i: number, hell = false) => {
        setTimeOfDay(timeOfDayForRound(hell ? 2 : i));
        street?.setGlow(hell ? 1 : [0, 0.55, 1][Math.min(i, 2)]);
        if (hell) void import("../render/hell").then((m) => m.enterHell(scene));
      },
      /** Joint + group rotation readout (pose debug). */
      joints: (side: "player" | "foe") => {
        const c = side === "player" ? player : foe;
        const J = c.joints;
        const r = (o: THREE.Object3D | null) => (o ? +o.rotation.x.toFixed(3) : null);
        return {
          group: +c.group.rotation.x.toFixed(3),
          drop: +c.group.position.y.toFixed(3),
          thighL: r(J?.thighL ?? null), kneeL: r(J?.kneeL ?? null),
          waist: r(J?.waist ?? null),
        };
      },
      /** World positions of a duelist's ragdoll parts (corpse-coherence
          checks: spread must stay bounded, never NaN). */
      parts: (side: "player" | "foe") => {
        const c = side === "player" ? player : foe;
        const out: Record<string, [number, number, number] | null> = {};
        for (const [k, o] of Object.entries(c.parts)) {
          if (!o) { out[k] = null; continue; }
          o.updateWorldMatrix(true, false);
          const v = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld);
          out[k] = [+v.x.toFixed(2), +v.y.toFixed(2), +v.z.toFixed(2)];
        }
        return out;
      },
      /** Physics body centers (diagnostics: sim vs sync split). */
      bodies: (side: "player" | "foe") => {
        const d = side === "player" ? playerDoll : foeDoll;
        try { return d?.bodies?.() ?? null; } catch { return null; }
      },
      /** Physics joint gaps (0 = held): tells a torn joint from a sync bug. */
      jointErrors: (side: "player" | "foe") => {
        const d = side === "player" ? playerDoll : foeDoll;
        try { return d?.jointErrors?.() ?? null; } catch { return null; }
      },
      /** Screen px of a duelist's (possibly lowered) capsule mid or head —
          lets tests aim at wounded/prone bodies on any viewport. */
      aimAt: (side: "player" | "foe", part: "mid" | "head" = "mid") => {
        const feet = side === "player" ? stage.player : stage.foe;
        const cap = CAPSULE_FOR_POSE[side === "player" ? playerWound : foeWound];
        const y = part === "head" ? cap.headY : capsuleMid(cap);
        const s = project(feet.clone().add(new THREE.Vector3(0, y, 0)));
        return { x: s.x, y: s.y };
      },
      /** Set a wound pose INSTANTLY (no chase) and measure it: head/pelvis/
          torso world Y, lowest point (feet planted => ~0) and foot reach
          ahead of the pelvis. Lets tuning sweep many poses in one tick. */
      poseProbe: (side: "player" | "foe", p: { pitch: number; roll: number; drop: number; thigh: number; knee: number; waist: number }) => {
        const c = side === "player" ? player : foe;
        c.group.rotation.x = p.pitch; c.group.rotation.z = p.roll; c.group.position.y = p.drop;
        const J = c.joints;
        if (J) {
          if (J.thighL) J.thighL.rotation.x = p.thigh;
          if (J.thighR) J.thighR.rotation.x = p.thigh;
          if (J.kneeL) J.kneeL.rotation.x = p.knee;
          if (J.kneeR) J.kneeR.rotation.x = p.knee;
          if (J.waist) J.waist.rotation.x = p.waist;
        }
        c.group.updateMatrixWorld(true);
        const y = (o: THREE.Object3D | null) => (o ? new THREE.Vector3().setFromMatrixPosition(o.matrixWorld) : null);
        const head = y(c.parts.head), pelvis = y(c.parts.pelvis), torso = y(c.parts.torso);
        // Body box WITHOUT the gun-arm assembly: the arm points forward in
        // body space, so on a pitched pose it dives below the dirt and would
        // swamp the feet-planted measurement (aim code re-poses it live).
        const box = new THREE.Box3();
        const skip = c.armR;
        const walk = (o: THREE.Object3D): void => {
          if (o === skip) return;
          if ((o as THREE.Mesh).isMesh && o.visible) box.expandByObject(o, false);
          for (const k of o.children) walk(k);
        };
        walk(c.group);
        return {
          headY: head?.y ?? NaN, pelvisY: pelvis?.y ?? NaN, torsoY: torso?.y ?? NaN,
          minY: box.min.y, maxY: box.max.y,
          // horizontal spread along the facing axis (z) — squats shouldn't fling feet far
          depth: box.max.z - box.min.z, width: box.max.x - box.min.x,
        };
      },
      /** Gun elevation in degrees (muzzle vs shoulder, world space): 0 = level,
          negative = pointing at the ground. Pose-tuning aid. */
      gunElev: (side: "player" | "foe") => {
        const c = side === "player" ? player : foe;
        c.group.updateMatrixWorld(true);
        const a = new THREE.Vector3().setFromMatrixPosition(c.armR.matrixWorld);
        const g = c.gunTip.getWorldPosition(new THREE.Vector3());
        const d = g.sub(a);
        return +(Math.atan2(d.y, Math.hypot(d.x, d.z)) * 180 / Math.PI).toFixed(1);
      },
      /** Arm chain readout (world positions + joint rotations) for pose tuning. */
      armChain: (side: "player" | "foe") => {
        const c = side === "player" ? player : foe;
        c.group.updateMatrixWorld(true);
        const w = (o: THREE.Object3D) => new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).toArray().map((v) => +v.toFixed(2));
        const px = (o: THREE.Object3D) => { const v = new THREE.Vector3().setFromMatrixPosition(o.matrixWorld).project(camera); return [Math.round((v.x * 0.5 + 0.5) * innerWidth), Math.round((-v.y * 0.5 + 0.5) * innerHeight)]; };
        return { px: { armR: px(c.armR), elbowR: px(c.elbowR), gunTip: px(c.gunTip) }, armR: w(c.armR), elbowR: w(c.elbowR), gunTip: w(c.gunTip), armRot: +c.armR.rotation.x.toFixed(2), elbowRot: +c.elbowR.rotation.x.toFixed(2), armRotY: +c.armR.rotation.y.toFixed(2), groupPitch: +c.group.rotation.x.toFixed(2), groupRoll: +c.group.rotation.z.toFixed(2) };
      },
      /** World vector shoulder -> muzzle (pose tuning: compare to the standing
          vector; elevation alone can't tell forward-down from backward-down). */
      gunVec: (side: "player" | "foe") => {
        const c = side === "player" ? player : foe;
        c.group.updateMatrixWorld(true);
        const a = new THREE.Vector3().setFromMatrixPosition(c.armR.matrixWorld);
        const g = c.gunTip.getWorldPosition(new THREE.Vector3()).sub(a);
        return [g.x, g.y, g.z];
      },
      /** Live-edit a pose's tables (visual iteration without a rebuild). */
      setPose: (pose: WoundPose, v: Partial<{ pitch: number; roll: number; drop: number; thigh: number; knee: number; waist: number }>) => {
        const t = WOUND_POSE_TARGET[pose], j = WOUND_JOINTS[pose];
        if (v.pitch !== undefined) t.pitch = v.pitch;
        if (v.roll !== undefined) t.roll = v.roll;
        if (v.drop !== undefined) t.drop = v.drop;
        if (v.thigh !== undefined) j.thigh = v.thigh;
        if (v.knee !== undefined) j.knee = v.knee;
        if (v.waist !== undefined) j.waist = v.waist;
      },
      /** Profile camera on the foe (flexion is foreshortened on the OTS
          cam, so pose tuning needs a side view). `false` restores. */
      sideView: (() => {
        let saved: { p: THREE.Vector3; q: THREE.Quaternion; zoom: number } | null = null;
        return (on: boolean) => {
          if (on) {
            if (!saved) saved = { p: camera.position.clone(), q: camera.quaternion.clone(), zoom: camera.zoom };
            const dir = stage.foe.clone().sub(stage.player).setY(0).normalize();
            const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
            const mid = stage.foe.clone().add(new THREE.Vector3(0, 0.8, 0)).addScaledVector(dir, -0.7);
            camera.position.copy(mid).addScaledVector(side, 12);
            camera.lookAt(mid);
            camera.zoom = 1.7;
            camera.updateProjectionMatrix();
          } else if (saved) {
            camera.position.copy(saved.p); camera.quaternion.copy(saved.q); camera.zoom = saved.zoom;
            camera.updateProjectionMatrix();
            saved = null;
          }
        };
      })(),
      /** Force a wound pose (prone visuals / prone-duel tests). */
      force: (side: "player" | "foe", wound: WoundPose) => {
        // Real wounds follow a flinch whose clip is released (see FLINCH_END):
        // mirror that so the procedural arm owns the pose under test.
        try { ((side === "player" ? player : foe) as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
        const hits = wound === "none" ? 0 : wound === "prone" ? 2 : 1;
        if (side === "player") { playerWound = wound; playerWounds = hits; }
        else { foeWound = wound; foeWounds = hits; refreshAimPlane(); }
      },
    };
  }

  const cue = hud.querySelector(".cue") as HTMLElement;
  const sub = hud.querySelector(".sub") as HTMLElement;
  const youBar = hp.querySelector(".you i") as HTMLElement;
  const foeBar = hp.querySelector(".foe i") as HTMLElement;
  const youFace = hp.querySelector(".you .face") as HTMLElement;
  const foeFace = hp.querySelector(".foe .face") as HTMLElement;
  const chambers = Array.from(cylinder.querySelectorAll(".chamber")) as SVGCircleElement[];

  // Revive restarts at 1HP (locked 09-26 §6); a deathmatch run carries its HP
  // between duels. Hell rounds start both at full HP.
  let playerHP = opts.startHP ?? (run && !hellRound ? run.hp : BASE_HP);
  let foeHP = BASE_HP;
  let ammo = hellRound ? 1 : SHOTS_PER_DUEL;
  let foeAmmo = hellRound ? 1 : SHOTS_PER_DUEL;
  let alive = true;
  let tracking = false; // arm follows aim only after DRAW
  let lastShotAt = -1e9;
  let kickT = 99; // seconds since last shot (drives visible recoil kick)
  let foeKickT = 99; // foe gun-kick timer (procedural shooting anim)
  let foeFlinchT = 99; // foe hit-jerk timer (procedural hit anim)
  let playerFlinchT = 99; // player hit-jerk timer (procedural hit anim)
  let roundOver = false;
  let killByPlayer = false;
  let killByFoe = false;
  let foeHeadshot = false; // picks the round-end cue (headshot vs body kill)
  let playerDeadAt = -1e9;
  let foeDeadAt = -1e9;
  // Wound lottery (locked 2026-10-02): taken-hit counters + persistent poses.
  // Reset every duel (fresh runDuel closure) and on revive — duelists stand
  // back up. Death rules untouched: wounds never gate lethality.
  let playerWounds = 0;
  let foeWounds = 0;
  let playerWound: WoundPose = "none";
  let foeWound: WoundPose = "none";
  // Damped wound-drop offsets, consumed by the sway lines in frame().
  let playerDrop = 0;
  let foeDrop = 0;
  // Damped wound-roll mirrors (source of truth for the firing-rock lines,
  // which share rotation.z with the wound roll).
  let playerRoll = 0;
  let foeRoll = 0;
  // Last played fall variant per side (post-mortem GLB swaps freeze here).
  let playerFallVariant = "fall_fwd";
  let foeFallVariant = "fall_back";
  let foeTimers: number[] = [];
  const aimWorld = stage.player.clone().lerp(stage.foe, 0.4).setY(0.2);
  // aimTarget takes instant pointer input; aimWorld glides toward it every
  // frame, so the crosshair + gun never snap — not at DRAW, not while
  // aiming. Hit registration uses the projectile path, so this chase is
  // pure visual and cannot shift a shot.
  const aimTarget = aimWorld.clone();
  // aimEngaged flips on the first genuine pointer/touch input after DRAW.
  // Before that the crosshair stays glued to the OS pointer and the arm
  // stays in guns-down pose: zero autonomous motion, the hand owns every
  // pixel. The engaging event also snaps the chase value (that event IS
  // user control), then the glide takes over.
  let aimEngaged = false;
  // Holster-draw choreography clock (0 at DRAW). Both duelists run the same
  // pull: guns-down → dip to the hip holster → sweep up past level →
  // settle level, then normal aim takes over. One procedural path for both
  // rigs (GLB + procedural share the armR/elbowR seam).
  let drawT = 99;
  // Aim OPENS off-target: muzzle at the dirt between the duelists, so the
  // player must manually drag up onto the foe after DRAW. Aim stays parked
  // through Focus (locked no-pre-aim rule); the first mouse move / touch
  // after DRAW takes over via aimFromClient.
  // Crosshair renders where the pointer IS (never pinned to the target).
  const pointerPx = { x: window.innerWidth / 2, y: window.innerHeight * 0.4 };

  function placeCross(cx: number, cy: number): void {
    const rr = root.getBoundingClientRect();
    cross.style.left = `${cx - rr.left}px`;
    cross.style.top = `${cy - rr.top}px`;
    cross.style.transform = "translate(-50%, -50%)";
    // Bloom drives the line gap (radius), never a ring: classic lines+dot.
    cross.style.setProperty("--gap", `${Math.max(13, crossPx() / 2)}px`);
  }

  function paintBars(): void {
    youBar.style.width = `${(playerHP / BASE_HP) * 100}%`;
    foeBar.style.width = `${(foeHP / BASE_HP) * 100}%`;
    // Portrait badges ride the receding (wound) edge of each bar.
    youFace.style.left = `${(playerHP / BASE_HP) * 100}%`;
    foeFace.style.left = `${(foeHP / BASE_HP) * 100}%`;
    for (let i = 0; i < 6; i++) {
      chambers[i].classList.toggle("live", i < ammo);
      chambers[i].classList.toggle("spent", i >= ammo);
    }
    const foePips = Array.from(foeAmmoEl.querySelectorAll("i"));
    foePips.forEach((p, i) => (p as HTMLElement).classList.toggle("spent", i >= foeAmmo));
  }
  paintBars();

  function project(v: THREE.Vector3): { x: number; y: number } {
    const p = v.clone().project(camera);
    const r = renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((p.x + 1) / 2) * r.width, y: r.top + ((1 - p.y) / 2) * r.height };
  }

  // Holster zone is a FIXED WORLD-SIZE box (1.35m), projected to screen:
  // browser/game zoom rescales zone and foe together, so the holster →
  // enemy travel and the stay-inside challenge are identical at any zoom.
  function zonePx(): number {
    return clamp(1.35 / worldPerPx(), 72, 220);
  }
  function updateZone(): void {
    const s = zonePx();
    zone.style.width = `${s}px`;
    zone.style.height = `${s}px`;
    const feet = project(stage.player);
    const x = clamp(feet.x + s * 0.41, s / 2 + 8, window.innerWidth - s / 2 - 8);
    const y = clamp(feet.y + s * 0.86, s / 2 + 8, window.innerHeight - s / 2 - 8);
    zone.style.left = `${x - s / 2}px`;
    zone.style.top = `${y - s / 2}px`;
  }
  updateZone();

  function worldPerPx(): number {
    const hCss = renderer.domElement.getBoundingClientRect().height || window.innerHeight;
    return (2 * getHalfH()) / hCss;
  }

  function crossPx(): number {
    const toAim = camera.position.distanceTo(aimWorld);
    const worldR = Math.tan((machine.bloomDeg * Math.PI) / 180) * toAim;
    return Math.max(26, (2 * worldR) / worldPerPx());
  }

  // Aim plane through the foe, facing the camera; clamped to a reach box.
  // Re-seated on every foe wound — the plane tracks the (possibly lowered)
  // capsule so aim feel stays identical against bent/crouched/prone foes.
  const raycaster = new THREE.Raycaster();
  const aimPlane = new THREE.Plane();
  function refreshAimPlane(): void {
    const n = camera.getWorldDirection(new THREE.Vector3()).negate();
    aimPlane.setFromNormalAndCoplanarPoint(n, stage.foe.clone().add(new THREE.Vector3(0, capsuleMid(CAPSULE_FOR_POSE[foeWound]), 0)));
  }
  refreshAimPlane();
  const ndc = new THREE.Vector2();
  const hitP = new THREE.Vector3();
  
  function showSpreadCross(sx: number, sy: number): void {
    spreadCross.style.display = "block";
    const rr = root.getBoundingClientRect();
    spreadCross.style.left = `${sx - rr.left}px`;
    spreadCross.style.top = `${sy - rr.top}px`;
    spreadCross.style.transform = "translate(-50%, -50%)";
    spreadCross.style.width = "12px";
    spreadCross.style.height = "12px";
    window.setTimeout(() => {
      spreadCross.style.display = "none";
    }, 300);
  }
  
  // Aim follows the pointer ANYWHERE on screen — no reach-box clamp. The
  // ray always hits the (infinite) aim plane, and projecting back lands
  // exactly under the cursor, so the crosshair can never jump or stick:
  // holster-low, sky, edges, all reachable.
  function aimFromClient(cx: number, cy: number): void {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    if (raycaster.ray.intersectPlane(aimPlane, hitP)) {
      aimTarget.copy(hitP);
      if (!aimEngaged) {
        // First genuine input after DRAW: the hand takes over. Snap the
        // chase value to this event so the crosshair is exactly under the
        // cursor, then glide from here on. Procedural arm resumes: silence
        // the draw flourish so the two never fight over the joints.
        aimEngaged = true;
        aimWorld.copy(aimTarget);
        try { (player as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      }
    }
  }

  function beginFocus(): void {
    if (machine.phase !== "ready") return;
    machine.startFocus();
    cue.textContent = "FOCUS! 3.0s";
    sub.textContent = coarse ? "Tap when the line is in the gold" : "SPACE / ENTER when the line is in the gold · don't click";
    cross.style.display = "block";
    adapter.gameplayStart();
  }

  function inZone(cx: number, cy: number): boolean {
    const r = zone.getBoundingClientRect();
    return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
  }

  function foeScreen(): { head: { x: number; y: number }; body: { x: number; y: number } } {
    const cap = CAPSULE_FOR_POSE[foeWound];
    return {
      head: project(stage.foe.clone().add(new THREE.Vector3(0, cap.headY, 0))),
      body: project(stage.foe.clone().add(new THREE.Vector3(0, capsuleMid(cap), 0))),
    };
  }

  function shakeFoe(): void {
    const bx = stage.foe.x;
    const steps = [0.1, -0.08, 0.05, 0];
    steps.forEach((dx, i) => {
      window.setTimeout(() => {
        if (alive && !foeDoll?.fallen) foe.group.position.x = bx + dx;
      }, i * 60);
    });
  }

  /** Authored directional fall (Blender): returns the played variant, or null
      when the rig ships no fall clips (caller falls back to physics). The
      bullet's push direction picks the variant — away from the shooter reads
      as knocked backward, into them as forward. Wound-prone duelists skip
      clips (keyed from standing; they'd snap) and go straight to physics. */
  function playDeathFall(who: Cowboy, dir: THREE.Vector3, wound: WoundPose = "none"): string | null {
    if (wound === "prone") return null;
    const g = who as unknown as CowboyGlb;
    const axis = stage.foe.clone().sub(stage.player).normalize();
    let variant = dir.clone().normalize().dot(axis) > -0.2 ? "fall_back" : "fall_fwd";
    if (!(g.hasClip?.(variant) ?? false)) variant = "fall_back";
    if (!(g.hasClip?.(variant) ?? false)) return null;
    try { g.playClip?.(variant); } catch { /* noop */ }
    return variant;
  }

  function killFoe(head: boolean, point: THREE.Vector3, dir: THREE.Vector3): void {
    foeHP = 0;
    foeHeadshot = head;
    foeDeadAt = performance.now();
    paintBars();
    // Death visual, layered: authored directional fall first (weighty,
    // art-directed — no more paper crumple); articulated physics second;
    // stiff tip-over + defeat clip last.
    // Ragdoll-first (locked 2026-10-01): emergent physics owns projectile
    // deaths — pose + velocity + hit-point in, crumple out. Authored falls
    // survive only for non-hit deaths (ammo-out) + null-safe fallback.
    // stopClips runs on every path: a breathing/idle loop must never animate
    // a corpse (playDeathFall stops all internally via playClip).
    let ragdolled = false;
    try {
      if (foeDoll) { foeDoll.hit(point, dir, gun.baseDamage / 6); ragdolled = true; }
    } catch { /* fall through to authored */ }
    try { (foe as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
    if (!ragdolled) {
      const fell = playDeathFall(foe, dir, foeWound);
      if (fell) foeFallVariant = fell;
      else {
        try { foe.setFall(true); } catch { /* noop */ }
        try { (foe as unknown as CowboyGlb).playClip?.("defeat"); } catch { /* no-op */ }
      }
    }
    void audio.playSFX(head ? "hit-head" : "hit-body").catch(() => undefined);
    if (!head) {
      const dmg = bodyDamage(gun.baseDamage, distM);
      if (gun.extra === "lifesteal") {
        playerHP = Math.min(BASE_HP, playerHP + Math.min(LIFESTEAL_CAP_PER_HIT, dmg * gun.extraValue));
        paintBars();
      }
    }
    killByPlayer = true;
    maybeEnd();
  }

  function woundFoe(dmg: number): void {
    foeHP = Math.max(0, foeHP - dmg);
    paintBars();
    if (foeHP <= 0) {
      // body kill already routed via killFoe with point/dir; this path is
      // only for residual safety.
      foeDeadAt = performance.now();
      try { foe.setFall(true); } catch { /* noop */ }
      killByPlayer = true;
      maybeEnd();
      return;
    }
    machine.applyFlinch(0, 0.9); // big crosshair bloom on being hit (user-tuned)
    foeFlinchT = 0;
    shakeFoe();
    try { (foe as unknown as CowboyGlb).playClip?.("flinch"); } catch { /* no-op */ }
    // Wound lottery: persistent reactive pose (bend/crouch/prone unlocks).
    foeWounds += 1;
    foeWound = machine.rollWound(foeWounds);
    refreshAimPlane();
    void audio.playSFX("hit-body").catch(() => undefined);
    cue.textContent = `HIT −${dmg.toFixed(0)}`;
    sub.textContent = foeHP > 0 && ammo > 0 ? "Again — aim + fire!" : sub.textContent;
  }

  function hitPlayer(head: boolean, dmg: number, point?: THREE.Vector3, dir?: THREE.Vector3): void {
    if (roundOver) return;
    if (head) {
      playerHP = 0;
      playerDeadAt = performance.now();
      paintBars();
      const hp = point ?? player.group.position.clone().add(new THREE.Vector3(0, CAPSULE_FOR_POSE[playerWound].headY, 0));
      const hd = dir ?? new THREE.Vector3(0, 0, 1);
      let ragdolled = false;
      try {
        if (playerDoll) { playerDoll.hit(hp, hd, 9); ragdolled = true; }
      } catch { /* fall through to authored */ }
      try { (player as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      if (!ragdolled) {
        const fell = playDeathFall(player, hd, playerWound);
        if (fell) playerFallVariant = fell;
        else {
          try { player.setFall(true); } catch { /* noop */ }
          try { (player as unknown as CowboyGlb).playClip?.("defeat"); } catch { /* noop */ }
        }
      }
      killByFoe = true;
      cue.textContent = "HEADSHOT — YOU'RE DOWN";
      maybeEnd();
      return;
    }
    playerHP = Math.max(0, playerHP - dmg);
    paintBars();
    machine.applyFlinch(0, 1.1); // locked §3: flinch both ways, big margin on hit
    playerFlinchT = 0;
    if (playerHP > 0) {
      // Wound lottery (same as foe): persistent reactive pose.
      playerWounds += 1;
      playerWound = machine.rollWound(playerWounds);
      try { (player as unknown as CowboyGlb).playClip?.("flinch"); } catch { /* no-op */ }
    }
    cross.classList.add("penalty");
    window.setTimeout(() => cross.classList.remove("penalty"), 220);
    void audio.playSFX("hit-body").catch(() => undefined);
    if (playerHP <= 0) {
      playerDeadAt = performance.now();
      const hp = point ?? player.group.position.clone().add(new THREE.Vector3(0, capsuleMid(CAPSULE_FOR_POSE[playerWound]), 0));
      const hd = dir ?? new THREE.Vector3(0, 0, 1);
      let ragdolled = false;
      try {
        if (playerDoll) { playerDoll.hit(hp, hd, 8); ragdolled = true; }
      } catch { /* fall through to authored */ }
      try { (player as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      if (!ragdolled) {
        const fell = playDeathFall(player, hd, playerWound);
        if (fell) playerFallVariant = fell;
        else {
          try { player.setFall(true); } catch { /* noop */ }
          try { (player as unknown as CowboyGlb).playClip?.("defeat"); } catch { /* noop */ }
        }
      }
      killByFoe = true;
      cue.textContent = "HIT — YOU'RE DOWN";
      maybeEnd();
    } else {
      cue.textContent = `FOE HITS −${dmg.toFixed(0)}`;
    }
  }

  /** Central round-resolution: double-KO → hell, else series/home routing. */
  function maybeEnd(): void {
    if (roundOver) return;
    const foeDead = foeHP <= 0;
    const playerDead = playerHP <= 0;
    const now = performance.now();
    // Hell trigger (locked): both dead AND both killing blows were lethal
    // in-flight bullets fired before death. Lethality is recorded on the
    // bullet at fire time; the window covers crossing shots (~0.2s flight).
    if (foeDead && playerDead && killByPlayer && killByFoe) {
      if (Math.abs(foeDeadAt - playerDeadAt) < 900) {
        roundOver = true;
        endRound("DOUBLE KO!", "The ground opens…", "draw", true);
        return;
      }
    }
    if (foeDead || playerDead) {
      // wait for in-flight bullets to land before closing (they may force hell)
      const live = sim.bullets.some((b) => b.alive);
      if (live && !(foeDead && playerDead)) {
        window.setTimeout(() => { if (!roundOver) maybeEnd(); }, 350);
        // but don't hang forever: resolve ammo-out below anyway
        if (foeDead && playerDead) { roundOver = true; endRound("DOUBLE KO!", "The ground opens…", "draw", true); return; }
        if (foeDead || playerDead) {
          // give bullets 600ms max, then resolve
          window.setTimeout(() => {
            if (roundOver) return;
            if (foeHP <= 0 && playerHP <= 0) { roundOver = true; endRound("DOUBLE KO!", "The ground opens…", "draw", true); }
            else if (foeHP <= 0) { roundOver = true; endFoeDown(); }
            else if (playerHP <= 0) { roundOver = true; endRound("YOU'RE DOWN", "The foe takes it.", "f"); }
          }, 650);
          // immediate resolve for single death with no crossing bullet
          const otherLive = sim.bullets.some((b) => b.alive && ((foeDead && b.shooter === "foe" && b.lethal) || (playerDead && b.shooter === "player" && b.lethal)));
          if (!otherLive) {
            roundOver = true;
            if (foeDead) endFoeDown();
            else endRound("YOU'RE DOWN", "The foe takes it.", "f");
          }
          return;
        }
      }
      roundOver = true;
      if (foeDead && playerDead) endRound("DOUBLE KO!", "The ground opens…", "draw", true);
      else if (foeDead) endFoeDown();
      else endRound("YOU'RE DOWN", "The foe takes it.", "f");
      return;
    }
    // Ammo-out with no live bullets → higher HP wins (locked).
    void now;
    const anyLive = sim.bullets.some((b) => b.alive);
    if (!anyLive && ammo <= 0 && (foeAmmo <= 0 || mode === "tutorial")) {
      roundOver = true;
      if (hellRound) {
        // Hell loops on both-miss until someone hits (locked).
        endRound("BOTH MISS — AGAIN!", "Hell wants blood. 1 bullet each.", "draw", false);
        return;
      }
      if (playerHP === foeHP) endRound("DRAW — REPLAY", "Same HP.", "draw", false);
      else if (playerHP > foeHP) endRound("OUT OF AMMO — YOU TAKE IT", "Higher HP wins.", "p");
      else endRound("OUT OF AMMO — LOST", "Higher HP wins.", "f");
    }
  }

  /** Player-win cue: the tutorial used to call every kill a headshot. */
  function endFoeDown(): void {
    if (foeHeadshot) endRound(mode === "tutorial" ? "HEADSHOT! NICE." : "FOE DOWN!", "Headshot.", "p");
    else endRound(mode === "tutorial" ? "HIT — DOWN!" : "FOE DOWN!", "Body damage.", "p");
  }

  function endRound(text: string, subText: string, result: "p" | "f" | "draw", toHell = false): void {
    adapter.gameplayStop();
    // Round over: hand back the OS cursor. The crosshair freezes once the
    // round resolves, and `in-duel` hides the cursor with !important, so the
    // revive overlay (token / buy / ad / stay down) had no pointer at all.
    document.body.classList.remove("in-duel");
    cross.style.display = "none";
    cue.textContent = text;
    sub.textContent = subText;
    // Real gold flow (Slice 7): flat win + consolation + kill bonus.
    const prog = adapter.loadProgress();
    const won = result === "p";
    if (won) {
      prog.gold += (mode === "deathmatch" ? GOLD_WIN_DEATHMATCH : GOLD_WIN_BESTOF) + (killByPlayer ? GOLD_KILL_BONUS : 0);
      if (gun.extra === "gold") prog.gold += Math.ceil(GOLD_KILL_BONUS * gun.extraValue);
      if (run) prog.bestStreak = Math.max(prog.bestStreak, run.streak + 1);
      else prog.bestBestOf = Math.max(prog.bestBestOf, (series?.pWins ?? 0) + 1);
    } else if (result === "f") {
      prog.gold += GOLD_LOSS_CONSOLATION;
    }
    adapter.saveProgress(prog);
    // Resolve poses: Blender clip when shipped (the resolve freeze lets it own
    // the arms), procedural gun-skyward fallback for a clipless victor. The
    // victor raises, a surviving loser slumps, a draw slumps both. Never on a
    // corpse: the mixer updates after doll.sync(), so a clip re-posed the
    // ragdolled arm (revolver stuck up out of the body). The foe used to
    // play "defeat" for its own win (clip picked by the PLAYER's result).
    const resolvePose = (c: Cowboy, hp: number, doll: Ragdoll | null, clip: "victory" | "defeat"): void => {
      if (hp <= 0 || doll?.fallen) return;
      try {
        const g = c as unknown as CowboyGlb;
        if (g.hasClip?.(clip)) g.playClip(clip);
        else if (clip === "victory") c.armR.rotation.x = -0.9;
      } catch { /* noop */ }
    };
    resolvePose(player, playerHP, playerDoll, result === "p" ? "victory" : "defeat");
    resolvePose(foe, foeHP, foeDoll, result === "f" ? "victory" : "defeat");

    // Revive offer (Slice 7): player lost, token held or buyable, once/game.
    if (result === "f" && !reviveUsed && mode !== "tutorial") {
      offerRevive(() => {
        // accepted: same round, Focus restart, player 1HP + foe full (locked §6)
        cleanup();
        runDuel(root, adapter, mode, audio, series, hellRound, true, { run, startHP: 1 });
      }, () => routeAfter(result, toHell));
      return;
    }
    routeAfter(result, toHell);
  }

  function routeAfter(result: "p" | "f" | "draw", toHell: boolean): void {
    window.setTimeout(() => {
      if (!alive) return;
      if (toHell) {
        cleanup();
        runDuel(root, adapter, mode, audio, series, true, reviveUsed, { run });
        return;
      }
      if (hellRound) {
        // hell resolved (or both-miss loop)
        if (result === "draw") { cleanup(); runDuel(root, adapter, mode, audio, series, true, reviveUsed, { run }); return; }
        if (run) { cleanup(); continueRun(run, result); return; }
        // winner takes the point into the series
        if (series) {
          if (result === "p") series.pWins++; else series.fWins++;
          if (series.pWins >= FIRST_TO || series.fWins >= FIRST_TO) {
            cleanup();
            endSeries(result === "p");
            return;
          }
          series.roundIndex++;
          cleanup();
          runDuel(root, adapter, mode, audio, series, false, reviveUsed);
          return;
        }
        cleanup();
        showHome(root, adapter, audio);
        return;
      }
      if (run) { cleanup(); continueRun(run, result); return; }
      if (series) {
        if (result === "p") series.pWins++; else if (result === "f") series.fWins++;
        else { series.roundIndex++; cleanup(); runDuel(root, adapter, mode, audio, series, false, reviveUsed); return; }
        paintRound();
        if (series.pWins >= FIRST_TO || series.fWins >= FIRST_TO) {
          cleanup();
          endSeries(series.pWins > series.fWins);
          return;
        }
        series.roundIndex++;
        cleanup();
        runDuel(root, adapter, mode, audio, series, false, reviveUsed);
        return;
      }
      cleanup();
      if (result === "p") showHome(root, adapter, audio);
      else if (result === "f") showHome(root, adapter, audio);
      else runDuel(root, adapter, mode, audio, undefined, false, reviveUsed);
    }, 1500);
  }

  /** Deathmatch: a win heals 10% of max HP and moves on (next roster
      profile, harder each loop), a same-HP ammo-out replays the duel at the
      HP carried, a loss ends the run. */
  function continueRun(r: DeathRun, result: "p" | "f" | "draw"): void {
    if (result === "f") { endRun(r.streak); return; }
    if (result === "p") {
      r.streak++;
      r.hp = Math.min(BASE_HP, playerHP + DEATHMATCH_WIN_HEAL);
    } else {
      r.hp = Math.max(1, playerHP);
    }
    runDuel(root, adapter, mode, audio, undefined, false, reviveUsed, { run: r });
  }

  function endRun(streak: number): void {
    root.innerHTML = "";
    document.body.classList.remove("in-duel");
    document.body.style.background = "";
    const best = adapter.loadProgress().bestStreak;
    const s = el(`<div class="menu"><h1>RUN OVER</h1>
      <div class="note">Deathmatch streak: ${streak} · best ${best}</div>
      <button class="primary" data-b="again">NEW RUN</button>
      <button data-b="home">HOME</button></div>`);
    root.appendChild(s);
    s.querySelector("[data-b=again]")!.addEventListener("click", () => runDeathmatch(root, adapter, audio));
    s.querySelector("[data-b=home]")!.addEventListener("click", () => showHome(root, adapter, audio));
  }

  function endSeries(won: boolean): void {
    root.innerHTML = "";
    document.body.classList.remove("in-duel");
    document.body.style.background = "";
    const s = el(`<div class="menu"><h1>${won ? "VICTORY!" : "DEFEAT"}</h1>
      <div class="note">Best of ${BEST_OF} · final ${series?.pWins ?? 0} – ${series?.fWins ?? 0}</div>
      <button class="primary" data-b="again">REMATCH</button>
      <button data-b="home">HOME</button></div>`);
    root.appendChild(s);
    s.querySelector("[data-b=again]")!.addEventListener("click", () => runSeries(root, adapter, mode, audio));
    s.querySelector("[data-b=home]")!.addEventListener("click", () => showHome(root, adapter, audio));
  }

  function offerRevive(onAccept: () => void, onDecline: () => void): void {
    const p = adapter.loadProgress();
    const price = reviveDeathPrice(SHOP_PRICES.revive);
    const hasToken = p.reviveToken >= 1;
    const canBuy = p.gold >= price;
    if (!hasToken && !canBuy && adapter.kind !== "full") { onDecline(); return; }
    const ov = el(`<div class="revive" style="position:absolute;left:50%;top:58%;transform:translate(-50%,-50%);background:rgba(20,10,5,.92);border:2px solid #d4af37;border-radius:12px;padding:16px 20px;color:#ffe9bd;text-align:center;z-index:20;">
      <div style="font-weight:800;letter-spacing:.1em;">REVIVE? — 1HP, SAME ROUND REST bloomS FRESH</div>
      <div style="font-size:13px;opacity:.9;margin:6px 0;">${hasToken ? "Use your token (once per game)." : `Emergency buy ${price}g (1.5× shop).`}</div>
      <div><button data-r="yes">${hasToken ? "USE TOKEN" : `BUY + REVIVE (${price}g)`}</button>
      ${adapter.kind === "full" ? `<button data-r="ad">WATCH AD INSTEAD</button>` : ``}
      <button data-r="no">STAY DOWN</button></div>
    </div>`);
    root.appendChild(ov);
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; ov.remove(); fn(); };
    // ai-play never clicks revive: auto-decline so bots + QA flow through.
    const timer = window.setTimeout(() => finish(onDecline), 4000);
    ov.querySelector("[data-r=yes]")!.addEventListener("click", () => {
      window.clearTimeout(timer);
      const q = adapter.loadProgress();
      if (hasToken) q.reviveToken = 0;
      else {
        if (q.gold < price) { finish(onDecline); return; }
        q.gold -= price;
      }
      q.reviveToken = 0;
      adapter.saveProgress(q);
      finish(onAccept);
    });
    const adBtn = ov.querySelector("[data-r=ad]");
    if (adBtn) adBtn.addEventListener("click", async () => {
      window.clearTimeout(timer);
      const ok = await adapter.requestRewarded("revive");
      if (ok) finish(onAccept);
      else finish(onDecline);
    });
    ov.querySelector("[data-r=no]")!.addEventListener("click", () => { window.clearTimeout(timer); finish(onDecline); });
  }

  // ---- firing (true projectiles) ----
  function playerDirFromClick(cx: number, cy: number, muzzle: THREE.Vector3): THREE.Vector3 {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const target = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(aimPlane, target)) target.copy(stage.foe).add(new THREE.Vector3(0, capsuleMid(CAPSULE_FOR_POSE[foeWound]), 0));
    // bloom spread as an angular offset on the bullet dir (seeded, locked)
    const spread = machine.sampleSpread();
    const toAim = camera.position.distanceTo(aimWorld);
    const sx = (spread.dx * toAim) / 40;
    const sy = (spread.dy * toAim) / 40;
    const dir = target.clone().sub(muzzle);
    dir.x += sx;
    dir.y += sy;
    return dir.normalize();
  }

  function attemptFire(cx: number, cy: number): void {
    if (roundOver) return;
    if (machine.phase !== "draw" && machine.phase !== "fire") return;
    if (ammo <= 0) return;
    const now = performance.now();
    if (now - lastShotAt < gun.cooldownMs) {
      cross.classList.add("cooling");
      window.setTimeout(() => cross.classList.remove("cooling"), 120);
      return;
    }
    lastShotAt = now;
    kickT = 0;
    machine.phase = "fire";
    ammo -= 1;
    machine.applyRecoil(gun.recoilAddDeg);
    audio.playGunshotSynth(0.85);
    paintBars();

    const muzzle = player.gunTip.getWorldPosition(new THREE.Vector3());
    muzzle.y = Math.max(muzzle.y, 0.12); // prone muzzle can sit at the dirt line
    const dir = playerDirFromClick(cx, cy, muzzle);
    showSpreadCross(cx, cy);
    gunsmoke.spawn(muzzle);
  // Lethal-if-it-hits at fire time (locked double-KO rule): head always
  // lethal; body lethal iff post-falloff damage >= foe HP now.
  const { head } = foeScreen();
    const dHead = Math.hypot(cx - head.x, cy - head.y);
    const headAim = dHead <= 90;
    const lethal = headAim || bodyDamage(gun.baseDamage, distM) >= foeHP;
    const b = sim.fire({ from: muzzle, dir, distM, shooter: "player", gunId: gun.id, lethal });
    if (b) {
      showBullet(b);
      transport.send({ type: "Fire", tick: machine.tick, pos: [muzzle.x, muzzle.y, muzzle.z], dir: [dir.x, dir.y, dir.z], gunId: gun.id });
    }
    if (ammo <= 0) maybeEnd();
  }

  // ---- AI fire (Slice 2): same projectile path, symmetric ----
  function scheduleFoe(): void {
    if (mode === "tutorial") return; // dummy stays passive
    const ai = AI_ROSTER[clamp(rIdx, 0, AI_ROSTER.length - 1)];
    // Hasted AI (user-tuned): 0.85× reaction, quicker follow-ups. Damage and
    // accuracy untouched — duels get fiercer, not cheaper.
    const reaction = Math.max(180, ai.reactionBaseMs * 0.85 * Math.pow(0.97, rIdx) * Math.pow(0.94, level));
    let shots = 0;
    const maxShots = foeAmmo;
    const shootOnce = () => {
      if (!alive || roundOver) return;
      if (machine.phase !== "draw" && machine.phase !== "fire") return;
      if (foeHP <= 0 || playerHP <= 0) return;
      if (shots >= maxShots) return;
      shots++;
      foeAmmo--;
      paintBars();
      // focusQuality shrinks the foe's bloom like simulated taps
      const shrink = (gun.bloomStartDeg - gun.bloomMinDeg) * ai.focusQuality;
      const errScale = ai.accuracyMult * (distM / 11);
      const muzzle = foe.gunTip.getWorldPosition(new THREE.Vector3());
      muzzle.y = Math.max(muzzle.y, 0.12); // prone muzzle can sit at the dirt line
      // Aim at the (possibly wounded/lowered) player capsule mid, preserving
      // the old +0.12 bias above mid that the 1.35 constant encoded.
      const pMid = capsuleMid(CAPSULE_FOR_POSE[playerWound]) + 0.12;
      const target = stage.player.clone().add(new THREE.Vector3(gauss() * 0.35 * errScale, pMid + gauss() * 0.3 * errScale, 0));
      // apply un-shrunk remainder as extra error so weak AI actually misses
      target.x += gauss() * (1 - ai.focusQuality) * 0.5;
      target.y += gauss() * (1 - ai.focusQuality) * 0.4;
      const dir = target.sub(muzzle).normalize();
      gunsmoke.spawn(muzzle);
      audio.playGunshotSynth(0.5);
      foeKickT = 0; // procedural shooting anim: gun-kick decay in frame loop
      const lethal = bodyDamage(GUNS.default.baseDamage, distM) >= playerHP;
      const b = sim.fire({ from: muzzle, dir, distM, shooter: "foe", gunId: "default", lethal });
      if (b) {
        showBullet(b);
        transport.send({ type: "Fire", tick: machine.tick, pos: [muzzle.x, muzzle.y, muzzle.z], dir: [dir.x, dir.y, dir.z], gunId: "default" });
      }
      void shrink;
      if (shots < maxShots) {
        foeTimers.push(window.setTimeout(shootOnce, GUNS.default.cooldownMs + 150 + Math.random() * 350));
      }
    };
    foeTimers.push(window.setTimeout(shootOnce, reaction));
  }

  /** Per-substep projectile integration + capsule collision.
      Bullets fly 110m/s = 1.83m per 60Hz step, but the head sphere is only
      0.68m across — a single step tunnels clean through it. 8 substeps move
      0.23m each (< head radius), so nothing can skip the capsule test. */
  const BULLET_SUBSTEPS = 8;
  function stepBullets(): void {
    bulletsBeginStep();
    for (let s = 0; s < BULLET_SUBSTEPS; s++) {
      sim.step(STEP / BULLET_SUBSTEPS);
      checkBulletHits();
      if (roundOver && !sim.bullets.some((b) => b.alive)) break;
    }
    bulletsEndStep();
  }

  function checkBulletHits(): void {
    for (const b of sim.bullets) {
      if (!b.alive) continue;
      if (b.shooter === "player" && foeHP > 0) {
        const r = testCapsuleHit(b.pos, stage.foe, CAPSULE_FOR_POSE[foeWound]);
        if (r.head || r.body) {
          sim.kill(b);
          const point = new THREE.Vector3(r.point[0], r.point[1], r.point[2]);
          const dir = new THREE.Vector3(b.vel[0], b.vel[1], b.vel[2]).normalize();
          transport.send({ type: "Hit", tick: machine.tick, head: r.head, damage: r.head ? 999 : bodyDamage(gun.baseDamage, distM) });
          if (r.head) { killFoe(true, point, dir); }
          else {
            const dmg = bodyDamage(gun.baseDamage, distM);
            if (dmg >= foeHP) killFoe(false, point, dir);
            else woundFoe(dmg);
          }
        }
      } else if (b.shooter === "foe" && playerHP > 0) {
        const r = testCapsuleHit(b.pos, stage.player, CAPSULE_FOR_POSE[playerWound]);
        if (r.head || r.body) {
          sim.kill(b);
          const point = new THREE.Vector3(r.point[0], r.point[1], r.point[2]);
          const dir = new THREE.Vector3(b.vel[0], b.vel[1], b.vel[2]).normalize();
          transport.send({ type: "Hit", tick: machine.tick, head: r.head, damage: r.head ? 999 : bodyDamage(GUNS.default.baseDamage, distM) });
          if (r.head) hitPlayer(true, 999, point, dir);
          else {
            const dmg = bodyDamage(GUNS.default.baseDamage, distM);
            hitPlayer(false, dmg, point, dir);
          }
        }
      }
    }
  }

  function focusPenalty(): void {
    cross.classList.add("penalty");
    window.setTimeout(() => cross.classList.remove("penalty"), 180);
  }
  function qtePress(): void {
    if (machine.phase !== "focus" || machine.paused) return;
    const res = qte.press(qteExtra());
    if (!res) return; // still showing the last result
    machine.addQte(res);
    focusUI.flash(res);
    if (res === "miss") focusPenalty();
  }
  const focusUI: FocusUI = mountFocusUI(root, { onPress: qtePress });
  focusUI.render({ needle: qte.pos, zoneC: qte.zoneC, zoneW: qte.zoneW, perfectW: qte.perfectW, streak: 0 });

  // ---- input routing ----
  const touchDown = new Map<number, { x: number; y: number; t: number; moved: boolean }>();

  const onMouseMove = (e: MouseEvent) => {
    pointerPx.x = e.clientX;
    pointerPx.y = e.clientY;
    if (machine.phase === "ready") {
      if (inZone(e.clientX, e.clientY)) beginFocus();
    } else if (machine.phase === "draw" || machine.phase === "fire") {
      aimFromClient(e.clientX, e.clientY);
    }
  };
  window.addEventListener("mousemove", onMouseMove);

  const onPointerDown = (e: PointerEvent) => {
    const t = e.target as HTMLElement;
    if (t.closest?.("button")) return;
    const zx = e.clientX;
    const zy = e.clientY;
    pointerPx.x = zx;
    pointerPx.y = zy;

    if (machine.phase === "ready") {
      if (t.closest?.(".readyzone") || inZone(zx, zy)) beginFocus();
      else if (!coarse) {
        // PC click elsewhere pre-focus: gentle hint, no penalty.
        sub.textContent = coarse ? sub.textContent : "Mouse INTO the holster zone first";
      }
      return;
    }
    if (machine.phase === "focus") {
      // Touch: any tap is a QTE press. PC: the press is Space/Enter; a
      // click is a miss (grows bloom), the mouse belongs in the holster.
      if (coarse) qtePress();
      else {
        machine.addMiss();
        focusUI.flash("miss");
        focusPenalty();
      }
      return;
    }
    // draw / fire
    if (e.pointerType === "mouse") {
      pointerPx.x = zx;
      pointerPx.y = zy;
      aimFromClient(zx, zy);
      if (e.button === 0) attemptFire(zx, zy);
      return;
    }
    // touch: first finger aims (drag), quick tap or 2nd finger fires.
    pointerPx.x = zx;
    pointerPx.y = zy;
    if (touchDown.size > 0) {
      aimFromClient(zx, zy);
      attemptFire(zx, zy);
      return;
    }
    touchDown.set(e.pointerId, { x: zx, y: zy, t: performance.now(), moved: false });
    aimFromClient(zx, zy);
  };
  root.addEventListener("pointerdown", onPointerDown);

  const onPointerMove = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    pointerPx.x = e.clientX;
    pointerPx.y = e.clientY;
    const rec = touchDown.get(e.pointerId);
    if (!rec) return;
    if (Math.hypot(e.clientX - rec.x, e.clientY - rec.y) > 14) rec.moved = true;
    if (machine.phase === "draw" || machine.phase === "fire") {
      aimFromClient(e.clientX, e.clientY);
    }
  };
  root.addEventListener("pointermove", onPointerMove);

  const onPointerUp = (e: PointerEvent) => {
    if (e.pointerType !== "touch") return;
    const rec = touchDown.get(e.pointerId);
    touchDown.delete(e.pointerId);
    if (!rec) return;
    const quick = performance.now() - rec.t < 350;
    const still = Math.hypot(e.clientX - rec.x, e.clientY - rec.y) < 16;
    if (quick && !still && (machine.phase === "draw" || machine.phase === "fire")) {
      // tap (no drag): fire where it landed.
      aimFromClient(e.clientX, e.clientY);
      attemptFire(e.clientX, e.clientY);
    }
  };
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);

  function cleanup(): void {
    alive = false;
    document.body.classList.remove("in-duel");
    document.body.style.background = "";
    for (const t of foeTimers) window.clearTimeout(t);
    try { if (hellDispose) hellDispose(); } catch { /* noop */ }
    try { if (playerDoll) playerDoll.dispose(); } catch { /* noop */ }
    try { if (foeDoll) foeDoll.dispose(); } catch { /* noop */ }
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("resize", onResize);
    vv?.removeEventListener("resize", onResize);
    root.removeEventListener("pointerdown", onPointerDown);
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", onPointerUp);
    root.removeEventListener("pointercancel", onPointerUp);
    focusUI.destroy();
    cancelAnimationFrame(raf);
    renderer.dispose();
  }

  function onResize(): void {
    fitCamera();
    updateZone();
  }
  window.addEventListener("resize", onResize);
  // Browser zoom / pinch fires visualViewport.resize, not window.resize —
  // re-fit there too so zooming never moves the zone, HUD, or framing.
  const vv = window.visualViewport;
  vv?.addEventListener("resize", onResize);

  // Follow chain (distal intent, proximal motion): the gun tracks the aim,
  // the elbow articulates to support the gun, the shoulder carries the gross
  // motion to support the elbow. Shoulder chases a fixed 70% share (so it
  // always visibly swings), elbow chases the residual fast (so the joint
  // visibly flexes/extends through every move). Net muzzle converges to
  // theta exactly. All delta-time damped. Joint names untouched (GLB seam).
  function poseArm(thetaWorld: number, dt: number, kick: number): void {
    // Aim angle is world-space; the shoulder mount (stabilizeArm) already
    // cancels any wound lean, so it applies as-is.
    const theta = thetaWorld;
    const slow = 1 - Math.exp(-dt * 10); // shoulder follows elbow
    const fast = 1 - Math.exp(-dt * 20); // elbow follows gun
    player.armR.rotation.x += (clamp(theta * 0.7, -0.6, 1.0) + kick + armLift(player) - player.armR.rotation.x) * slow;
    const elbowTarget = clamp(theta - player.armR.rotation.x, -0.9, 0.6);
    player.elbowR.rotation.x += (elbowTarget - player.elbowR.rotation.x) * fast;
  }

  // Holster pull: hand drops to the hip holster, draws, sweeps up past level
  // with a flourish overshoot, settles level. Returns [shoulderX, elbowX].
  function drawChoreo(t: number): { s: number; e: number } {
    const keys: Array<[number, number, number]> = [
      [0, 0.55, -0.25],
      [0.28, 0.95, -0.55],
      [0.55, -0.18, 0.12],
      [0.85, 0.05, 0.0],
    ];
    if (t <= 0) return { s: keys[0][1], e: keys[0][2] };
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i][0]) {
        const [t0, s0, e0] = keys[i - 1];
        const [t1, s1, e1] = keys[i];
        let u = (t - t0) / (t1 - t0);
        u = u * u * (3 - 2 * u); // smoothstep: no pops between phases
        return { s: s0 + (s1 - s0) * u, e: e0 + (e1 - e0) * u };
      }
    }
    return { s: 0.05, e: 0.0 };
  }

  // Direct joint chase for choreography + foe hold (any cowboy's joints).
  function chaseArm(sT: number, eT: number, dt: number, arm: THREE.Group, elbow: THREE.Group, kick = 0): void {
    const slow = 1 - Math.exp(-dt * 10);
    const fast = 1 - Math.exp(-dt * 20);
    // Overflow past the shoulder clamp goes to the elbow, so a pitched body
    // (crouch/prone) can still bring the gun level (sum stays unclamped).
    const sC = clamp(sT + kick, -0.9, 2.5); // upper bound leaves room for the lying-pose lift (armLift)
    arm.rotation.x += (sC - arm.rotation.x) * slow;
    elbow.rotation.x += (clamp(eT + (sT + kick - sC), -0.9, 0.6) - elbow.rotation.x) * fast;
  }

  // ---- frame loop (fixed 60Hz sim, render interpolates) ----
  const clock = new THREE.Clock();
  const stepper = createFixedStepper(STEP);
  let raf = 0;
  const shoulder = new THREE.Vector3();
  const aimDir = new THREE.Vector3();
  let swayT = 0;

  // Initial cue per device.
  cue.textContent = "HOLSTER UP";
  sub.textContent = coarse ? "TAP the holster zone to begin" : "Move your mouse INTO the holster zone";
  updateZone();

  function frame(): void {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(clock.getDelta(), 0.1);
    // ONE fixed clock for all physics (spec: consistent across 60/144/165Hz,
    // delta-time not frame count). Rendering interpolates by alpha below.
    const alpha = stepper.advance(dt, () => {
      machine.step(STEP);
      if (machine.phase === "focus" && !machine.paused) qte.advance(STEP);
      // Bloom after DRAW: holding without firing regrows it (locked 09-26
      // §1); once shooting, recoil recovery rewards pacing. Neither runs in
      // ready/focus: free shrink there drifted the crosshair gap + keybar
      // fill on mere hover, breaking the locked tap-only focus feel.
      if (machine.phase === "draw") machine.regrow(STEP);
      else if (machine.phase === "fire") machine.recover(STEP, gun.recoilRecoveryDegPerSec);
      stepBullets();
      // Corpse physics lives on the same fixed clock (null-safe).
      try { if (foeDoll?.fallen) foeDoll.fixedStep(STEP); } catch { /* fallback already fell */ }
      try { if (playerDoll?.fallen) playerDoll.fixedStep(STEP); } catch { /* noop */ }
    });
    // Render: live duelists shadow their pose into kinematic bodies every
    // frame so death starts from the exact live pose; corpses draw the
    // interpolated physics state; bullets likewise.
    try {
      if (foeDoll && !foeDoll.fallen) foeDoll.follow();
      else if (foeDoll?.fallen) foeDoll.sync(alpha);
    } catch { /* fallback already fell */ }
    try {
      if (playerDoll && !playerDoll.fallen) playerDoll.follow();
      else if (playerDoll?.fallen) playerDoll.sync(alpha);
    } catch { /* noop */ }
    renderBullets(alpha);
    qteAlpha = alpha;
    qteFrameMs = performance.now();
    try { (player as unknown as CowboyGlb).update?.(dt); } catch { /* noop */ }
    try { (foe as unknown as CowboyGlb).update?.(dt); } catch { /* noop */ }
    // idle sway (procedural no-op path mirrors Blender idle clip) with a
    // hit-jerk dip composed on top (procedural hit anim, 0.35s).
    swayT += dt;
    drawT += dt;
    foeKickT += dt;
    foeFlinchT += dt;
    playerFlinchT += dt;
    // The hit-reaction clip is one-shot but CLAMPS on its last frame, so it
    // kept overwriting the gun arm for the rest of the duel (aim + wound-pose
    // arm compensation were being overridden). Hand the arm back once the
    // 10-frame flinch (0.42s, ends settled at the raised pose) is over;
    // procedural chase resumes.
    if (!roundOver) {
      const FLINCH_END = 0.45;
      if (foeFlinchT >= FLINCH_END && foeFlinchT - dt < FLINCH_END && foeHP > 0 && !foeDoll?.fallen) {
        try { (foe as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      }
      if (playerFlinchT >= FLINCH_END && playerFlinchT - dt < FLINCH_END && playerHP > 0 && !playerDoll?.fallen) {
        try { (player as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      }
    }
    // Foe gun arm: holster-pull choreography first (~0.9s), then hold the
    // raise with decaying gun-kick. Stands down once resolved (clips own it).
    if (tracking && foeHP > 0 && !foeDoll?.fallen && !roundOver) {
      if (drawT < 0.9) {
        const c = drawChoreo(drawT);
        chaseArm(c.s + armLift(foe), c.e - armLift(foe), dt, foe.armR, foe.elbowR);
      } else {
        const fk = 0.3 * Math.exp(-foeKickT * 10);
        chaseArm(0.05 + armLift(foe), -armLift(foe), dt, foe.armR, foe.elbowR, fk);
      }
      foe.group.rotation.z = foeRoll - 0.03 * Math.exp(-foeKickT * 7); // firing rock over wound roll
    }
    const foeDip = foeFlinchT < 0.35 ? Math.sin((foeFlinchT / 0.35) * Math.PI) * 0.07 : 0;
    const playerDip = playerFlinchT < 0.35 ? Math.sin((playerFlinchT / 0.35) * Math.PI) * 0.07 : 0;
    // Wound poses: damped chase toward the lottery pose (bend/crouch/prone).
    // Feet stay planted (group-level pitch + y-drop only); corpses and the
    // dead are skipped inside woundStep so death hands off with no snap.
    [foeDrop, foeRoll] = woundStep(foe, foeWound, foeHP, foeDoll, dt, foeDrop, foeRoll);
    [playerDrop, playerRoll] = woundStep(player, playerWound, playerHP, playerDoll, dt, playerDrop, playerRoll);
    driveJoints(foe, foeWound, foeHP, foeDoll, dt);
    driveJoints(player, playerWound, playerHP, playerDoll, dt);
    if (!foeDoll?.fallen && foeHP > 0) foe.group.position.y = foeDrop + Math.sin(swayT * 2.1) * 0.012 - foeDip;
    if (!playerDoll?.fallen && playerHP > 0) player.group.position.y = playerDrop + Math.sin(swayT * 2.1 + 1.3) * 0.012 - playerDip;

    if (machine.phase === "focus") {
      // PC: the countdown only runs while the pointer stays in the holster
      // zone; leaving it restarts the whole Focus (3.0s, bloom, QTE) on
      // return (user ask 2026-10-05). Touch: committed once started.
      const engaged = coarse || inZone(pointerPx.x, pointerPx.y);
      if (!engaged && focusEngaged) {
        machine.resetFocus();
        qte.reset();
      }
      focusEngaged = engaged;
      machine.paused = !engaged;
      if (machine.paused) {
        cue.textContent = "⏸ HOLSTER!";
        sub.textContent = "Back INTO the holster zone · the countdown restarts";
      } else {
        const left = machine.focusTicksLeft() / 60;
        cue.textContent = `FOCUS! ${left.toFixed(1)}s`;
        sub.textContent = coarse ? "Tap when the line is in the gold" : "SPACE / ENTER when the line is in the gold · don't click";
      }
      focusUI.render({
        needle: qte.peek(machine.paused ? 0 : alpha * STEP), // out of the holster: frozen
        zoneC: qte.zoneC,
        zoneW: qte.zoneW,
        perfectW: qte.perfectW,
        streak: qte.streak,
      });
      focusUI.setProgress(1 - (machine.bloomDeg - gun.bloomMinDeg) / (gun.bloomStartDeg - gun.bloomMinDeg));
      // Crosshair lives where the pointer is — never pinned to the foe.
      // Aim itself stays parked (gun down) until DRAW.
      placeCross(pointerPx.x, pointerPx.y);
    } else if ((machine.phase === "draw" || machine.phase === "fire") && !tracking) {
      tracking = true;
      cue.textContent = hellRound ? "DRAW! — HELL (1 BULLET)" : "DRAW!";
      sub.textContent = coarse ? "Drag to aim · tap to fire!" : "Aim with mouse · click to fire!";
      focusUI.setVisible(false);
      zone.style.display = "none";
      foe.setRaised();
      // From DRAW the procedural choreography + aim own both gun arms. The
      // looping idle clip (keyed at the guns-down 0.55) was still rewriting
      // armR/elbowR every mixer update, so the chase only ever won a
      // dt-dependent fraction: the foe's gun sagged (0.22 vs 0.05 rad) and
      // the sag depended on the refresh rate.
      try { (foe as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      try { (player as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      drawT = 0; // holster-pull choreography runs for both duelists
      cross.style.display = "block";
      scheduleFoe();
    }

    if (tracking && !aimEngaged && !roundOver) {
      // Pre-engagement: crosshair glued to the pointer (as in Focus) — never
      // self-moves — while the hand pulls from the holster and sweeps up
      // through the choreography. First input blends straight into aim via
      // the damped chase (no snap).
      placeCross(pointerPx.x, pointerPx.y);
      kickT += dt;
      if (drawT < 0.9) {
        const c = drawChoreo(drawT);
        chaseArm(c.s + armLift(player), c.e - armLift(player), dt, player.armR, player.elbowR);
      } else {
        poseArm(0.0, dt, 0);
      }
    }

    if (tracking && aimEngaged && !roundOver) {
      // Aim chase: aimWorld glides toward the pointer-driven target every
      // frame (~20/s, delta-time safe), so the crosshair + gun travel in a
      // smooth motion to wherever the pointer moves — never a snap.
      aimWorld.lerp(aimTarget, 1 - Math.exp(-dt * 20));
      kickT += dt;
      const kick = 0.3 * Math.exp(-kickT * 10); // visible recoil kick (shooting anim)
      player.armR.getWorldPosition(shoulder);
      aimDir.copy(aimWorld).sub(shoulder);
      const horiz = Math.max(0.001, Math.hypot(aimDir.x, aimDir.z));
      const targetYaw = clamp(Math.atan2(aimDir.x, aimDir.z) - playerYaw, -0.7, 0.7);
      player.armR.rotation.y += (targetYaw - player.armR.rotation.y) * (1 - Math.exp(-dt * 14));
      poseArm(clamp(-Math.atan2(aimDir.y, horiz), -0.6, 1.0), dt, kick);
      player.group.rotation.z = playerRoll + 0.035 * Math.exp(-kickT * 7); // firing rock over wound roll

      const s = project(aimWorld);
      placeCross(s.x, s.y);
    }

    // Last pose write of the frame: body lean/roll (wound chase + firing rock)
    // is final, so the shoulder mount cancels exactly what renders.
    stabilizeArm(foe, foeHP, foeDoll);
    stabilizeArm(player, playerHP, playerDoll);

    gunsmoke.update(dt);
    street?.tick(performance.now() / 1000);
    renderer.render(scene, camera);
  }
  frame();
}
