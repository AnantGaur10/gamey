import * as THREE from "three";
import { createArena, stagePositions, faceToward, cssSkyForRound, createShadowDecal, setLowGraphics, type ShadowDecal } from "../render/arena";
import { createSway, type Sway } from "../render/sway";
import { createCowboy, paintGun, type Cowboy } from "../render/cowboy";
import { loadCowboyGlb, preloadCowboyGlb, swapCowboy, type CowboyGlb, type CowboyDims } from "../render/cowboyGlb";
import { loadStreetGlb, streetGlbReady, type StreetSet } from "../render/streetGlb";
import { allLoaded, loadFraction } from "../render/loadProgress";
import { loadMapSet, preloadSet, type MapSet } from "../render/setGlb";
import { MAPS, MAP_CHOICES, pickMap, mapLabel, isMapChoice, cssSky, type MapId, type MapChoice } from "../render/maps";
import { foeLookFor, pickSeriesFoe, FOE_LOOKS, type FoeLookId } from "../render/foes";
import { createGunsmoke } from "../render/smoke";
import { createAmbient } from "../render/ambient";
import { createFixedStepper, STEP, MAX_FRAME_DT } from "../game/fixedStep";
import { createRagdoll, bindAccessories, type Ragdoll } from "../render/ragdoll";
import { DuelMachine, type WoundPose } from "../game/DuelMachine";
import { bodyDamage, BASE_HP, LIFESTEAL_CAP_PER_HIT, DUEL_RANGE_MIN, DUEL_RANGE_MAX } from "../game/damage";
import { GUNS, AI_ROSTER, GOLD_WIN_BESTOF, GOLD_WIN_DEATHMATCH, GOLD_LOSS_CONSOLATION, GOLD_KILL_BONUS, reviveDeathPrice } from "../game/economy";
import { LEVELS, LEVEL_COUNT, playableLevel, levelAi, levelClearGold } from "../game/levels";
import { ProjectileSim, testCapsuleHit, predictHit, CAPSULE_FOR_POSE, capsuleMid, DEFAULT_HAT, type BulletState } from "../game/projectiles";
import { LocalTransport } from "../game/Transport";
import type { PortalAdapter } from "../portal/PortalAdapter";
import { mountFocusUI, isCoarsePointer, type FocusUI } from "./focus";
import { mountCoach, type Coach } from "./coach";
import { TimingQte } from "../game/timingQte";
import { quickDraw, gunOut, QD_END } from "../render/quickDraw";
import { showMenuScene, hideMenuScene, menuMapId } from "./menuScene";
import { storagePersisted } from "../store/SafeStore";
import { needsTutorial, markTutorialSeen } from "../portal/firstLaunch";
import { createAudioManager, type AudioManager } from "../audio/AudioManager";
import { initDeviceTier, deviceTier } from "../render/device";
import { randomCowboyName, cleanName, escapeHtml, displayName, NAME_MAX } from "./names";

export type Mode = "standard" | "deathmatch" | "tutorial";

const SHOTS_PER_DUEL = 6;
const BEST_OF = 3; // first to 2
const FIRST_TO = Math.ceil(BEST_OF / 2);
// Quick-draw arm path + timings: render/quickDraw.ts (cosmetic, time-based);
// the fire gate below is the gameplay rule, on the fixed clock.
/** Revive card: auto "stay down" after this (bots + QA flow through). */
const REVIVE_WAIT_MS = 4000;
/** A cold duel plays on the procedural stand-ins after this long (slow data). */
const LOAD_MAX_MS = 20000;
const DRAW_TICKS = 10; // 0.167s at 60Hz: no shot before the gun clears the holster
// Last known OS pointer (survives across rounds): a new round's crosshair
// starts where the mouse really is instead of a guessed screen point.
let lastPointer: { x: number; y: number } | null = null;

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
  initDeviceTier(adapter.deviceInfo()); // before the first canvas: sets its pixel-ratio ceiling
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
  // SETTINGS (user 2026-10-23): volumes + low graphics, before the first canvas.
  audio.setSfxVolume(progress.settings.sfx ?? 1);
  audio.setMusicVolume(MUSIC_BASE * (progress.settings.music ?? 1));
  setLowGraphics(progress.settings.quality === "low");

  // Auth Listener: a login / logout mid-session renames the player at once
  // (home re-renders; elsewhere every [data-pname] label is updated).
  adapter.onUserChange((account) => {
    // Logged out of an account that never had a guest name: give it one.
    if (!account && !adapter.loadProgress().playerName) {
      const p = adapter.loadProgress();
      p.playerName = randomCowboyName();
      adapter.saveProgress(p);
    }
    if (root.querySelector(".menu.home")) { showHome(root, adapter, audio); return; }
    const name = displayName(adapter);
    root.querySelectorAll<HTMLElement>("[data-pname]").forEach((e) => { e.textContent = name; });
    root.querySelector(".settings")?.dispatchEvent(new Event("userchange"));
  });

  adapter.loadingStop();

  // Tutorial-first for new players: the gateway into the game (user
  // 2026-10-12). In-gameplay, skippable; finishing or skipping it marks it
  // done, so it is never forced again (replay from the home menu / shop).
  // Who counts as new: src/portal/firstLaunch.ts.
  if (needsTutorial(adapter, progress)) {
    runDuel(root, adapter, "tutorial", audio);
  } else {
    // Players from before names (user 2026-10-23): a random one, renamed in
    // SETTINGS. A CrazyGames account name needs none.
    if (!adapter.getUser().name && !progress.playerName) {
      const p = adapter.loadProgress();
      p.playerName = randomCowboyName();
      adapter.saveProgress(p);
    }
    showHome(root, adapter, audio);
  }
}

/** Music level at 100% in SETTINGS (AudioManager's own default). */
const MUSIC_BASE = 0.5;

/** After the tutorial (finished or skipped): a guest without a name gets
    the name screen once; a CrazyGames account name is never asked for. */
function afterTutorial(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  if (adapter.getUser().name || adapter.loadProgress().playerName) showHome(root, adapter, audio);
  else showNamePrompt(root, adapter, audio);
}

/** Name screen (user 2026-10-23: "ask a name that is skippable"): prefilled
    with a random cowboy name, die = another one, OK / Enter keeps what is
    typed, SKIP keeps the random one. */
function showNamePrompt(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  root.innerHTML = "";
  document.body.classList.remove("in-duel");
  document.body.style.background = "";
  const prog = adapter.loadProgress();
  showMenuScene(isMapChoice(prog.settings.map) ? prog.settings.map : "random", prog.equippedGun, { calm: true });
  let suggested = randomCowboyName();
  const page = el(`<div class="nameprompt">
    <h2>WHAT DO THEY CALL YOU, PARTNER?</h2>
    <div class="namefield">
      <input type="text" maxlength="${NAME_MAX}" autocomplete="off" spellcheck="false" aria-label="Your name" value="${escapeHtml(suggested)}">
      <button class="namedie" data-n="roll" title="Another name">${DICE_ICON}</button>
    </div>
    <div class="namebtns">
      <button class="namebtn primary" data-n="ok">OK</button>
      <button class="namebtn" data-n="skip">SKIP</button>
    </div>
  </div>`);
  root.appendChild(page);
  const input = page.querySelector<HTMLInputElement>("input")!;
  const done = (name: string): void => {
    const p = adapter.loadProgress();
    p.playerName = name;
    adapter.saveProgress(p);
    showHome(root, adapter, audio);
  };
  page.querySelector("[data-n=roll]")!.addEventListener("click", () => {
    suggested = randomCowboyName();
    input.value = suggested;
  });
  page.querySelector("[data-n=ok]")!.addEventListener("click", () => done(cleanName(input.value) ?? suggested));
  page.querySelector("[data-n=skip]")!.addEventListener("click", () => done(suggested));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); done(cleanName(input.value) ?? suggested); }
  });
  // Desktop only: a phone would open its keyboard over the screen.
  if (!isCoarsePointer()) { input.focus({ preventScroll: true }); input.select(); }
}

// Home (user 2026-10-14: "modern but keep the cowboy aspects", options
// bottom-left like most games): live showdown behind (ui/menuScene.ts),
// title top-left, options stacked bottom-left, gold + sound top-right.
// Arrow keys / W-S move between options; Enter / Space press (no Esc).
const SPEAKER_ON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16 8.5a5 5 0 0 1 0 7M18.5 6a8.5 8.5 0 0 1 0 12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const SPEAKER_OFF = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9h4l5-4v14l-5-4H4z" fill="currentColor"/><path d="M16.5 9.5l5 5M21.5 9.5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>`;
const COIN_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="#e8b43a" stroke="#6b4a10" stroke-width="1.6"/><circle cx="12" cy="12" r="7" fill="none" stroke="#8a6414" stroke-width="1.2"/><path d="M12 7.2l1.4 2.9 3.2.4-2.3 2.2.6 3.2L12 14.4l-2.9 1.5.6-3.2-2.3-2.2 3.2-.4z" fill="#8a6414"/></svg>`;
const STAR_ICON = `<svg viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30" fill="#2b1a10" stroke="#d4af37" stroke-width="3"/><path d="M32 8l6.2 13.4 14.7 1.7-10.9 10 2.9 14.5L32 40.3l-12.9 7.3 2.9-14.5-10.9-10 14.7-1.7z" fill="#ffd678" stroke="#8a6414" stroke-width="2" stroke-linejoin="round"/><g fill="#ffd678" stroke="#8a6414" stroke-width="1.5"><circle cx="32" cy="8" r="3"/><circle cx="52.9" cy="23.1" r="3"/><circle cx="44.9" cy="47.6" r="3"/><circle cx="19.1" cy="47.6" r="3"/><circle cx="11.1" cy="23.1" r="3"/></g></svg>`;

export function showHome(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  audio.playMusic('home-screen');
  root.innerHTML = "";
  const progress = adapter.loadProgress();
  // MAP option (user 2026-10-12) opens the picker screen (showMapPicker);
  // the choice is saved with the progress, and a series or run rolls
  // "Random" once at its start.
  const mapChoice: MapChoice = isMapChoice(progress.settings.map) ? progress.settings.map : "random";
  // Ladder (game/levels.ts): PLAY = the next unbeaten level; the backdrop's
  // next standoff shows that foe (its GLB is then cached for the duel).
  const lv = playableLevel(progress.level);
  const ladderDone = (progress.level ?? 0) >= LEVEL_COUNT;
  showMenuScene(mapChoice, progress.equippedGun, { foe: LEVELS[lv].foe });
  const base = import.meta.env.BASE_URL;
  const mapThumb = mapChoice === "random"
    ? `<span class="optthumb random">${DICE_ICON}</span>`
    : `<span class="optthumb"><img src="${base}maps/${mapChoice}.jpg" alt="" draggable="false"></span>`;
  const menu = el(`<div class="menu home">
    <div class="scrim"></div>
    <header class="brand">
      <span class="badge">${STAR_ICON}</span>
      <h1><span class="t1">HIGH NOON</span><span class="t2">DUEL</span></h1>
    </header>
    <nav class="opts">
      <button class="opt primary" data-m="standard"><span class="lbl">PLAY</span><small>${ladderDone ? `Ladder cleared · ${titleCase(LEVELS[lv].name)} again` : `Level ${lv + 1} of ${LEVEL_COUNT} · vs ${titleCase(LEVELS[lv].name)}`}</small></button>
      <button class="opt" data-m="deathmatch"><span class="lbl">DEATHMATCH</span><small>Duel after duel · one life</small></button>
      <button class="opt" data-m="map"><span class="lbl">MAP</span><small>${mapThumb}${mapLabel(mapChoice)}</small></button>
      <button class="opt" data-m="shop"><span class="lbl">ARMORY</span><small>Revolvers · revive token</small></button>
      <button class="opt" data-m="settings"><span class="lbl">SETTINGS</span><small>Name · sound · graphics</small></button>
      <button class="opt" data-m="tutorial"><span class="lbl">HOW TO PLAY</span><small>Tutorial</small></button>
    </nav>
    <div class="topbar">
      <button class="chip pname" title="Change name in Settings">${HAT_ICON}<b data-pname>${escapeHtml(displayName(adapter, progress))}</b></button>
      <span class="chip gold" title="Gold">${COIN_ICON}<b>${progress.gold}</b></span>
      <button class="mute-btn" title="Sound on / off"></button>
    </div>
    ${progress.bestStreak > 0 ? `<div class="record">BEST STREAK <b>${progress.bestStreak}</b></div>` : ""}
  </div>`);
  root.appendChild(menu);

  const muteBtn = menu.querySelector<HTMLButtonElement>(".mute-btn")!;
  const paintMute = () => {
    muteBtn.innerHTML = audio.isMuted() ? SPEAKER_OFF : SPEAKER_ON;
    muteBtn.classList.toggle("off", audio.isMuted());
  };
  paintMute();
  menu.querySelector(".chip.pname")!.addEventListener("click", () => showSettings(root, adapter, audio));
  muteBtn.addEventListener("click", () => {
    const p = adapter.loadProgress();
    p.settings.mute = audio.toggleMute();
    adapter.saveProgress(p);
    paintMute();
  });

  const opts = Array.from(menu.querySelectorAll<HTMLButtonElement>(".opt"));
  opts.forEach((b) => {
    b.addEventListener("click", () => {
      const m = b.dataset.m as Mode | "shop" | "map" | "settings";
      if (m === "map") showMapPicker(root, adapter, audio, mapChoice);
      else if (m === "settings") showSettings(root, adapter, audio);
      else if (m === "shop") showShop(root, adapter, audio);
      else if (m === "standard") runSeries(root, adapter, m, audio);
      else if (m === "deathmatch") runDeathmatch(root, adapter, audio);
      else runDuel(root, adapter, m, audio);
    });
    b.addEventListener("pointerenter", () => b.focus({ preventScroll: true }));
  });
  const onKey = (e: KeyboardEvent): void => {
    if (!menu.isConnected) { window.removeEventListener("keydown", onKey); return; }
    const dirKey = e.code === "ArrowDown" || e.code === "KeyS" ? 1 : e.code === "ArrowUp" || e.code === "KeyW" ? -1 : 0;
    if (!dirKey) return;
    e.preventDefault();
    const i = opts.indexOf(document.activeElement as HTMLButtonElement);
    opts[i < 0 ? (dirKey > 0 ? 0 : opts.length - 1) : (i + dirKey + opts.length) % opts.length].focus({ preventScroll: true });
  };
  window.addEventListener("keydown", onKey);
}

/** Settings (user 2026-10-23: "dim down sfx, music, change names, go to a
    lower graphics mode"). Every change saves at once; BACK returns home. A
    CrazyGames account name is shown read-only (account spec). */
function showSettings(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  root.innerHTML = "";
  const prog = adapter.loadProgress();
  const choice: MapChoice = isMapChoice(prog.settings.map) ? prog.settings.map : "random";
  showMenuScene(choice, prog.equippedGun);
  const pct = (v: number | undefined) => Math.round((v ?? 1) * 100);
  const page = el(`<div class="settings">
    <h2>SETTINGS</h2>
    <div class="setpanel">
      <div class="setrow"><span class="setlbl">NAME</span><div class="setname"></div></div>
      <label class="setrow"><span class="setlbl">SOUND FX</span><input type="range" min="0" max="100" step="5" data-s="sfx" value="${pct(prog.settings.sfx)}"><em>${pct(prog.settings.sfx)}%</em></label>
      <label class="setrow"><span class="setlbl">MUSIC</span><input type="range" min="0" max="100" step="5" data-s="music" value="${pct(prog.settings.music)}"><em>${pct(prog.settings.music)}%</em></label>
      <div class="setrow"><span class="setlbl">GRAPHICS</span><div class="setseg">
        <button data-q="high" aria-pressed="${prog.settings.quality !== "low"}">HIGH</button>
        <button data-q="low" aria-pressed="${prog.settings.quality === "low"}">LOW</button>
      </div></div>
    </div>
    <button class="mapback" data-b="back">BACK</button>
  </div>`);
  root.appendChild(page);

  const nameBox = page.querySelector<HTMLElement>(".setname")!;
  const paintName = (): void => {
    const account = adapter.getUser().name;
    if (account) {
      nameBox.innerHTML = `<b data-pname>${escapeHtml(account)}</b><small>from your CrazyGames account</small>`;
      return;
    }
    const cur = adapter.loadProgress().playerName ?? "";
    nameBox.innerHTML = `<div class="namefield">
        <input type="text" maxlength="${NAME_MAX}" autocomplete="off" spellcheck="false" aria-label="Your name" value="${escapeHtml(cur)}">
        <button class="namedie" data-n="roll" title="Random name">${DICE_ICON}</button>
        <button class="namebtn" data-n="save">SAVE</button>
      </div>${adapter.canLogin ? `<button class="setlogin" data-n="login">Log in with CrazyGames</button>` : ""}`;
    const input = nameBox.querySelector<HTMLInputElement>("input")!;
    const saveBtn = nameBox.querySelector<HTMLButtonElement>("[data-n=save]")!;
    const save = (): void => {
      const name = cleanName(input.value);
      if (!name) { input.value = adapter.loadProgress().playerName ?? ""; return; }
      const p = adapter.loadProgress();
      p.playerName = name;
      adapter.saveProgress(p);
      input.value = name;
      saveBtn.textContent = "SAVED";
      input.blur();
    };
    input.addEventListener("input", () => { saveBtn.textContent = "SAVE"; });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); save(); } });
    saveBtn.addEventListener("click", save);
    nameBox.querySelector("[data-n=roll]")!.addEventListener("click", () => { input.value = randomCowboyName(); save(); });
    nameBox.querySelector("[data-n=login]")?.addEventListener("click", () => adapter.requestLogin());
  };
  paintName();
  page.addEventListener("userchange", paintName);

  page.querySelectorAll<HTMLInputElement>("input[type=range]").forEach((r) => {
    const key = r.dataset.s as "sfx" | "music";
    const out = r.parentElement!.querySelector("em")!;
    r.addEventListener("input", () => {
      const v = Number(r.value) / 100;
      out.textContent = `${r.value}%`;
      if (key === "sfx") audio.setSfxVolume(v);
      else audio.setMusicVolume(MUSIC_BASE * v);
    });
    r.addEventListener("change", () => {
      const p = adapter.loadProgress();
      p.settings[key] = Number(r.value) / 100;
      adapter.saveProgress(p);
      if (key === "sfx") { audio.resumeAudioContext(); audio.playGunshotSynth(0.5); } // a sample at the new level
    });
  });

  const seg = Array.from(page.querySelectorAll<HTMLButtonElement>("[data-q]"));
  seg.forEach((b) => b.addEventListener("click", () => {
    const q = b.dataset.q as "low" | "high";
    const p = adapter.loadProgress();
    if (p.settings.quality === q) return;
    p.settings.quality = q;
    adapter.saveProgress(p);
    seg.forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    setLowGraphics(q === "low");
    // Rebuild the backdrop so the new mode shows now (duels pick it up anyway).
    const live = menuMapId();
    hideMenuScene();
    showMenuScene(live ?? choice, p.equippedGun);
  }));
  page.querySelector("[data-b=back]")!.addEventListener("click", () => showHome(root, adapter, audio));
}

const HAT_ICON = `<svg viewBox="0 0 32 24" aria-hidden="true"><path d="M9 14c0-6 2-11 7-11s7 5 7 11z" fill="#8a5a2b" stroke="#2b1a10" stroke-width="1.6" stroke-linejoin="round"/><path d="M9 12.5h14" stroke="#d4af37" stroke-width="2"/><path d="M2 15c4 3 24 3 28 0-1 4-6 6-14 6S3 19 2 15z" fill="#a8723a" stroke="#2b1a10" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

/** Random map card: a die on grey (user 2026-10-14). */
const DICE_ICON = `<svg class="mapdice" viewBox="0 0 100 100" aria-hidden="true"><path d="M50 8 88 28v44L50 92 12 72V28z" fill="#f4f1ea" stroke="#2a2a2a" stroke-width="4" stroke-linejoin="round"/><path d="M12 28 50 48 88 28M50 48v44" fill="none" stroke="#2a2a2a" stroke-width="4" stroke-linejoin="round"/><path d="M50 48 88 28v44L50 92z" fill="#d9d4c8"/><path d="M12 28 50 48v44L12 72z" fill="#e8e3d8"/><path d="M12 28 50 48 88 28M50 48v44M50 8 88 28v44L50 92 12 72V28z" fill="none" stroke="#2a2a2a" stroke-width="4" stroke-linejoin="round"/><g fill="#b3201c"><ellipse cx="50" cy="28" rx="6" ry="3.6"/><ellipse cx="34" cy="20.5" rx="4.6" ry="2.8"/><ellipse cx="66" cy="35.5" rx="4.6" ry="2.8"/></g><g fill="#2a2a2a"><circle cx="24" cy="48" r="4.2"/><circle cx="38" cy="72" r="4.2"/><circle cx="62" cy="58" r="4.2"/><circle cx="76" cy="44" r="4.2"/><circle cx="62" cy="80" r="4.2"/><circle cx="76" cy="66" r="4.2"/></g></svg>`;

/** Map picker (user 2026-10-14): a card per map with its picture (noon
    captures in public/maps/, fetched only when this screen opens) + RANDOM
    as a die on grey. Picking saves the choice and returns home. */
function showMapPicker(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager, current: MapChoice): void {
  root.innerHTML = "";
  showMenuScene(current, adapter.loadProgress().equippedGun);
  const base = import.meta.env.BASE_URL;
  const card = (c: MapChoice): string => {
    const pic = c === "random"
      ? `<span class="mappic random">${DICE_ICON}</span>`
      : `<span class="mappic"><img src="${base}maps/${c}.jpg" alt="" draggable="false"></span>`;
    return `<button class="mapcard${c === current ? " on" : ""}" data-map="${c}">${pic}<span class="mapname">${mapLabel(c)}</span></button>`;
  };
  const page = el(`<div class="mappick">
    <h2>CHOOSE YOUR MAP</h2>
    <div class="mapgrid">${MAP_CHOICES.map(card).join("")}</div>
    <button class="mapback" data-b="back">BACK</button>
  </div>`);
  root.appendChild(page);
  page.querySelectorAll<HTMLButtonElement>(".mapcard").forEach((b) => {
    b.addEventListener("click", () => {
      const c = b.dataset.map;
      if (!isMapChoice(c)) return;
      const progress = adapter.loadProgress();
      progress.settings.map = c;
      adapter.saveProgress(progress);
      showHome(root, adapter, audio);
    });
  });
  page.querySelector("[data-b=back]")!.addEventListener("click", () => showHome(root, adapter, audio));
}

/** Hat hit volume + silhouette width in use: the GLB's measured numbers,
    else the outlaw's (procedural stand-in before / without its GLB). */
const FALLBACK_DIMS: CowboyDims = { hat: DEFAULT_HAT, halfWidth: 0.46 };
function dimsOf(c: Cowboy): CowboyDims {
  return (c as Partial<CowboyGlb>).dims ?? FALLBACK_DIMS;
}

/** Shop icons (user 2026-10-14): revolvers in their finish (render/cowboy
    GUN_FINISH: lifesteal red, gold gold), the revive token as a first aid kit. */
function gunIcon(id: string): string {
  const metal = { lifesteal: "#c0281f", gold: "#e8b43a" }[id] ?? "#8a8f98";
  return `<svg class="sicon" viewBox="0 0 48 28" aria-hidden="true"><path d="M4 6h30v6H17l-1 3h-4l-2 9H3l3-12H4z" fill="${metal}" stroke="#1a0f06" stroke-width="1.5" stroke-linejoin="round"/><path d="M34 7h11v4H34z" fill="${metal}" stroke="#1a0f06" stroke-width="1.5"/><circle cx="21" cy="9" r="4.2" fill="${metal}" stroke="#1a0f06" stroke-width="1.5"/><path d="M6 14l-3 10h7l2-9z" fill="#6b3f1c" stroke="#1a0f06" stroke-width="1.5" stroke-linejoin="round"/></svg>`;
}
const AID_KIT_ICON = `<svg class="sicon" viewBox="0 0 48 36" aria-hidden="true"><path d="M17 8V4h14v4" fill="none" stroke="#1a0f06" stroke-width="5"/><path d="M17 8V4h14v4" fill="none" stroke="#e9e2d2" stroke-width="2.5"/><rect x="3" y="8" width="42" height="26" rx="4" fill="#f2ede3" stroke="#1a0f06" stroke-width="2"/><path d="M20 13h8v6h6v8h-6v6h-8v-6h-6v-8h6z" transform="translate(0 -2)" fill="#d22a20" stroke="#7a120c" stroke-width="1"/></svg>`;

/** Armory cards (user 2026-10-21): one card per revolver, stat bars
    straight from GUNS (damage, accuracy = the tightest Focus ring, fire
    rate = 1 / cooldown), perk line, BUY or a checkbox EQUIP button. */
const SHOP_GUNS: Array<{ id: "default" | "lifesteal" | "gold"; name: string; perk: string }> = [
  { id: "default", name: "STARTER", perk: "Hits hardest, fires fastest." },
  { id: "lifesteal", name: "LIFESTEAL", perk: `Every body hit heals ${GUNS.lifesteal.extraValue * 100}% of the damage (max ${LIFESTEAL_CAP_PER_HIT}).` },
  { id: "gold", name: "GOLD", perk: `+${Math.ceil(GOLD_KILL_BONUS * GUNS.gold.extraValue)} gold for every round you win.` },
];
const CHECK_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3.2L13 4.6" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

function gunCard(id: (typeof SHOP_GUNS)[number]["id"], name: string, perk: string, owned: boolean, equipped: boolean, price: number, afford: boolean): string {
  const g = GUNS[id];
  const tightest = Math.min(...SHOP_GUNS.map((s) => GUNS[s.id].bloomMinDeg));
  const acc = Math.round((100 * tightest) / g.bloomMinDeg);
  const rate = 1000 / g.cooldownMs;
  const bar = (label: string, frac: number, value: string) =>
    `<div class="gstat"><span>${label}</span><i><b style="width:${Math.round(Math.min(1, frac) * 100)}%"></b></i><em>${value}</em></div>`;
  const action = !owned
    ? `<button class="gbuy${afford ? "" : " poor"}" data-buy="${id}">BUY · ${price}g</button>`
    : `<button class="gequip" data-equip="${id}" role="checkbox" aria-checked="${equipped}"><span class="gbox">${equipped ? CHECK_ICON : ""}</span>${equipped ? "EQUIPPED" : "EQUIP"}</button>`;
  return `<div class="gcard g-${id}${equipped ? " on" : ""}">
    <div class="ghead">${gunIcon(id)}<span>${name}</span></div>
    ${bar("DAMAGE", g.baseDamage / 60, String(g.baseDamage))}
    ${bar("ACCURACY", acc / 100, String(acc))}
    ${bar("FIRE RATE", rate / 3, `${rate.toFixed(1)}/s`)}
    <div class="gperk">${perk}</div>
    ${action}
  </div>`;
}

function showShop(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  root.innerHTML = "";
  const p = adapter.loadProgress();
  showMenuScene(isMapChoice(p.settings.map) ? p.settings.map : "random", p.equippedGun);
  const can = (price: number) => p.gold >= price;
  const priceOf = (id: string) => (id === "lifesteal" ? SHOP_PRICES.lifesteal : id === "gold" ? SHOP_PRICES.gold : 0);
  const cards = SHOP_GUNS.map((s) => gunCard(s.id, s.name, s.perk, p.gunsOwned.includes(s.id), p.equippedGun === s.id, priceOf(s.id), can(priceOf(s.id)))).join("");
  const shop = el(`<div class="shop">
    <h2>ARMORY</h2>
    <div class="sgold">Gold: <b>${p.gold}</b></div>
    <div class="note">${storagePersisted() ? "" : "Won't save in private mode (inline note, never a popup)."}</div>
    <div class="gcards">${cards}</div>
    <div class="srow"><button data-b="buy-revive">${AID_KIT_ICON}REVIVE TOKEN · ${SHOP_PRICES.revive}g <small>held ${p.reviveToken}/1 · once per game</small></button></div>
    ${adapter.adsEnabled ? `<div class="srow"><button data-b="ad-gold">WATCH AD FOR +10g</button></div>` : ``}
    <div class="smsg"></div>
    <div class="srow"><button data-b="tutorial">REPLAY TUTORIAL</button><button data-b="back">BACK</button></div>
  </div>`);
  root.appendChild(shop);
  const msg = shop.querySelector(".smsg") as HTMLElement;
  const refresh = () => showShop(root, adapter, audio);
  const buy = (id: string, price: number) => {
    const q = adapter.loadProgress();
    if (q.gunsOwned.includes(id)) { msg.textContent = "Already owned — equip it."; return; }
    if (!can(price)) { msg.textContent = "Not enough gold — win duels first (never gated, starter is competitive)."; return; }
    q.gold -= price;
    q.gunsOwned.push(id);
    adapter.saveProgress(q);
    refresh();
  };
  shop.querySelectorAll<HTMLElement>("[data-buy]").forEach((b) => b.addEventListener("click", () => buy(b.dataset.buy!, priceOf(b.dataset.buy!))));
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
    if (q.equippedGun === id) return;
    q.equippedGun = id;
    adapter.saveProgress(q);
    refresh();
  };
  shop.querySelectorAll<HTMLElement>("[data-equip]").forEach((b) => b.addEventListener("click", () => equip(b.dataset.equip!)));
  const adBtn = shop.querySelector("[data-b=ad-gold]");
  if (adBtn && adapter.adsEnabled) {
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
  /** The whole series plays on one map (picked at the start). */
  map?: MapId;
  /** Decided rounds in order (result card pips). */
  history?: Array<"p" | "f">;
  /** Gold earned this series (result card). */
  gold?: number;
  /** The one opponent of this series (picked at its first duel). */
  foe?: FoeLookId;
  /** Ladder level (0-based, game/levels.ts): sets the foe + its AI. Absent
      only for DEV probe series (random foe, old AI_ROSTER tiers). */
  level?: number;
  /** This series' deciding win unlocked the next level (first clear). */
  cleared?: boolean;
}

const titleCase = (t: string): string => t.toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());

/** Standard Best-of loop entry: full-HP resets, most-rounds-wins. Ladder
    (user 2026-10-19): `level` (default = the saved next unbeaten one) picks
    the foe and its AI; its rig starts downloading now. */
function runSeries(root: HTMLElement, adapter: PortalAdapter, mode: Mode, audio: AudioManager, level?: number): void {
  const lv = playableLevel(level ?? adapter.loadProgress().level);
  preloadCowboyGlb(`${import.meta.env.BASE_URL}models/${FOE_LOOKS[LEVELS[lv].foe].glb}`);
  runDuel(root, adapter, mode, audio, { roundIndex: 0, pWins: 0, fWins: 0, map: rollMap(adapter), level: lv });
}

/** Saved MAP choice -> a concrete map ("random" rolls), with its set GLB
    fetched right away so the first duel swaps it in fast. Low-memory /
    data-saver devices: RANDOM takes the backdrop's map (itself a random
    pick, already downloaded) instead of fetching another 1.2-1.7MB set. */
function rollMap(adapter: PortalAdapter): MapId {
  const raw = adapter.loadProgress().settings.map;
  const choice = isMapChoice(raw) ? raw : "random";
  const thrifty = deviceTier().lowMemory || deviceTier().saveData;
  const id = (choice === "random" && thrifty ? menuMapId() : null) ?? pickMap(choice);
  const glb = MAPS[id].glb;
  if (glb) preloadSet(`${import.meta.env.BASE_URL}models/${glb}`);
  return id;
}

/** Deathmatch run (locked 2026-09-24 §7): endless loops of 3 duels vs the
    3 roster profiles, 1 life for the whole run (HP carries over, no refill),
    each win restores 10% of max HP (clamped to max). Lose once = run over. */
export interface DeathRun {
  /** Duels won this run (= score). Duel in loop = streak % 3, loop = streak / 3. */
  streak: number;
  /** Player HP carried into the next duel. */
  hp: number;
  /** This duel's map (a hell round after a double KO stays on it). */
  map?: MapId;
  /** Gold earned this run (result card). */
  gold?: number;
}

const DEATHMATCH_WIN_HEAL = 0.1 * BASE_HP;

function runDeathmatch(root: HTMLElement, adapter: PortalAdapter, audio: AudioManager): void {
  runDuel(root, adapter, "deathmatch", audio, undefined, false, false, { run: { streak: 0, hp: BASE_HP, map: rollMap(adapter) } });
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
  opts: { run?: DeathRun; startHP?: number; distM?: number; map?: MapId; foe?: FoeLookId; retry?: boolean } = {},
): void {
  const run = opts.run;
  // Map (user 2026-10-12): the series / run carries it; tutorial + single
  // duels stay on Main Street. DEV probes can force one.
  const mapId: MapId = opts.map ?? series?.map ?? run?.map ?? "street";
  const mapDef = MAPS[mapId];
  hideMenuScene(); // one GL context at a time: the duel builds its own arena
  audio.stopMusic();
  audio.playMusic('duel');
  root.innerHTML = "";
  document.body.classList.add("in-duel"); // OS cursor hidden; crosshair is the pointer
  const coarse = isCoarsePointer();
  const gun = GUNS[adapter.loadProgress().equippedGun] ?? GUNS.default;
  const distM = opts.distM ?? DUEL_RANGE_MIN + Math.random() * (DUEL_RANGE_MAX - DUEL_RANGE_MIN); // uniform per round (hell too); DEV probes can force it
  // Round index drives time-of-day + the AI profile; deathmatch walks the
  // 3-profile roster per loop and the level (0.94^level) goes up each loop.
  const rIdx = series?.roundIndex ?? (run ? run.streak % AI_ROSTER.length : 0);
  // Stage = decided rounds only (user 2026-10-06): a drawn round (or a drawn
  // hell) replays at the same time of day vs the same opponent; roundIndex
  // still counts for the ROUND line.
  const stageIdx = series ? series.pWins + series.fWins : rIdx;
  const level = run ? Math.floor(run.streak / AI_ROSTER.length) : 0;
  const ladder = series?.level !== undefined ? LEVELS[series.level] : null;
  // Foe AI: a ladder level's own profile (accuracy + focus climbing a little
  // per decided round), else the old per-round tiers (deathmatch, DEV).
  const ai = series?.level !== undefined ? levelAi(series.level, stageIdx) : AI_ROSTER[clamp(stageIdx, 0, AI_ROSTER.length - 1)];
  // Wind picks up as the day goes (noon breeze -> night gusts; hell roars).
  audio.startWind((hellRound ? 0.8 : [0.45, 0.65, 0.85][Math.min(stageIdx, 2)]) * mapDef.wind, hellRound);

  const { scene, camera, renderer, render, release, prepare, worldPerPxAt, fitCamera, setTimeOfDay, noteFrame, setProneFrame, setFloor, buildProceduralStreet } = createArena(distM);
  // Time-of-day driver: R1 noon → R2 evening → R3+ night, coloured per map.
  // Hell: Main Street drops into its lava causeway (render/hell.ts); every
  // other map stays put and turns red / dark brown (setGlb hell tint).
  const streetHell = hellRound && mapId === "street";
  if (mapDef.glb) setFloor(mapDef.floor); // Main Street keeps the arena floor as is
  setTimeOfDay(mapDef.tod(stageIdx, hellRound));
  document.body.style.background = streetHell
    ? "linear-gradient(#0d0202 0%, #3a0a06 60%, #ff3a12 100%)"
    : mapId === "street" ? cssSkyForRound(stageIdx) : cssSky(mapDef.tod(stageIdx, hellRound));
  root.appendChild(renderer.domElement);
  // Hidden (CSS sky shows) until the first draw: frame() holds it back while
  // prepare() compiles any new shaders off the main thread.
  renderer.domElement.style.visibility = "hidden";
  // Lens vignette (CSS, plain alpha): darker variant for night + hell.
  const vignette = el(`<div class="vignette"></div>`);
  vignette.classList.toggle("dark", hellRound || stageIdx >= 2);
  root.appendChild(vignette);
  fitCamera();
  // Hell visuals: lazy chunk, never in the initial payload (QA gate). The
  // import() splits into its own chunk; by the 2nd duel GameplayStart has
  // fired at least once, and single-duel hell is impossible (needs a double
  // KO first), so the load always lands post-GameplayStart in practice.
  let hellSet: { tick(t: number): void; dispose(): void } | null = null;
  if (streetHell) {
    void import("../render/hell").then((m) => {
      if (!alive) return;
      try {
        hellSet = m.enterHell(scene, stage.player, stage.foe, `${import.meta.env.BASE_URL}models/hell.glb`);
      } catch { /* visual only — duel continues */ }
    });
  }
  // Pooled gunsmoke + muzzle flash (procedural, zero shipped bytes). Player
  // and foe share this pool (Slice-2 AI path calls the same spawn).
  const gunsmoke = createGunsmoke(scene);
  // Unlit smoke/dust sprites follow the scene's light level (noon → night).
  const spriteLight = (i: number, hell: boolean) => (hell ? 0.5 : [1, 0.8, 0.4][Math.min(i, 2)]);
  gunsmoke.setAmbient(spriteLight(stageIdx, hellRound));
  // Air particles: dust motes / fireflies / embers by time of day.
  const ambientFx = createAmbient(scene, distM);
  ambientFx.setTimeOfDay(Math.min(stageIdx, mapDef.ambientMaxStage), hellRound);

  // True projectiles (Slice 1): pooled sim + visible bullet meshes. Net seam:
  // every shot emits Fire{pos,dir,gunId,tick} / Hit{tick,head,damage} over
  // LocalTransport (AI = remote peer today, CrazyRoom later).
  const sim = new ProjectileSim();
  const transport = new LocalTransport();
  transport.onCmd(() => { /* net-ready envelope; local sim resolves inline */ });
  // Tracer streak (was a 5cm dot): a thin bar trailing 0.7m behind the
  // bullet's head, aimed along its travel each frame (lookAt aims +Z).
  const bulletGeo = new THREE.BoxGeometry(0.035, 0.035, 0.7);
  bulletGeo.translate(0, 0, -0.35);
  const bulletMat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, fog: false, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false });
  // prev/cur = bullet position before/after the latest fixed step; rendered
  // interpolated by alpha so flight is smooth at any refresh rate (60Hz steps
  // alone made bullets hop 1.8m per step on 120/144/165Hz displays).
  // spent = the view struck dirt/a facade (cosmetic only: the sim bullet
  // keeps flying, so in-flight/double-KO rules are untouched).
  type BulletView = { mesh: THREE.Mesh; b: BulletState | null; prev: THREE.Vector3; cur: THREE.Vector3; spent: boolean };
  const bulletViews: BulletView[] = [];
  for (let i = 0; i < 8; i++) {
    const mesh = new THREE.Mesh(bulletGeo, bulletMat);
    mesh.visible = false;
    scene.add(mesh);
    bulletViews.push({ mesh, b: null, prev: new THREE.Vector3(), cur: new THREE.Vector3(), spent: false });
  }
  function showBullet(b: BulletState): void {
    const v = bulletViews.find((x) => x.b === null || x.b.alive === false);
    if (!v) return;
    v.b = b;
    v.spent = false;
    v.mesh.visible = true;
    v.prev.set(b.pos[0], b.pos[1], b.pos[2]);
    v.cur.copy(v.prev);
    v.mesh.position.copy(v.prev);
    v.mesh.lookAt(tmpAim.set(b.pos[0] + b.vel[0], b.pos[1] + b.vel[1], b.pos[2] + b.vel[2]));
  }
  const tmpAim = new THREE.Vector3();
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
      // Night: the foe's tracer would draw a line back to it; the flash alone gives it away.
      if (!v.b || !v.b.alive || v.spent || (nightBlind && !roundOver && v.b.shooter === "foe")) { v.mesh.visible = false; continue; }
      v.mesh.visible = true;
      v.mesh.position.lerpVectors(v.prev, v.cur, alpha);
      tmpAim.subVectors(v.cur, v.prev);
      if (tmpAim.lengthSq() > 1e-8) v.mesh.lookAt(tmpAim.add(v.mesh.position));
    }
  }

  const stage = stagePositions(distM);
  // Procedural cowboys render instantly (GameplayStart never waits on
  // assets); Blender GLBs swap in silently when loaded, pose transferred.
  let player: Cowboy = createCowboy({ coat: 0x4a6fa5, hat: 0x3a2a1a, skin: 0xd9a066, facing: 1 });
  player.group.position.copy(stage.player);
  faceToward(player.group, stage.player, stage.foe);
  paintGun(player.gun, gun.id);
  // Foe look: ONE cowboy for a whole best-of series, a new one per series
  // (user 2026-10-14; the AI tier still climbs per decided round), cycling
  // in deathmatch.
  const foeLook = opts.foe ? FOE_LOOKS[opts.foe]
    : series ? FOE_LOOKS[series.foe ??= ladder?.foe ?? pickSeriesFoe()] // one foe for the whole series (the ladder level's)
    : foeLookFor(mode === "deathmatch" ? "deathmatch" : "tutorial", run?.streak ?? 0);
  let foe: Cowboy = createCowboy({ ...foeLook.fallback, facing: -1 });
  foe.group.position.copy(stage.foe);
  faceToward(foe.group, stage.foe, stage.player);
  player.holster?.();
  foe.holster?.();
  scene.add(player.group, foe.group);
  // Sun shadow decals (cheap stand-in for a shadow map; see arena.ts).
  const shadowStrength = (i: number, hell: boolean) => (hell ? 0.4 : [0.62, 0.66, 0.3][Math.min(i, 2)]) * mapDef.shadow;
  const playerShadow = createShadowDecal(scene);
  const foeShadow = createShadowDecal(scene);
  for (const d of [playerShadow, foeShadow]) d.setStrength(shadowStrength(stageIdx, hellRound));
  // Night: the fog between the duelists swallows the foe (arena NIGHT
  // fog); only its muzzle flash cuts through. Its shadow decal and duel
  // marker would outline it from under the fog, so they go too.
  const nightBlind = !hellRound && mode !== "tutorial" && stageIdx >= 2;
  if (nightBlind) foeShadow.setStrength(0);
  {
    const fm = scene.getObjectByName("FoeMarker");
    if (fm) fm.visible = !nightBlind;
  }
  // Accessories (hat, pads, belt, boots…) ride the nearest body part so no
  // detail freezes mid-air on death. Done before doll creation (attach
  // preserves world transforms, so body snapshots stay exact).
  try { bindAccessories(player.group, player.parts); } catch { /* noop */ }
  try { bindAccessories(foe.group, foe.parts); } catch { /* noop */ }
  /** Horizontal direction a duelist faces (toward the other): the ragdoll's knee bend plane. */
  const faceOf = (side: "player" | "foe"): THREE.Vector3 =>
    (side === "player" ? stage.foe.clone().sub(stage.player) : stage.player.clone().sub(stage.foe)).setY(0).normalize();
  let playerDoll: Ragdoll | null = createRagdoll(scene, player.parts, gun.id, faceOf("player"));
  let foeDoll: Ragdoll | null = createRagdoll(scene, foe.parts, gun.id, faceOf("foe"));
  // Hat + coat-tail secondary motion (GLB rigs only; procedural has no pivots).
  let playerSway: Sway | null = null;
  let foeSway: Sway | null = null;
  const base = import.meta.env.BASE_URL;
  // What the loading bar waits on (cold visit, see tickLoading).
  const assetUrls = [`${base}models/cowboy_hero.glb`, `${base}models/${foeLook.glb}`];
  const assetsSwapped: Promise<unknown>[] = [];
  assetsSwapped.push(loadCowboyGlb(`${base}models/cowboy_hero.glb`, "H").then(async (m) => {
    if (m && alive) await prepare(m.group); // new shaders compile off the main thread first
    if (m && alive) {
      player = swapCowboy(scene, player, m);
      playerSway = createSway(m.sway);
      paintGun(player.gun, gun.id);
      // Late swap after DRAW: procedural owns the arms, silence idle. Before
      // DRAW the fresh rig's gun goes into its holster (idle = hand on grip).
      if (tracking) (player as unknown as CowboyGlb).stopClips?.();
      else player.holster?.();
      // Post-mortem swap: the fresh corpse must arrive already fallen.
      if (playerHP <= 0) {
        try { (player as unknown as CowboyGlb).playFrozen?.(playerFallVariant); } catch { /* noop */ }
      }
      try { bindAccessories(player.group, player.parts); } catch { /* noop */ }
      if (playerDoll) playerDoll.dispose();
      playerDoll = createRagdoll(scene, player.parts, gun.id, faceOf("player"));
    }
  }));
  assetsSwapped.push(loadCowboyGlb(`${base}models/${foeLook.glb}`, "O").then(async (m) => {
    if (m && alive) await prepare(m.group);
    if (m && alive) {
      foe = swapCowboy(scene, foe, m);
      foeSway = createSway(m.sway);
      if (tracking) (foe as unknown as CowboyGlb).stopClips?.();
      else foe.holster?.();
      if (foeHP <= 0) {
        try { (foe as unknown as CowboyGlb).playFrozen?.(foeFallVariant); } catch { /* noop */ }
      }
      try { bindAccessories(foe.group, foe.parts); } catch { /* noop */ }
      if (foeDoll) foeDoll.dispose();
      foeDoll = createRagdoll(scene, foe.parts, gun.id, faceOf("foe"));
    }
  }));
  // Blender street set swaps over the procedural block when ready.
  // Its ambient life (signs, horse, tumbleweed) is posed from wall time in
  // frame(); windows/lanterns glow by time of day (noon dark -> night lit).
  let street: StreetSet | null = null;
  if (mapId === "street" && !hellRound) {
    const url = `${base}models/street.glb`;
    // The procedural stand-in only while the GLB is still downloading (first
    // visit) or if it fails; a parsed street lands before the first frame.
    if (!streetGlbReady(url)) buildProceduralStreet();
    assetUrls.push(url);
    assetsSwapped.push(loadStreetGlb(url, distM).then(async (s) => {
      if (!alive) return;
      if (!s) { buildProceduralStreet(); return; }
      await prepare(s.group); // its shaders compile off the main thread first
      if (!alive) return;
      for (const n of ["ProceduralStreet", "ProceduralDressing"]) {
        const old = scene.getObjectByName(n);
        if (old) old.visible = false;
      }
      s.setGlow(hellRound ? 1 : [0, 0.55, 1][Math.min(stageIdx, 2)]);
      scene.add(s.group);
      street = s;
    }));
  }
  // The other maps: the procedural street never shows (the recoloured arena
  // floor + sky hold until the set lands, ~instant once cached).
  let mapSet: MapSet | null = null;
  function lookMapSet(s: MapSet, stage: number, hell: boolean): void {
    const k = Math.min(stage, 2);
    s.setHell(hell);
    s.setGlow(hell ? 1 : mapDef.glow[k]);
    s.setWindow(mapDef.window[hell ? 3 : k]);
    s.setShaft(mapDef.shaft[hell ? 3 : k]);
    s.setNightVis(!hell && k === 2 ? mapDef.nightVis ?? null : null);
  }
  if (mapDef.glb) {
    for (const n of ["ProceduralStreet", "ProceduralDressing"]) {
      const old = scene.getObjectByName(n);
      if (old) old.visible = false;
    }
    assetUrls.push(`${base}models/${mapDef.glb}`);
    assetsSwapped.push(loadMapSet(`${base}models/${mapDef.glb}`, distM, mapDef.paintGain).then(async (s) => {
      if (!s) return;
      if (!alive) { s.dispose(); return; }
      lookMapSet(s, stageIdx, hellRound);
      await prepare(s.group); // its shaders compile off the main thread first
      if (!alive) { s.dispose(); return; }
      scene.add(s.group);
      mapSet = s;
    }));
  }
  // Cold visit (2026-10-23): a first-time player (fresh browser) got the
  // procedural stand-ins while ~1.7MB of GLBs downloaded. The duel now waits
  // behind a loading bar (the boot splash's look) until the rigs + set have
  // swapped in and the first frame is drawn, LOAD_MAX_MS at most (then it
  // plays on the stand-ins, which swap later as before). Cached duels never
  // show it; Focus cannot start until the canvas is live either way.
  let assetsIn = false;
  void Promise.all(assetsSwapped.map((p) => p.catch(() => undefined))).then(() => { assetsIn = true; });
  let loading = true;
  const loadT0 = performance.now();
  let loadingEl: HTMLElement | null = allLoaded(assetUrls) ? null : el(`<div class="boot duel-loading">
    <div class="boot-title"><span class="t1">HIGH NOON</span><span class="t2">DUEL</span></div>
    <div class="boot-bar det"><i></i></div>
    <small>LOADING ${mapDef.name}</small>
  </div>`);
  const loadBar = loadingEl?.querySelector<HTMLElement>(".boot-bar i") ?? null;
  if (loadingEl) root.appendChild(loadingEl);
  const playerYaw = player.group.rotation.y;

  const hud = el(`<div class="hud">
    <div class="cue">HOLSTER UP</div><div class="sub"></div>
  </div>`);
  const cross = el(`<div class="crosshair" style="display:none"><i class="chl t"></i><i class="chl b"></i><i class="chl l"></i><i class="chl r"></i><i class="cring"></i><i class="cdot"></i></div>`);
  const spreadCross = el(`<div class="crosshair spread" style="display:none"></div>`);
  hud.appendChild(cross);
  hud.appendChild(spreadCross);
  root.appendChild(hud);
  const roundLine = el(`<div class="roundline" style="position:absolute;top:calc(76px + env(safe-area-inset-top));left:50%;transform:translateX(-50%);font-size:13px;font-weight:700;letter-spacing:.1em;color:#ffe9bd;text-shadow:0 1px 2px #000,0 0 8px rgba(0,0,0,.95),0 0 3px rgba(0,0,0,.9);pointer-events:none;"></div>`); // dark halo: readable over the full moon (2026-10-21)
  root.appendChild(roundLine);
  function paintRound(): void {
    // The round's distance shows on every line: it varies 6-25m (user 2026-10-05).
    const dist = `${Math.round(distM)} M`;
    const where = mapId === "street" ? dist : `${mapDef.name} · ${dist}`;
    if (hellRound) { roundLine.textContent = `SUDDEN DEATH — FIRST HIT WINS · ${where}`; return; }
    if (series && ladder) { roundLine.textContent = `LEVEL ${series.level! + 1} · ${ladder.name} · ROUND ${series.roundIndex + 1} · YOU ${series.pWins} – ${series.fWins} · ${where}`; return; }
    if (series) { roundLine.textContent = `ROUND ${series.roundIndex + 1} · YOU ${series.pWins} – ${series.fWins} FOE (1ST TO ${FIRST_TO}) · ${where}`; return; }
    if (run) { roundLine.textContent = `DEATHMATCH · STREAK ${run.streak} · DUEL ${rIdx + 1}/${AI_ROSTER.length} · LOOP ${level + 1} · ${where}`; return; }
    roundLine.textContent = where;
  }
  paintRound();
  // Ladder intro: who you face, on the first round of a level only.
  if (ladder && series!.roundIndex === 0 && !hellRound) {
    root.appendChild(el(`<div class="lvl-banner"><span>LEVEL ${series!.level! + 1} OF ${LEVEL_COUNT}</span><b>${ladder.name}</b><i>${ladder.tagline}</i></div>`));
  }
  
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
  // Tutorial coach (src/ui/coach.ts): step cards beside the holster zone,
  // rule cards after the kill. SKIP stays up the whole way.
  let coach: Coach | null = null;
  if (mode === "tutorial") {
    skip = el(`<div class="skip"><button>SKIP<span class="wide"> TUTORIAL</span> ▸</button></div>`);
    root.appendChild(skip);
    skip.querySelector("button")!.addEventListener("click", () => {
      markTutorialDone();
      cleanup();
      afterTutorial(root, adapter, audio);
    });
    coach = mountCoach(root, coarse);
    coach.step(opts.retry ? "retry" : "holster");
  }
  function markTutorialDone(): void {
    markTutorialSeen(adapter);
  }

  const machine = new DuelMachine({
    seed: (Math.random() * 1e9) | 0,
    bloomStartDeg: gun.bloomStartDeg,
    bloomMinDeg: gun.bloomMinDeg,
    bloomMaxDeg: gun.bloomStartDeg + 0.6,
    focusPerTapDeg: gun.focusPerTapDeg,
    duelDistM: distM,
  });
  // The foe's own (unseen) crosshair, same rules as the player's (user
  // 2026-10-06: "enemy accuracy affected as much as the player"): focus sets
  // it at DRAW (focusQuality stands in for QTE hits), it regrows until the
  // first shot, every shot kicks it x1.5, hits flinch it out. Own seed.
  const foeGun = GUNS.default;
  const foeAim = new DuelMachine({
    seed: (machine.seed ^ 0x9e3779b9) >>> 0,
    bloomStartDeg: foeGun.bloomStartDeg,
    bloomMinDeg: foeGun.bloomMinDeg,
    bloomMaxDeg: foeGun.bloomStartDeg + 0.6,
    focusPerTapDeg: foeGun.focusPerTapDeg,
    duelDistM: distM,
  });
  let foeFired = false;
  const _fR = new THREE.Vector3();
  const _fU = new THREE.Vector3();
  /** Foe shot dir: aim point + hand wobble + a bloom sample, both as angles
      from the muzzle. `wobble` (rad, gaussian sigma) keeps each AI tier at
      its pre-bloom hit rate on a first shot (fitted 2026-10-06: 0.03 x
      accuracyMult, e.g. tier 0 ~51% at 15m); kicks and flinches then cost it
      accuracy exactly like the player. */
  function foeAimDir(muzzle: THREE.Vector3, target: THREE.Vector3, wobble: number): THREE.Vector3 {
    const d = target.clone().sub(muzzle);
    const dist = d.length();
    d.normalize();
    _fR.crossVectors(d, THREE.Object3D.DEFAULT_UP).normalize();
    _fU.crossVectors(_fR, d).normalize();
    // Same cap as the player's ring (spreadCapDeg): the foe's bloom never
    // spreads wider than the player at this range (user 2026-10-21). The
    // ladder's hand wobble stays uncapped: it is the per-level difficulty.
    const sp = foeAim.sampleSpread((Math.atan(dimsOf(player).halfWidth / dist) * 180) / Math.PI);
    return target.clone()
      .addScaledVector(_fR, (Math.tan(sp.dx) + gauss() * wobble) * dist)
      .addScaledVector(_fU, (Math.tan(sp.dy) + gauss() * wobble * 0.85) * dist)
      .sub(muzzle).normalize();
  }
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
  // visible head miss. Measured with __gamey.poseProbe (scratch tune loop):
  // crouch head 1.31 (cap 1.32), prone 0.58 (0.55).
  // crouch = a LUNGE (user 2026-10-05): left leg forward, front thigh near
  // level over a vertical shin, back knee hovering ~0.18m, hips turned 0.5rad
  // so the stride reads on the chase cam, torso leaned 0.7rad (the rig's short
  // shins only drop the hips ~0.4m; the lean brings the head to the capsule).
  // prone = lying on the BACK aiming at the foe (user 2026-10-05): body tipped
  // back about the feet, torso curled up ~20deg, chin tucked, left knee up,
  // gun-side leg flat; feet stay toward the foe.
  const WOUND_POSE_TARGET: Record<WoundPose, { pitch: number; roll: number; drop: number }> = {
    none: { pitch: 0, roll: 0, drop: 0 },
    bend: { pitch: 0.4, roll: 0.12, drop: -0.15 },
    crouch: { pitch: 0, roll: 0, drop: -0.4 },
    prone: { pitch: -1.35, roll: 0, drop: 0.27 },
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
      All angles are rotation.x in the group-pitch convention (+ tips the
      top toward the foe, so a hanging limb's lower end swings AWAY): thigh
      < 0 = knee forward, knee > 0 = shin folds back, head > 0 = chin down.
      Legs are per side (L = front leg of the lunge, R = gun side). */
  type JointPose = { thighL: number; thighR: number; kneeL: number; kneeR: number; waist: number; head: number; armL: number; hipYaw: number };
  const WOUND_JOINTS: Record<WoundPose, JointPose> = {
    none: { thighL: 0, thighR: 0, kneeL: 0, kneeR: 0, waist: 0, head: 0, armL: 0, hipYaw: 0 },
    bend: { thighL: 0, thighR: 0, kneeL: -0.4, kneeR: -0.4, waist: 0, head: 0, armL: 0, hipYaw: 0 }, // = the GLB-tuned +0.4 before rig signs
    crouch: { thighL: -1.281, kneeL: 1.281, thighR: 1.2, kneeR: 0.55, waist: 0.7, head: -0.3, armL: -1.1, hipYaw: 0.5 },
    prone: { thighL: -0.95, kneeL: 1.9, thighR: -0.12, kneeR: 0, waist: 0.3, head: 0.9, armL: 0.7, hipYaw: 0 },
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
  /** Shoulder in the torso's frame, captured upright on mount creation. The
      GLB armR hangs off the model root (not the waist), so a waist lean would
      leave the arm floating; the mount position follows the torso instead
      (a no-op on the procedural rig, whose arm already rides the waist). */
  const shoulderInTorso = new WeakMap<Cowboy, THREE.Vector3>();
  const _vS = new THREE.Vector3();
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
      const torso = c.parts.torso;
      if (torso) {
        m.updateWorldMatrix(true, false);
        torso.updateWorldMatrix(true, false);
        shoulderInTorso.set(c, torso.worldToLocal(m.getWorldPosition(new THREE.Vector3())));
      }
    }
    const sT = shoulderInTorso.get(c), torso = c.parts.torso;
    if (sT && torso) {
      torso.updateWorldMatrix(true, false);
      m.parent!.updateWorldMatrix(true, false);
      m.position.copy(m.parent!.worldToLocal(torso.localToWorld(_vS.copy(sT))));
    }
    m.parent!.getWorldQuaternion(_qP);
    c.group.getWorldQuaternion(_qG);
    _qY.setFromEuler(_eY.set(0, c.group.rotation.y, 0));
    _qPi.copy(_qP).invert();
    m.quaternion.copy(_qPi).multiply(_qY).multiply(_qG.invert()).multiply(_qP);
  }
  /** Lying down: the upper arm would hang straight into the dirt. Swing the
      shoulder forward and fold the elbow back by the same amount (muzzle
      direction unchanged) once the body is near horizontal (either way:
      prone lies on its back); 0 when upright. */
  const armLift = (c: Cowboy): number => Math.min(0.9, Math.max(0, (Math.abs(c.group.rotation.x) - 0.9) * 1.5)); // face down or on the back

  /** Rest rotation + position of each driven node, captured on a cowboy's
      first drive (the head and cuff are not authored at 0). */
  const jointRest = new WeakMap<Cowboy, Map<THREE.Object3D, { x: number; y: number; p: THREE.Vector3 }>>();
  const _vU = new THREE.Vector3();
  function restOf(c: Cowboy, o: THREE.Object3D): { x: number; y: number; p: THREE.Vector3 } {
    let m = jointRest.get(c);
    if (!m) jointRest.set(c, (m = new Map()));
    let r = m.get(o);
    if (!r) m.set(o, (r = { x: o.rotation.x, y: o.rotation.y, p: o.position.clone() }));
    return r;
  }
  /** Chase o.rotation.x to rest + target (rig sign applied). With `pivot`
      (parent frame) the node also orbits it, so it swings about that point
      instead of its own origin: p = rest + u - R(a)u, u = pivot - rest. */
  function setJoint(c: Cowboy, o: THREE.Object3D | null, target: number, k: number, pivot?: THREE.Vector3): void {
    if (!o) return;
    const r = restOf(c, o);
    o.rotation.x += (r.x + target * (c.joints?.sign ?? 1) - o.rotation.x) * k;
    if (!pivot) return;
    const a = o.rotation.x - r.x, u = _vU.copy(pivot).sub(r.p);
    const cs = Math.cos(a), sn = Math.sin(a);
    o.position.set(r.p.x, r.p.y + u.y - (u.y * cs - u.z * sn), r.p.z + u.z - (u.y * sn + u.z * cs));
  }
  function setYaw(c: Cowboy, o: THREE.Object3D | null, target: number, k: number): void {
    if (!o) return;
    const r = restOf(c, o);
    o.rotation.y += (r.y + target - o.rotation.y) * k;
  }

  /** Damped joint chase. Skipped for corpses/dead like the group pose.
      Null-safe: rigs predating the joints keep the group-tilt fallback. */
  function driveJoints(c: Cowboy, wound: WoundPose, hp: number, doll: Ragdoll | null, dt: number): void {
    if (hp <= 0 || doll?.fallen) return;
    if (!c.joints) return;
    applyJoints(c, WOUND_JOINTS[wound], 1 - Math.exp(-dt * 6));
  }
  const _vHip = new THREE.Vector3();
  function applyJoints(c: Cowboy, t: JointPose, k: number): void {
    const J = c.joints;
    for (const [o, v] of [[J.thighL, t.thighL], [J.thighR, t.thighR]] as const) {
      if (!o) continue;
      // Hip = hipLift above the thigh's REST pivot (GLB legs pivot mid-thigh).
      const p = restOf(c, o).p;
      setJoint(c, o, v, k, J.hipLift ? _vHip.set(p.x, p.y + J.hipLift, p.z) : undefined);
    }
    setJoint(c, J.kneeL, t.kneeL, k);
    setJoint(c, J.kneeR, t.kneeR, k);
    setJoint(c, J.waist, t.waist, k);
    setJoint(c, J.head ?? null, t.head, k);
    if (J.armL) for (const o of J.armL.nodes) setJoint(c, o, t.armL, k, J.armL.pivot);
    // Hip turn: legs yaw with the pelvis, the waist yaws back (YXZ: yaw
    // applied outside the lean) so the torso, head and lean still face the foe.
    if (J.hips && J.waist) {
      J.waist.rotation.order = "YXZ";
      setYaw(c, J.hips, t.hipYaw, k);
      setYaw(c, J.waist, -t.hipYaw, k);
    }
  }

  // DEV-only probe for the wound test suite (zero prod surface).
  if (import.meta.env.DEV) {
    (window as unknown as { __gamey?: unknown }).__gamey = {
      wounds: () => ({ player: playerWound, playerHits: playerWounds, foe: foeWound, foeHits: foeWounds }),
      capsule: (side: "player" | "foe") => CAPSULE_FOR_POSE[side === "player" ? playerWound : foeWound],
      roll: (n: number) => machine.rollWound(n),
      /** Jump straight into a hell sudden-death round (repro/tests). */
      hell: (d?: number) => { cleanup(); runDuel(root, adapter, mode, audio, series, true, reviveUsed, { run, distM: d }); },
      /** Jump to best-of round i (0 noon, 1 evening, 2 night) at 1-1. */
      round: (i: number, d?: number, hp?: number) => { cleanup(); runDuel(root, adapter, "standard", audio, { roundIndex: i, pWins: Math.min(Math.ceil(i / 2), 1), fWins: Math.min(Math.floor(i / 2), 1), map: mapId }, false, reviveUsed, { distM: d, startHP: hp }); },
      /** Jump to a map at round i (hell = its hell round), optional distance. */
      map: (id: MapId, i = 0, hell = false, d?: number) => { cleanup(); runDuel(root, adapter, "standard", audio, { roundIndex: i, pWins: Math.min(Math.ceil(i / 2), 1), fWins: Math.min(Math.floor(i / 2), 1), map: id }, hell, reviveUsed, { distM: d }); },
      /** Ladder level n (1-based) from its first round (its foe + AI). */
      level: (n: number) => { cleanup(); runSeries(root, adapter, "standard", audio, n - 1); },
      /** Foe AI in effect (ladder checks). */
      ai: () => ({ ...ai, level: series?.level, foe: foeLook.id }),
      /** Passive tutorial dummy in a given outfit (ragdoll checks: FOE=<id> ai:ragdoll). */
      tutorial: (foe?: FoeLookId, d?: number) => { cleanup(); runDuel(root, adapter, "tutorial", audio, undefined, false, false, { foe, distM: d, map: mapId }); },
      /** Current map + foe outfit. */
      where: () => ({ map: mapId, foe: foeLook.id, set: !!mapSet || !!street || !!hellSet }),
      state: () => ({ phase: machine.phase, roundOver, playerHP, foeHP, ammo, foeAmmo, hell: hellRound, live: sim.bullets.filter((b) => b.alive).length, night: nightBlind, fog: (scene.fog as THREE.FogExp2).density, distM }),
      /** Force the player's bloom (hitbox checks; set it in the same task as the click). */
      bloom: (deg: number) => { machine.bloomDeg = deg; },
      /** Hat hit volume + half-width in use (measured per GLB), live spread cap. */
      dims: (side: "player" | "foe") => ({ ...dimsOf(side === "player" ? player : foe), capDeg: spreadCapDeg(), glb: "dims" in (side === "player" ? player : foe) }),
      /** Set both duelists' HP (double-KO repro: 1/1 makes any hit lethal). */
      hp: (p: number, f: number) => { playerHP = p; foeHP = f; paintBars(); },
      /** Revolver state + world position (quick-draw checks). */
      gun: (side: "player" | "foe") => {
        const c = side === "player" ? player : foe;
        const p = (c.gun ?? c.gunTip).getWorldPosition(new THREE.Vector3());
        return { state: c.gunState?.() ?? "hand", pos: [p.x, p.y, p.z], drawTick, tick: machine.tick };
      },
      /** Focus QTE readout: needle as rendered right now + zone + tallies. */
      qte: () => ({
        needle: qte.peek(qteExtra()),
        zoneC: qte.zoneC, zoneW: qte.zoneW, perfectW: qte.perfectW, frozen: qte.frozen,
        hits: qte.hits, misses: qte.misses, streak: qte.streak,
        phase: machine.phase, paused: machine.paused, bloom: machine.bloomDeg, foeBloom: foeAim.bloomDeg,
        secsLeft: machine.focusTicksLeft() / 60,
      }),
      /** Bloom check: n spread samples through playerDirFromClick at the
          foe's screen spot (no shot fired; consumes the seeded rng). Returns
          each landing's distance from the aim point / the drawn crosshair
          radius (1 = on the ring). */
      spreadCheck: (n = 400) => {
        const f = foeScreen();
        const cx = f.body.x, cy = f.body.y;
        const muzzle = player.gunTip.getWorldPosition(new THREE.Vector3());
        const rPx = crossPx() / 2;
        const rect = renderer.domElement.getBoundingClientRect();
        const out: number[] = [];
        for (let i = 0; i < n; i++) {
          const d = playerDirFromClick(cx, cy, muzzle);
          const hit = new THREE.Vector3();
          if (!new THREE.Ray(muzzle, d).intersectPlane(aimPlane, hit)) continue;
          hit.project(camera);
          const sx = rect.left + ((hit.x + 1) / 2) * rect.width, sy = rect.top + ((1 - hit.y) / 2) * rect.height;
          out.push(Math.hypot(sx - cx, sy - cy) / rPx);
        }
        out.sort((a, b) => a - b);
        return { n: out.length, rPx: +rPx.toFixed(1), median: +out[out.length >> 1].toFixed(3), max: +out[out.length - 1].toFixed(3),
          outerShare: +(out.filter((v) => v > 0.6).length / out.length).toFixed(3) };
      },
      /** Last frame's draw calls / triangles + backing pixel ratio (perf). */
      info: () => ({ ...renderer.info.render, pr: renderer.getPixelRatio(), geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? 0 }),
      /** Live gunsmoke/dust/flash sprite counts (impact-FX checks). */
      fx: () => gunsmoke.live(),
      /** Hat / coat-tail sway pivot angles (x, z) per duelist (sway checks). */
      sway: () => Object.fromEntries((["player", "foe"] as const).map((k) => [k,
        ((k === "player" ? player : foe) as unknown as CowboyGlb).sway?.map((n) => [n.pivot.name, +n.pivot.rotation.x.toFixed(3), +n.pivot.rotation.z.toFixed(3)]) ?? []])),
      /** Look-dev: force round i's time of day + street glow; hell=true
          also drops the hell set in (street captures, not gameplay). */
      tod: (i: number, hell = false) => {
        setTimeOfDay(mapDef.tod(i, hell));
        gunsmoke.setAmbient(spriteLight(i, hell));
        ambientFx.setTimeOfDay(Math.min(i, mapDef.ambientMaxStage), hell);
        if (mapSet) lookMapSet(mapSet, i, hell);
        vignette.classList.toggle("dark", hell || i >= 2);
        for (const d of [playerShadow, foeShadow]) d.setStrength(shadowStrength(i, hell));
        street?.setGlow(hell ? 1 : [0, 0.55, 1][Math.min(i, 2)]);
        if (hell && !hellSet && mapId === "street") void import("../render/hell").then((m) => { hellSet = m.enterHell(scene, stage.player, stage.foe, `${import.meta.env.BASE_URL}models/hell.glb`); });
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
          thighR: r(J?.thighR ?? null), kneeR: r(J?.kneeR ?? null),
          waist: r(J?.waist ?? null), head: r(J?.head ?? null),
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
      /** Screen px of a point `dy` above the head centre, `lateral` m along
          the camera's right (hat hitbox checks: brim edge, crown top). */
      aimHead: (side: "player" | "foe", dy: number, lateral = 0) => {
        const feet = side === "player" ? stage.player : stage.foe;
        const cap = CAPSULE_FOR_POSE[side === "player" ? playerWound : foeWound];
        camera.updateMatrixWorld();
        const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
        const s = project(feet.clone().add(new THREE.Vector3(0, cap.headY + dy, 0)).addScaledVector(right, lateral));
        return { x: s.x, y: s.y };
      },
      /** Set a wound pose INSTANTLY (no chase) and measure it: head/pelvis/
          torso world Y, lowest point (feet planted => ~0) and foot reach
          ahead of the pelvis. Lets tuning sweep many poses in one tick. */
      poseProbe: (side: "player" | "foe", p: { pitch: number; roll: number; drop: number } & Partial<JointPose>) => {
        const c = side === "player" ? player : foe;
        c.group.rotation.x = p.pitch; c.group.rotation.z = p.roll; c.group.position.y = p.drop;
        if (c.joints) applyJoints(c, { ...WOUND_JOINTS.none, ...p }, 1);
        stabilizeArm(c, 1, null);
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
      /** Lowest meshes (world bbox min y) — pose tuning: what digs in. */
      lowest: (side: "player" | "foe", n = 4) => {
        const c = side === "player" ? player : foe;
        c.group.updateMatrixWorld(true);
        const out: [string, number][] = [];
        c.group.traverse((o) => {
          const g = (o as THREE.Mesh).isMesh && o.visible ? (o as THREE.Mesh).geometry : null;
          if (!g) return;
          if (!g.boundingBox) g.computeBoundingBox();
          out.push([o.name, +g.boundingBox!.clone().applyMatrix4(o.matrixWorld).min.y.toFixed(3)]);
        });
        return out.sort((a, b) => a[1] - b[1]).slice(0, n);
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
      setPose: (pose: WoundPose, v: Partial<{ pitch: number; roll: number; drop: number } & JointPose>) => {
        const t = WOUND_POSE_TARGET[pose], j = WOUND_JOINTS[pose];
        if (v.pitch !== undefined) t.pitch = v.pitch;
        if (v.roll !== undefined) t.roll = v.roll;
        if (v.drop !== undefined) t.drop = v.drop;
        for (const k of Object.keys(j) as (keyof JointPose)[]) if (v[k] !== undefined) j[k] = v[k]!;
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
      /** Look-dev close-up on one cowboy's hip/gun hand: camera `dist` m
          away at `angleDeg` round from its front (0 = facing it, 90 = its
          gun side), hip height. `null` restores the duel camera. */
      closeUp: (() => {
        let saved: { p: THREE.Vector3; q: THREE.Quaternion } | null = null;
        return (side: "player" | "foe" | null, angleDeg = 60, dist = 2.2) => {
          if (side) {
            if (!saved) saved = { p: camera.position.clone(), q: camera.quaternion.clone() };
            const c = side === "player" ? player : foe;
            const at = c.group.position.clone().add(new THREE.Vector3(0, 1.0, 0));
            const yaw = c.group.rotation.y + (angleDeg * Math.PI) / 180;
            camera.position.set(at.x + Math.sin(yaw) * dist, 1.25, at.z + Math.cos(yaw) * dist);
            camera.lookAt(at);
          } else if (saved) {
            camera.position.copy(saved.p);
            camera.quaternion.copy(saved.q);
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
      /** Ragdoll lab: `n` deaths of the foe from a wound pose on the live arm
          pose, each a throwaway doll stepped `secs` on the fixed clock with
          no rendering (deterministic per trial index), then the corpse's rest
          stats. The foe's transforms are restored after every trial. `shot`
          = index of a trial to leave on screen and return as a JPEG (the
          duel's own render() of the posed corpse, then restored). */
      ragdollLab: (o: { wound?: WoundPose; n?: number; secs?: number; head?: number; shot?: number; view?: number } = {}) => {
        const wound = o.wound ?? "none", n = o.n ?? 24, steps = Math.round((o.secs ?? 2.5) * 60);
        const c = foe, t = WOUND_POSE_TARGET[wound];
        const saved: Array<[THREE.Object3D, THREE.Vector3, THREE.Quaternion, THREE.Vector3]> = [];
        c.group.traverse((x) => saved.push([x, x.position.clone(), x.quaternion.clone(), x.scale.clone()]));
        const restore = (): void => {
          for (const [x, p, q, s] of saved) { x.position.copy(p); x.quaternion.copy(q); x.scale.copy(s); }
          c.group.updateMatrixWorld(true);
        };
        const shotDir = stage.foe.clone().sub(stage.player).setY(0).normalize();
        const side = new THREE.Vector3(0, 1, 0).cross(shotDir).normalize();
        const cap = CAPSULE_FOR_POSE[wound];
        const rnd = (i: number, k: number): number => { const s = Math.sin(i * 91.7 + k * 37.3) * 43758.5453; return s - Math.floor(s); };
        const out: Array<Record<string, number | string>> = [];
        let img: string | null = null;
        for (let i = 0; i < n; i++) {
          restore();
          c.group.rotation.x = t.pitch; c.group.rotation.z = t.roll; c.group.position.y = t.drop;
          if (c.joints) applyJoints(c, WOUND_JOINTS[wound], 1);
          stabilizeArm(c, 1, null);
          c.group.updateMatrixWorld(true);
          const doll = createRagdoll(scene, c.parts, gun.id, faceOf("foe"));
          if (!doll) return null;
          const head = rnd(i, 1) < (o.head ?? 0.5);
          const y = head ? cap.headY : capsuleMid(cap) + (rnd(i, 2) - 0.5) * 0.5;
          const point = stage.foe.clone().add(new THREE.Vector3(0, y, 0)).addScaledVector(side, (rnd(i, 3) - 0.5) * (head ? 0.2 : 0.5));
          const dir = shotDir.clone().addScaledVector(side, (rnd(i, 4) - 0.5) * 0.1).normalize();
          doll.hit(point, dir, gun.baseDamage / 6);
          let still = -1;
          for (let s = 0; s < steps; s++) {
            const before = doll.bodies!();
            doll.fixedStep(1 / 60);
            const after = doll.bodies!();
            const v = Math.max(...after.map((b, k) => Math.hypot(b[0] - before[k][0], b[1] - before[k][1], b[2] - before[k][2]) * 60));
            if (v < 0.05 && still < 0) still = s / 60; else if (v >= 0.05) still = -1;
          }
          doll.sync(1);
          c.group.updateMatrixWorld(true);
          const wy = (x: THREE.Object3D | null | undefined): number => (x ? new THREE.Vector3().setFromMatrixPosition(x.matrixWorld).y : NaN);
          // Torso uprightness: its local up in world (1 = sitting bolt upright, 0 = lying).
          const tq = c.parts.torso ? c.parts.torso.getWorldQuaternion(new THREE.Quaternion()) : null;
          const up = tq ? new THREE.Vector3(0, 1, 0).applyQuaternion(tq).y : NaN;
          const b = doll.bodies!();
          const gaps = doll.jointErrors?.() ?? {};
          out.push({
            i, head: head ? 1 : 0,
            pelvis: +wy(c.parts.pelvis).toFixed(2), torso: +b[1][1].toFixed(2), headY: +wy(c.parts.head).toFixed(2),
            up: +up.toFixed(2), maxY: +Math.max(...b.map((p) => p[1])).toFixed(2),
            still: +still.toFixed(2), gap: +Math.max(0, ...Object.values(gaps)).toFixed(3),
            gapAt: Object.entries(gaps).sort((a2, b2) => b2[1] - a2[1])[0]?.[0] ?? "",
          });
          if (i === o.shot) {
            // Camera on the corpse (pelvis), `view` deg around it from the shooter's side.
            const cp = camera.position.clone(), cq = camera.quaternion.clone();
            const at = new THREE.Vector3(b[0][0], 0.3, b[0][2]);
            const a = ((o.view ?? 90) * Math.PI) / 180;
            camera.position.copy(at).addScaledVector(shotDir, -Math.cos(a) * 3.4).addScaledVector(side, Math.sin(a) * 3.4).setY(1.1);
            camera.lookAt(at);
            camera.updateMatrixWorld();
            render();
            img = renderer.domElement.toDataURL("image/jpeg", 0.85);
            camera.position.copy(cp); camera.quaternion.copy(cq); camera.updateMatrixWorld();
          }
          doll.dispose();
        }
        restore();
        return { wound, rows: out, img };
      },
    };
  }

  const cue = hud.querySelector(".cue") as HTMLElement;
  /** Restart the cue's one-shot punch animation (text is untouched). */
  function popCue(): void {
    cue.classList.remove("pop");
    void cue.offsetWidth; // reflow so the animation restarts
    cue.classList.add("pop");
  }
  /** Long cues ("OUT OF AMMO — YOU TAKE IT", 550px at 32px) ran over both
      HP bars at 800-907px: shrink the font to the gap between the bars
      (their inner badges included), never below CUE_MIN_PX. Runs on every
      text change (observer) and resize; the text itself is untouched. */
  const CUE_MIN_PX = 16;
  const CUE_BADGE_PX = 18;
  function fitCue(): void {
    cue.style.fontSize = "";
    const a = hp.querySelector(".you")!.getBoundingClientRect(), b = hp.querySelector(".foe")!.getBoundingClientRect();
    const room = b.left - a.right - 2 * CUE_BADGE_PX;
    const w = cue.offsetWidth;
    if (room <= 0 || w <= room) return;
    cue.style.fontSize = `${Math.max(CUE_MIN_PX, Math.floor((parseFloat(getComputedStyle(cue).fontSize) * room) / w))}px`;
  }
  const cueFit = new MutationObserver(fitCue);
  cueFit.observe(cue, { childList: true, characterData: true, subtree: true });
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
  // Hell (user 2026-10-05): ONE round, full cylinders, the first shot that
  // lands wins (body or head); see maybeEnd.
  let ammo = SHOTS_PER_DUEL;
  let foeAmmo = SHOTS_PER_DUEL;
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
  let drawTick = -1; // fixed-clock tick DRAW began (fire gate)
  // Arm pose at DRAW (hand on the holstered grip), the quick-draw start.
  const drawFrom = { player: { s: 0.55, z: 0, e: -0.25 }, foe: { s: 0.55, z: 0, e: -0.25 } };
  // Aim OPENS off-target: muzzle at the dirt between the duelists, so the
  // player must manually drag up onto the foe after DRAW. Aim stays parked
  // through Focus (locked no-pre-aim rule); the first mouse move / touch
  // after DRAW takes over via aimFromClient.
  // Crosshair renders where the pointer IS (never pinned to the target).
  const pointerPx = lastPointer ? { ...lastPointer } : { x: window.innerWidth / 2, y: window.innerHeight * 0.4 };
  let pointerKnown = !!lastPointer;

  function placeCross(cx: number, cy: number): void {
    const rr = root.getBoundingClientRect();
    cross.style.left = `${cx - rr.left}px`;
    cross.style.top = `${cy - rr.top}px`;
    cross.style.transform = "translate(-50%, -50%)";
    // Bloom drives the gap (radius): ring + lines + dot, same radius as the Focus ring.
    cross.style.setProperty("--gap", `${Math.max(4, crossPx() / 2)}px`);
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

  // Holster zone: a fixed fraction of the view height (the old ortho cam's
  // 1.35m box), centred on the player's projected hip. Browser/game zoom
  // rescales zone and foe together, so the holster → enemy travel is
  // identical at any zoom. The clamp keeps it on-screen.
  const holsterWorld = stage.player.clone().add(new THREE.Vector3(0, 0.9, 0));
  function zonePx(): number {
    const hCss = renderer.domElement.getBoundingClientRect().height || window.innerHeight;
    return clamp(hCss * 0.2, 72, 220);
  }
  function updateZone(): void {
    const s = zonePx();
    zone.style.width = `${s}px`;
    zone.style.height = `${s}px`;
    const hip = project(holsterWorld);
    const x = clamp(hip.x, s / 2 + 8, window.innerWidth - s / 2 - 8);
    const y = clamp(hip.y, s / 2 + 8, window.innerHeight - s / 2 - 8);
    zone.style.left = `${x - s / 2}px`;
    zone.style.top = `${y - s / 2}px`;
    coach?.place(zone.getBoundingClientRect());
  }
  updateZone();

  /** Spread ceiling (deg): the angle half the foe's widest extent subtends
      from the camera, so the ring is never wider than the foe at this range
      (user 2026-10-21). Shown ring and real spread both clamp to it; Focus
      and the QTE keep the raw bloom, so focusing still pays below it. */
  function spreadCapDeg(): number {
    const mid = _vCap.copy(stage.foe).setY(stage.foe.y + capsuleMid(CAPSULE_FOR_POSE[foeWound]));
    return (Math.atan(dimsOf(foe).halfWidth / camera.position.distanceTo(mid)) * 180) / Math.PI;
  }
  const _vCap = new THREE.Vector3();

  // Crosshair diameter in CSS px: bloom is an angle, so on the perspective
  // camera it is (nearly) depth-independent.
  function crossPx(): number {
    const toAim = camera.position.distanceTo(aimWorld);
    const worldR = Math.tan((Math.min(machine.bloomDeg, spreadCapDeg()) * Math.PI) / 180) * toAim;
    return Math.max(3, (2 * worldR) / worldPerPxAt(aimWorld)); // 3px floor: a 0.03° focus must still read as nearly a dot
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
    if (machine.phase !== "ready" || loading) return;
    machine.startFocus();
    cue.textContent = "FOCUS! 3.0s";
    sub.textContent = coarse ? "Tap when the marker is on the gold arc" : "SPACE / ENTER when the marker is on the gold arc · don't click";
    // The ring on the foe shows the bloom during Focus; the pointer keeps a
    // small fixed cross (OS cursor is hidden in-duel) and gets its bloom
    // ring back at DRAW.
    cross.style.display = "block";
    cross.classList.add("focusing");
    adapter.gameplayStart();
    coach?.step("focus");
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
    killByPlayer = true;
    maybeEnd();
  }

  /** Lifesteal gun: EVERY landed body hit heals 20% of the damage dealt
      (cap 15/hit, never above full), with a +N pop on the player's bar. It
      used to heal on the killing shot only, when the round was already over. */
  function lifesteal(dealt: number): void {
    if (gun.extra !== "lifesteal" || playerHP <= 0) return;
    const heal = Math.min(LIFESTEAL_CAP_PER_HIT, dealt * gun.extraValue, BASE_HP - playerHP);
    if (heal <= 0) return;
    playerHP += heal;
    paintBars();
    const you = hp.querySelector(".hp.you") as HTMLElement;
    const pop = el(`<b class="healpop">+${Math.max(1, Math.round(heal))}</b>`);
    pop.style.left = youFace.style.left;
    you.appendChild(pop);
    you.classList.remove("healed");
    void you.offsetWidth; // restart the glow
    you.classList.add("healed");
    window.setTimeout(() => pop.remove(), 1000);
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
    foeAim.applyFlinch(0, 1.1); // the foe flinches like the player does when hit
    foeFlinchT = 0;
    shakeFoe();
    foeSway?.kick(1);
    shakeCam(0.012); // landing a hit: a tiny thump
    try { (foe as unknown as CowboyGlb).playClip?.("flinch"); } catch { /* no-op */ }
    // Wound lottery: persistent reactive pose (lunge, prone unlocks at hit 2).
    foeWounds += 1;
    foeWound = machine.rollWound(foeWounds, foeWound);
    refreshAimPlane();
    void audio.playSFX("hit-body").catch(() => undefined);
    cue.textContent = `HIT −${dmg.toFixed(0)}`;
    sub.textContent = foeHP > 0 && ammo > 0 ? "Again — aim + fire!" : sub.textContent;
    coach?.step("hit");
  }

  function hitPlayer(head: boolean, dmg: number, point?: THREE.Vector3, dir?: THREE.Vector3): void {
    if (roundOver) return;
    shakeCam(head ? 0.09 : 0.055);
    playerSway?.kick(1);
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
    foeAim.applyFlinch(0, 0.9); // landing a hit blooms the shooter too (mirror)
    playerFlinchT = 0;
    if (playerHP > 0) {
      // Wound lottery (same as foe): persistent reactive pose.
      playerWounds += 1;
      playerWound = machine.rollWound(playerWounds, playerWound);
      try { (player as unknown as CowboyGlb).playClip?.("flinch"); } catch { /* no-op */ }
    }
    // Hit flash: the crosshair goes red for a beat. Not at night (user
    // 2026-10-14): you are usually aiming at the hidden foe, and a red
    // crosshair sitting on him reads as a marker. The bloom kick stays.
    if (!nightBlind) {
      cross.classList.add("penalty");
      window.setTimeout(() => cross.classList.remove("penalty"), 220);
    }
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
    if (hellRound && (foeDead || playerDead)) {
      // Hell is a one-time sudden death: the first shot that lands wins.
      // No double KO (it used to chain into another hell), no waiting for
      // crossing bullets: the rest are dropped so nothing lands afterwards.
      roundOver = true;
      for (const b of sim.bullets) if (b.alive) sim.kill(b);
      if (foeDead && playerDead) endRound("BOTH HIT AT ONCE", "Sudden death takes no winner. Back to the street.", "draw");
      else if (foeDead) endFoeDown();
      else endRound("YOU'RE DOWN", "The foe hit first.", "f");
      return;
    }
    // Hell trigger (locked): both dead AND both killing blows were lethal
    // in-flight bullets fired before death. Lethality is recorded on the
    // bullet at fire time; the window covers crossing shots (~0.2s flight).
    if (foeDead && playerDead && killByPlayer && killByFoe) {
      if (Math.abs(foeDeadAt - playerDeadAt) < 900) {
        roundOver = true;
        endRound("DOUBLE KO!", "Sudden death: first hit wins.", "draw", true);
        return;
      }
    }
    if (foeDead || playerDead) {
      // wait for in-flight bullets to land before closing (they may force hell)
      const live = sim.bullets.some((b) => b.alive);
      if (live && !(foeDead && playerDead)) {
        window.setTimeout(() => { if (!roundOver) maybeEnd(); }, 350);
        // but don't hang forever: resolve ammo-out below anyway
        if (foeDead && playerDead) { roundOver = true; endRound("DOUBLE KO!", "Sudden death: first hit wins.", "draw", true); return; }
        if (foeDead || playerDead) {
          // give bullets 600ms max, then resolve
          window.setTimeout(() => {
            if (roundOver) return;
            if (foeHP <= 0 && playerHP <= 0) { roundOver = true; endRound("DOUBLE KO!", "Sudden death: first hit wins.", "draw", true); }
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
      if (foeDead && playerDead) endRound("DOUBLE KO!", "Sudden death: first hit wins.", "draw", true);
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
        // Hell never repeats (user 2026-10-05): every bullet missed, so it
        // counts as a drawn round and play goes back to the street.
        endRound("NO BLOOD DRAWN", "Sudden death spares you both. Back to the street.", "draw");
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
    coach?.hide();
    if (mode === "tutorial" && result === "p") markTutorialDone();
    // Round over: hand back the OS cursor. The crosshair freezes once the
    // round resolves, and `in-duel` hides the cursor with !important, so the
    // revive overlay (token / buy / ad / stay down) had no pointer at all.
    document.body.classList.remove("in-duel");
    cross.style.display = "none";
    if (foeHP <= 0 || playerHP <= 0) punchT = 0;
    cue.textContent = text;
    popCue();
    sub.textContent = subText;
    // Real gold flow (Slice 7): flat win + consolation + kill bonus.
    const prog = adapter.loadProgress();
    const goldBefore = prog.gold;
    const won = result === "p";
    if (won) {
      prog.gold += (mode === "deathmatch" ? GOLD_WIN_DEATHMATCH : GOLD_WIN_BESTOF) + (killByPlayer ? GOLD_KILL_BONUS : 0);
      if (gun.extra === "gold") prog.gold += Math.ceil(GOLD_KILL_BONUS * gun.extraValue);
      if (run) prog.bestStreak = Math.max(prog.bestStreak, run.streak + 1);
      else prog.bestBestOf = Math.max(prog.bestBestOf, (series?.pWins ?? 0) + 1);
    } else if (result === "f") {
      prog.gold += GOLD_LOSS_CONSOLATION;
    }
    // Ladder: the deciding win of a level's best-of-3 unlocks the next foe
    // (first clear only, with a bonus), saved now rather than on the card.
    if (won && series?.level !== undefined && series.pWins + 1 >= FIRST_TO && (prog.level ?? 0) <= series.level) {
      prog.level = series.level + 1;
      prog.gold += levelClearGold(series.level);
      series.cleared = true;
    }
    adapter.saveProgress(prog);
    if (series) series.gold = (series.gold ?? 0) + prog.gold - goldBefore;
    if (run) run.gold = (run.gold ?? 0) + prog.gold - goldBefore;
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
    // Not in hell: a revive would replay the one-time sudden death.
    if (result === "f" && !reviveUsed && mode !== "tutorial" && !hellRound) {
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
        // hell resolved. A drawn hell (all missed / simultaneous hits) never
        // replays: it counts as a drawn round, back to normal duels.
        if (result === "draw") {
          cleanup();
          if (run) { continueRun(run, "draw"); return; }
          if (series) { series.roundIndex++; runDuel(root, adapter, mode, audio, series, false, reviveUsed); return; }
          showHome(root, adapter, audio);
          return;
        }
        if (run) { cleanup(); continueRun(run, result); return; }
        // winner takes the point into the series
        if (series) {
          if (result === "p") series.pWins++; else series.fWins++;
          (series.history ??= []).push(result);
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
        (series.history ??= []).push(result);
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
      if (coach && result === "p") {
        // Tutorial won: the rule cards over the finished round, then home
        // (the scene keeps rendering behind them until PLAY / SKIP).
        coach.rules(() => { cleanup(); afterTutorial(root, adapter, audio); });
        return;
      }
      cleanup();
      if (result === "p") showHome(root, adapter, audio);
      else if (result === "f") showHome(root, adapter, audio);
      else runDuel(root, adapter, mode, audio, undefined, false, reviveUsed, { retry: mode === "tutorial" });
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
    // A drawn duel replays vs the same foe on the same map.
    if (result === "p") r.map = rollMap(adapter);
    runDuel(root, adapter, mode, audio, undefined, false, reviveUsed, { run: r });
  }

  // Result cards (user 2026-10-14: "this death screen is also very dull"):
  // over the menu backdrop in calm mode (a standoff, no shots: the hero must
  // not win behind a DEFEAT), a red / gold veil, big title, the score with a
  // pip per decided round, gold earned, then REMATCH / HOME. `.menu h1` kept
  // (tests look for it). Enter = the focused primary button.
  const pick = (lines: string[]) => lines[Math.floor(Math.random() * lines.length)];
  function resultCard(o: { won: boolean; kicker: string; title: string; line: string; score: string; gold: number; again: string }): HTMLElement {
    root.innerHTML = "";
    document.body.classList.remove("in-duel");
    document.body.style.background = "";
    showMenuScene(mapId, adapter.loadProgress().equippedGun, { calm: true });
    const total = adapter.loadProgress().gold;
    const s = el(`<div class="menu result ${o.won ? "win" : "loss"}">
      <div class="rs-veil"></div>
      <div class="rs-card">
        <div class="rs-kicker">${o.kicker}</div>
        <h1>${o.title}</h1>
        <div class="rs-line">${o.line}</div>
        ${o.score}
        <div class="rs-gold">${COIN_ICON}<b>+${o.gold}</b><span>gold · ${total} total</span></div>
        <div class="rs-btns">
          <button class="rs-btn primary" data-b="again">${o.again}</button>
          <button class="rs-btn" data-b="home">HOME</button>
        </div>
      </div>
    </div>`);
    root.appendChild(s);
    s.querySelector<HTMLButtonElement>("[data-b=again]")!.focus({ preventScroll: true });
    s.querySelector("[data-b=home]")!.addEventListener("click", () => showHome(root, adapter, audio));
    return s;
  }

  function endRun(streak: number): void {
    const best = adapter.loadProgress().bestStreak;
    const newBest = streak > 0 && streak >= best;
    const s = resultCard({
      won: false,
      kicker: `DEATHMATCH · ${MAPS[mapId].name}`,
      title: "RUN OVER",
      line: pick(["Your run ends here, partner.", "The streak is over. The legend isn't.", "Even the fastest gun runs out of road."]),
      score: `<div class="rs-score">
          <div class="rs-side"><span>STREAK</span><b>${streak}</b></div>
          <div class="rs-dash">·</div>
          <div class="rs-side"><span>BEST</span><b>${best}</b></div>
        </div>${newBest ? `<div class="rs-new">NEW BEST!</div>` : ""}`,
      gold: run?.gold ?? 0,
      again: "NEW RUN",
    });
    s.querySelector("[data-b=again]")!.addEventListener("click", () => runDeathmatch(root, adapter, audio));
  }

  function endSeries(won: boolean): void {
    const pips = (series?.history ?? [])
      .map((r, i) => `<i class="pip ${r === "p" ? "w" : "l"}" title="Round ${i + 1}">${r === "p" ? "W" : "L"}</i>`).join("");
    // Ladder card: the level in the kicker, the foe by name, NEXT on a win
    // (the last level: LEGEND + replay), REMATCH of the same level on a loss.
    const lv = series?.level;
    const last = lv !== undefined && lv >= LEVEL_COUNT - 1;
    const next = lv !== undefined && !last ? LEVELS[lv + 1] : null;
    const badge = !series?.cleared ? "" : last ? `<div class="rs-new">LADDER COMPLETE</div>` : `<div class="rs-new">LEVEL ${lv! + 2} UNLOCKED</div>`;
    const s = resultCard({
      won,
      kicker: ladder ? `LEVEL ${lv! + 1} OF ${LEVEL_COUNT} · ${MAPS[mapId].name}` : `BEST OF ${BEST_OF} · ${MAPS[mapId].name}`,
      title: won ? (last ? "LEGEND!" : "VICTORY!") : "DEFEAT",
      line: won
        ? ladder
          ? last ? "Ten duels, ten down. The West is yours." : `${titleCase(ladder.name)} is down. ${titleCase(next!.name)} is waiting.`
          : pick(["Fastest gun in the West.", "Smoke clears. You're still standing.", "The town sleeps easy tonight."])
        : ladder
          ? `${titleCase(ladder.name)} still stands. ${pick(["Draw again.", "Dust off your hat.", "Not today, partner."])}`
          : pick(["The dust settles. Not in your favour.", "Too slow on the draw, partner.", "Dust off your hat and draw again."]),
      score: `<div class="rs-score">
          <div class="rs-side you"><span data-pname>${escapeHtml(displayName(adapter))}</span><b>${series?.pWins ?? 0}</b></div>
          <div class="rs-dash">—</div>
          <div class="rs-side foe"><span>${ladder ? ladder.name : "FOE"}</span><b>${series?.fWins ?? 0}</b></div>
        </div>${pips ? `<div class="rs-pips">${pips}</div>` : ""}${badge}`,
      gold: series?.gold ?? 0,
      again: won && next ? `NEXT: LEVEL ${lv! + 2}` : won && ladder ? "PLAY AGAIN" : "REMATCH",
    });
    s.querySelector("[data-b=again]")!.addEventListener("click", () =>
      runSeries(root, adapter, mode, audio, won && next ? lv! + 1 : lv));
  }

  function offerRevive(onAccept: () => void, onDecline: () => void): void {
    const p = adapter.loadProgress();
    const price = reviveDeathPrice(SHOP_PRICES.revive);
    const hasToken = p.reviveToken >= 1;
    const canBuy = p.gold >= price;
    if (!hasToken && !canBuy && !adapter.adsEnabled) { onDecline(); return; }
    // Revive card (user 2026-10-14 revamp). Every button the same size, font
    // and colour (CrazyGames: a no-ad choice must match the ad one). The bar
    // shows the auto "stay down" (bots + QA never click it).
    const yes = hasToken
      ? `<button class="rv-btn" data-r="yes">${AID_KIT_ICON}USE TOKEN</button>`
      : canBuy ? `<button class="rv-btn" data-r="yes">${COIN_ICON}REVIVE · ${price}g</button>` : "";
    const ov = el(`<div class="revive">
      <div class="rv-card">
        <span class="rv-badge">${AID_KIT_ICON}</span>
        <div class="rv-title">REVIVE?</div>
        <div class="rv-sub">Get back up with 1 HP: same round, fresh aim.</div>
        <div class="rv-meta">${hasToken ? "Uses your revive token · once per game" : canBuy ? `No token · emergency price ${price}g · you have ${p.gold}g` : "No token"}</div>
        <div class="rv-btns">${yes}${adapter.adsEnabled ? `<button class="rv-btn" data-r="ad">WATCH AD</button>` : ""}<button class="rv-btn" data-r="no">STAY DOWN</button></div>
        <div class="rv-timer"><i style="animation-duration:${REVIVE_WAIT_MS}ms"></i></div>
      </div>
    </div>`);
    root.appendChild(ov);
    let done = false;
    const finish = (fn: () => void) => { if (done) return; done = true; ov.remove(); fn(); };
    // ai-play never clicks revive: auto-decline so bots + QA flow through.
    const timer = window.setTimeout(() => finish(onDecline), REVIVE_WAIT_MS);
    ov.querySelector("[data-r=yes]")?.addEventListener("click", () => {
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
  const _camRight = new THREE.Vector3();
  const _camUp = new THREE.Vector3();
  function playerDirFromClick(cx: number, cy: number, muzzle: THREE.Vector3): THREE.Vector3 {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
    const target = new THREE.Vector3();
    if (!raycaster.ray.intersectPlane(aimPlane, target)) target.copy(stage.foe).add(new THREE.Vector3(0, capsuleMid(CAPSULE_FOR_POSE[foeWound]), 0));
    // Bloom spread (seeded, locked): the sample is an angle from the camera,
    // the same angle crossPx() draws, so the shot lands inside the visible
    // circle. Offset across the SCREEN (camera right/up) at the target's
    // depth. It used to be world x/y scaled by 1/40, so shots hugged the
    // centre dot whatever the crosshair size (user report 2026-10-06).
    const spread = machine.sampleSpread(spreadCapDeg());
    const camDist = camera.position.distanceTo(target);
    camera.updateMatrixWorld();
    target
      .addScaledVector(_camRight.setFromMatrixColumn(camera.matrixWorld, 0), Math.tan(spread.dx) * camDist)
      .addScaledVector(_camUp.setFromMatrixColumn(camera.matrixWorld, 1), Math.tan(spread.dy) * camDist);
    return target.sub(muzzle).normalize();
  }

  function attemptFire(cx: number, cy: number): void {
    if (roundOver) return;
    // Dead but the round still open (own lethal bullet in flight, maybeEnd
    // waits up to 650ms): a corpse used to keep shooting, and a post-mortem
    // kill read as a double KO -> sudden death.
    if (playerHP <= 0) return;
    if (machine.phase !== "draw" && machine.phase !== "fire") return;
    if (drawTick < 0 || machine.tick - drawTick < DRAW_TICKS) return; // gun still clearing the holster
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
    audio.playGunshotSynth(0.85);
    paintBars();
    coach?.step("shot", ammo);

    const muzzle = player.gunTip.getWorldPosition(new THREE.Vector3());
    muzzle.y = Math.max(muzzle.y, 0.12); // prone muzzle can sit at the dirt line
    // Spread from the crosshair the player saw at the click, THEN the kick
    // (it used to kick first: every shot spread at x1.5 the shown circle).
    const dir = playerDirFromClick(cx, cy, muzzle);
    machine.applyShotKick(); // x1.5, accelerating return to the pre-shot size
    showSpreadCross(cx, cy);
    gunsmoke.spawn(muzzle);
  // Lethal-if-it-hits at fire time (locked double-KO rule): head always
    // lethal; body lethal iff post-falloff damage >= foe HP now. "Head" is
    // the bullet's predicted path through the head + hat zone (it was any
    // click within 90px of the head centre).
    const headAim = predictHit(muzzle, dir, distM, stage.foe, CAPSULE_FOR_POSE[foeWound], dimsOf(foe).hat, STEP / BULLET_SUBSTEPS) === "head";
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
    // Hasted AI (user-tuned): 0.85× reaction, quicker follow-ups. Damage and
    // accuracy untouched — duels get fiercer, not cheaper.
    const reaction = Math.max(180, ai.reactionBaseMs * 0.85 * Math.pow(0.97, stageIdx) * Math.pow(0.94, level));
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
      const muzzle = foe.gunTip.getWorldPosition(new THREE.Vector3());
      muzzle.y = Math.max(muzzle.y, 0.12); // prone muzzle can sit at the dirt line
      // Aim at the (possibly wounded/lowered) player capsule mid, 7cm low.
      // It was +0.12 high, but once head priority stopped the body's top cap
      // swallowing head-bound bullets (projectiles.ts) the same scatter
      // turned 0.3-2% foe headshots into 4-10% (sim, 2026-10-21); -0.07
      // keeps them at 2-4% with body hits unchanged. Scatter = hand wobble
      // (accuracyMult) + the foe's own bloom, same rules as the player's
      // crosshair (user 2026-10-06).
      const pMid = capsuleMid(CAPSULE_FOR_POSE[playerWound]) - 0.07;
      const target = stage.player.clone().add(new THREE.Vector3(0, pMid, 0));
      const dir = foeAimDir(muzzle, target, 0.03 * ai.accuracyMult);
      foeAim.applyShotKick();
      foeFired = true;
      gunsmoke.spawn(muzzle, nightBlind); // night: the flash is the only giveaway, so it carries
      audio.playGunshotSynth(0.6, true); // the foe's shot, down the street
      foeKickT = 0; // procedural shooting anim: gun-kick decay in frame loop
      const lethal = bodyDamage(GUNS.default.baseDamage, distM) >= playerHP;
      const b = sim.fire({ from: muzzle, dir, distM, shooter: "foe", gunId: "default", lethal });
      if (b) {
        showBullet(b);
        transport.send({ type: "Fire", tick: machine.tick, pos: [muzzle.x, muzzle.y, muzzle.z], dir: [dir.x, dir.y, dir.z], gunId: "default" });
      }
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

  // Cosmetic miss impacts, on the fixed clock (deterministic at any Hz): a
  // bullet view that reaches the dirt, or flies ~8m past the foe into the
  // storefronts, puffs dust and hides. The sim bullet is left alone.
  const duelAxis = stage.foe.clone().sub(stage.player).setY(0).normalize();
  const impactAt = new THREE.Vector3();
  function bulletImpacts(): void {
    for (const v of bulletViews) {
      const b = v.b;
      if (!b || !b.alive || v.spent) continue;
      impactAt.set(b.pos[0], b.pos[1], b.pos[2]);
      const dir = new THREE.Vector3(b.vel[0], b.vel[1], b.vel[2]).normalize();
      if (b.pos[1] <= 0.03) {
        v.spent = true;
        impactAt.y = 0.06;
        gunsmoke.dust(impactAt, dir, "ground");
      } else if (b.shooter === "player" && b.pos[1] < 7 && impactAt.clone().sub(stage.foe).dot(duelAxis) > 8) {
        v.spent = true;
        gunsmoke.dust(impactAt, dir, mapDef.backdrop);
      }
    }
  }

  function checkBulletHits(): void {
    for (const b of sim.bullets) {
      if (!b.alive) continue;
      if (b.shooter === "player" && foeHP > 0) {
        const r = testCapsuleHit(b.pos, stage.foe, CAPSULE_FOR_POSE[foeWound], dimsOf(foe).hat, b.vel);
        if (r.head || r.body) {
          sim.kill(b);
          const point = new THREE.Vector3(r.point[0], r.point[1], r.point[2]);
          const dir = new THREE.Vector3(b.vel[0], b.vel[1], b.vel[2]).normalize();
          gunsmoke.dust(point, dir, "body");
          transport.send({ type: "Hit", tick: machine.tick, head: r.head, damage: r.head ? 999 : bodyDamage(gun.baseDamage, distM) });
          if (r.head) { killFoe(true, point, dir); }
          else {
            const dmg = bodyDamage(gun.baseDamage, distM);
            lifesteal(Math.min(dmg, foeHP));
            if (hellRound || dmg >= foeHP) killFoe(false, point, dir); // hell: any hit kills
            else woundFoe(dmg);
          }
        }
      } else if (b.shooter === "foe" && playerHP > 0) {
        const r = testCapsuleHit(b.pos, stage.player, CAPSULE_FOR_POSE[playerWound], dimsOf(player).hat, b.vel);
        if (r.head || r.body) {
          sim.kill(b);
          const point = new THREE.Vector3(r.point[0], r.point[1], r.point[2]);
          const dir = new THREE.Vector3(b.vel[0], b.vel[1], b.vel[2]).normalize();
          gunsmoke.dust(point, dir, "body");
          transport.send({ type: "Hit", tick: machine.tick, head: r.head, damage: r.head ? 999 : bodyDamage(GUNS.default.baseDamage, distM) });
          if (r.head) hitPlayer(true, 999, point, dir);
          else {
            const dmg = bodyDamage(GUNS.default.baseDamage, distM);
            hitPlayer(false, hellRound ? Math.max(dmg, playerHP) : dmg, point, dir); // hell: any hit kills
          }
        }
      }
    }
  }

  function focusPenalty(): void {
    cross.classList.add("penalty");
    window.setTimeout(() => cross.classList.remove("penalty"), 180);
  }
  /** Needle speed follows the crosshair: log scale, since every QTE press
      multiplies the bloom (start -> 1, bloomMin -> 0). */
  function qteSpeedFromBloom(): void {
    const k = Math.log(machine.bloomDeg / gun.bloomMinDeg) / Math.log(gun.bloomStartDeg / gun.bloomMinDeg);
    qte.setSize(k);
  }
  function qtePress(): void {
    if (machine.phase !== "focus" || machine.paused) return;
    const res = qte.press(qteExtra());
    if (!res) return; // still showing the last result
    machine.addQte(res);
    qteSpeedFromBloom();
    focusUI.flash(res);
    if (res === "miss") focusPenalty();
  }
  const focusUI: FocusUI = mountFocusUI(root, { onPress: qtePress });
  // Ring QTE on the holster zone (user 2026-10-05: on the foe it always
  // told where he stands, which defeats the night fog); its radius is the
  // crosshair radius (floored so the arc stays readable at the smallest
  // blooms / phone heights).
  const RING_MIN_R = 16;
  function renderQte(needle: number): void {
    const zr = zone.getBoundingClientRect();
    const c = { x: zr.left + zr.width / 2, y: zr.top + zr.height / 2 };
    focusUI.render({
      needle,
      zoneC: qte.zoneC,
      zoneW: qte.zoneW,
      perfectW: qte.perfectW,
      streak: qte.streak,
      stunned: qte.stunned,
      x: c.x,
      y: c.y,
      r: Math.max(RING_MIN_R, crossPx() / 2),
    });
  }
  renderQte(qte.pos);

  // ---- input routing ----
  const touchDown = new Map<number, { x: number; y: number; t: number; moved: boolean }>();

  const onMouseMove = (e: MouseEvent) => {
    pointerPx.x = e.clientX;
    pointerPx.y = e.clientY;
    lastPointer = { x: e.clientX, y: e.clientY };
    pointerKnown = true;
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
    if (e.pointerType === "mouse") { lastPointer = { x: zx, y: zy }; pointerKnown = true; }

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
        qte.stun(); // same 0.4s needle stall as a QTE miss (anti-spam)
        qteSpeedFromBloom();
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
    if (quick && still && (machine.phase === "draw" || machine.phase === "fire")) {
      // tap (no drag): fire where it landed. (Was `!still`: only a quick
      // flick fired and a plain tap never did, against the locked 09-26
      // "drag aims, quick-tap fires".)
      aimFromClient(e.clientX, e.clientY);
      attemptFire(e.clientX, e.clientY);
    }
  };
  root.addEventListener("pointerup", onPointerUp);
  root.addEventListener("pointercancel", onPointerUp);

  function cleanup(): void {
    alive = false;
    audio.stopWind();
    document.body.classList.remove("in-duel");
    document.body.style.background = "";
    for (const t of foeTimers) window.clearTimeout(t);
    try { hellSet?.dispose(); } catch { /* noop */ }
    try { mapSet?.dispose(); } catch { /* noop */ }
    try { if (playerDoll) playerDoll.dispose(); } catch { /* noop */ }
    try { if (foeDoll) foeDoll.dispose(); } catch { /* noop */ }
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("resize", onResize);
    vv?.removeEventListener("resize", onResize);
    root.removeEventListener("pointerdown", onPointerDown);
    cueFit.disconnect();
    root.removeEventListener("pointermove", onPointerMove);
    root.removeEventListener("pointerup", onPointerUp);
    root.removeEventListener("pointercancel", onPointerUp);
    focusUI.destroy();
    coach?.destroy();
    ambientFx.dispose();
    playerShadow.dispose();
    foeShadow.dispose();
    cancelAnimationFrame(raf);
    // The session's one GL context stays (render/arena.ts): free what this
    // duel uploaded, keep the compiled programs + cached GLB geometry.
    release();
  }

  function onResize(): void {
    fitCamera();
    updateZone();
    fitCue();
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

  /** Pose one duelist's arm + gun along the quick-draw (direct set: the
      path is already smooth, a chase would blur the fast pull). */
  function stepQuickDraw(c: Cowboy, from: { s: number; z: number; e: number }, lift: number): void {
    const q = quickDraw(drawT, from);
    c.armR.rotation.x = q.s + lift;
    c.armR.rotation.z = q.z;
    c.elbowR.rotation.x = q.e - lift;
    c.drawStep?.(gunOut(drawT));
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
  let punchT = -1;
  let shakeT = 0;
  let shakeAmp = 0;
  const camSaved = { p: new THREE.Vector3(), q: new THREE.Quaternion() };
  const _shk = new THREE.Vector3();
  /** Kick the render-only camera shake (metres at the start, decays ~0.3s). */
  function shakeCam(a: number): void {
    shakeAmp = Math.max(shakeAmp * Math.exp(-shakeT * 14), a);
    shakeT = 0;
  }
  /** Boots scuff the dirt as both duelists draw (one puff each, cosmetic). */
  function drawDust(): void {
    for (const c of [player, foe]) {
      const at = c.group.position.clone();
      at.y = 0.06;
      gunsmoke.dust(at, _dustDir.set(Math.random() - 0.5, 0, Math.random() - 0.5), "ground");
    }
  }
  const _dustDir = new THREE.Vector3();
  let proneCam = 0; // eased 0..1 toward the player-prone camera framing

  // Initial cue per device.
  cue.textContent = "HOLSTER UP";
  sub.textContent = coarse ? "TAP the holster zone to begin" : "Move your mouse INTO the holster zone";
  updateZone();

  // Shadow decal rides the pelvis (so it follows the ragdoll), shortens with
  // the wound pose (a crouch casts less), pools round under a corpse.
  const shadowFeet = new THREE.Vector3();
  function placeShadow(d: ShadowDecal, c: Cowboy, wound: WoundPose, hp: number, doll: Ragdoll | null): void {
    const src = c.parts.pelvis ?? c.group;
    src.getWorldPosition(shadowFeet);
    d.place(shadowFeet, CAPSULE_FOR_POSE[wound].headY, hp <= 0 || !!doll?.fallen);
  }

  /** Per frame until the duel is ready to play (cold-visit loading bar). */
  function tickLoading(): void {
    if (!loading) return;
    const live = drawState === "live";
    if (((assetsIn || !loadingEl) && live) || performance.now() - loadT0 > LOAD_MAX_MS) {
      loading = false;
      loadingEl?.remove();
      loadingEl = null;
      // The mouse already waiting in the holster zone starts Focus now.
      if (!coarse && pointerKnown && inZone(pointerPx.x, pointerPx.y)) beginFocus();
      return;
    }
    if (loadBar) loadBar.style.width = `${Math.round((loadFraction(assetUrls) * 0.9 + (assetsIn && live ? 0.1 : 0)) * 100)}%`;
  }
  function frame(): void {
    if (!alive) return;
    raf = requestAnimationFrame(frame);
    tickLoading();
    const rawDt = clock.getDelta();
    const dt = Math.min(rawDt, 0.1);
    // Watchdog on WALL time: the clamped dt hid 300ms frames as 100ms and
    // took ~5s to shed the load on software GL.
    noteFrame(rawDt);
    playerSway?.sense(dt);
    foeSway?.sense(dt);
    // ONE fixed clock for all physics (spec: consistent across 60/144/165Hz,
    // delta-time not frame count). Rendering interpolates by alpha below.
    const alpha = stepper.advance(dt, () => {
      machine.step(STEP);
      if (drawTick < 0 && (machine.phase === "draw" || machine.phase === "fire")) {
        drawTick = machine.tick;
        drawDust();
        const fq = ai.focusQuality;
        foeAim.bloomDeg = foeGun.bloomStartDeg - (foeGun.bloomStartDeg - foeGun.bloomMinDeg) * fq;
      }
      if (machine.phase === "focus" && !machine.paused) qte.advance(STEP);
      // Bloom after DRAW: holding without firing regrows the base (locked
      // 09-26 §1); shots kick it x1.5 and hits rubber-band it out, both
      // returning to the base (DuelMachine.recoverKick). Neither runs in
      // ready/focus: free shrink there drifted the crosshair gap + keybar
      // fill on mere hover, breaking the locked tap-only focus feel.
      if (machine.phase === "draw") machine.regrow(STEP);
      if (machine.phase === "draw" || machine.phase === "fire") machine.recoverKick(STEP); // shot kick / hit rubber band
      if (drawTick >= 0) {
        if (!foeFired) foeAim.regrow(STEP);
        foeAim.recoverKick(STEP);
      }
      stepBullets();
      bulletImpacts();
      // Ammo-out re-check once the last bullet lands. maybeEnd only ran on
      // kills and on the player's last shot, so when the foe fired last
      // and hit non-lethally or missed,
      // the round never resolved (soft lock, user report 2026-10-05).
      if (!roundOver && ammo <= 0 && (foeAmmo <= 0 || mode === "tutorial") && !sim.bullets.some((b) => b.alive)) maybeEnd();
      // Corpse physics lives on the same fixed clock (null-safe).
      try { if (foeDoll?.fallen) foeDoll.fixedStep(STEP); } catch { /* fallback already fell */ }
      try { if (playerDoll?.fallen) playerDoll.fixedStep(STEP); } catch { /* noop */ }
      playerSway?.fixedStep(STEP);
      foeSway?.fixedStep(STEP);
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
      if (drawT < QD_END) {
        stepQuickDraw(foe, drawFrom.foe, armLift(foe));
      } else {
        foe.drawStep?.(1);
        const fk = 0.3 * Math.exp(-foeKickT * 10);
        chaseArm(0.05 + armLift(foe), -armLift(foe), dt, foe.armR, foe.elbowR, fk);
      }
      foe.group.rotation.z = foeRoll - 0.03 * Math.exp(-foeKickT * 7); // firing rock over wound roll
    }
    const foeDip = foeFlinchT < 0.35 ? Math.sin((foeFlinchT / 0.35) * Math.PI) * 0.07 : 0;
    const playerDip = playerFlinchT < 0.35 ? Math.sin((playerFlinchT / 0.35) * Math.PI) * 0.07 : 0;
    // Wound poses: damped chase toward the lottery pose (lunge/prone).
    // Feet stay planted (group-level pitch + y-drop only); corpses and the
    // dead are skipped inside woundStep so death hands off with no snap.
    [foeDrop, foeRoll] = woundStep(foe, foeWound, foeHP, foeDoll, dt, foeDrop, foeRoll);
    [playerDrop, playerRoll] = woundStep(player, playerWound, playerHP, playerDoll, dt, playerDrop, playerRoll);
    driveJoints(foe, foeWound, foeHP, foeDoll, dt);
    driveJoints(player, playerWound, playerHP, playerDoll, dt);
    if (!foeDoll?.fallen && foeHP > 0) foe.group.position.y = foeDrop + Math.sin(swayT * 2.1) * 0.012 - foeDip;
    if (!playerDoll?.fallen && playerHP > 0) player.group.position.y = playerDrop + Math.sin(swayT * 2.1 + 1.3) * 0.012 - playerDip;

    if (machine.phase === "ready" && !coarse && !roundOver) {
      // HOLSTER UP: the OS cursor is hidden in-duel, so the pointer cross
      // shows from the first frame (at the last known mouse position) to
      // guide the mouse into the holster. Hidden only until the mouse is
      // known (first move of the session).
      cross.style.display = pointerKnown ? "block" : "none";
      cross.classList.add("focusing");
      if (pointerKnown) placeCross(pointerPx.x, pointerPx.y);
    }
    if (machine.phase === "ready") renderQte(qte.pos); // ring rides the holster zone (laid out after the first render)
    zone.classList.toggle("qting", machine.phase === "focus" && !machine.paused); // label off while the ring runs in it
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
        sub.textContent = coarse ? "Tap when the marker is on the gold arc" : "SPACE / ENTER when the marker is on the gold arc · don't click";
      }
      renderQte(qte.peek(machine.paused ? 0 : alpha * STEP)); // out of the holster: frozen
      focusUI.setProgress(1 - (machine.bloomDeg - gun.bloomMinDeg) / (gun.bloomStartDeg - gun.bloomMinDeg));
      // Crosshair lives where the pointer is — never pinned to the foe.
      // Aim itself stays parked (gun down) until DRAW.
      placeCross(pointerPx.x, pointerPx.y);
    } else if ((machine.phase === "draw" || machine.phase === "fire") && !tracking) {
      tracking = true;
      cue.textContent = hellRound ? "DRAW! — FIRST HIT WINS" : "DRAW!";
      popCue();
      coach?.step("draw");
      sub.textContent = coarse ? "Drag to aim · tap to fire!" : "Aim with mouse · click to fire!";
      focusUI.setVisible(false);
      zone.style.display = "none";
      // Quick-draw starts from wherever the hand rests on the holster (idle
      // clip pose / procedural solve), read before the clips stop.
      drawFrom.player = { s: player.armR.rotation.x, z: player.armR.rotation.z, e: player.elbowR.rotation.x };
      drawFrom.foe = { s: foe.armR.rotation.x, z: foe.armR.rotation.z, e: foe.elbowR.rotation.x };
      // From DRAW the procedural choreography + aim own both gun arms. The
      // looping idle clip (keyed at the guns-down 0.55) was still rewriting
      // armR/elbowR every mixer update, so the chase only ever won a
      // dt-dependent fraction: the foe's gun sagged (0.22 vs 0.05 rad) and
      // the sag depended on the refresh rate.
      try { (foe as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      try { (player as unknown as CowboyGlb).stopClips?.(); } catch { /* noop */ }
      drawT = 0; // quick-draw runs for both duelists
      cross.style.display = "block";
      cross.classList.remove("focusing");
      scheduleFoe();
    }

    if (tracking && !roundOver && (!aimEngaged || drawT < QD_END)) {
      // Pre-engagement (and always during the quick-draw): crosshair glued to the pointer (as in Focus) — never
      // self-moves — while the hand pulls from the holster and sweeps up
      // through the choreography. First input blends straight into aim via
      // the damped chase (no snap).
      placeCross(pointerPx.x, pointerPx.y);
      kickT += dt;
      if (drawT < QD_END) {
        stepQuickDraw(player, drawFrom.player, armLift(player));
      } else {
        player.drawStep?.(1);
        poseArm(0.0, dt, 0);
      }
    }

    if (tracking && aimEngaged && !roundOver && drawT >= QD_END) { // the quick-draw owns the arm first
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
    placeShadow(foeShadow, foe, foeWound, foeHP, foeDoll);
    placeShadow(playerShadow, player, playerWound, playerHP, playerDoll);

    gunsmoke.update(dt);
    // Player prone (alive or a corpse that died prone) lies back toward the
    // camera: ease to the prone framing so the body stays on screen.
    proneCam += ((playerWound === "prone" ? 1 : 0) - proneCam) * (1 - Math.exp(-dt * 4));
    setProneFrame(proneCam);
    // Kill punch: a short push-in (camera.zoom narrows the FOV) once the round is decided. Only
    // after roundOver (aim/hit tests read the camera; they're off by then).
    if (punchT >= 0 && punchT < 0.6) {
      punchT += dt;
      const u = Math.min(1, punchT / 0.45);
      camera.zoom = 1 + 0.06 * (1 - (1 - u) * (1 - u) * (1 - u));
      camera.updateProjectionMatrix();
    }
    const nowSec = performance.now() / 1000;
    street?.tick(nowSec);
    mapSet?.tick(nowSec);
    hellSet?.tick(nowSec);
    ambientFx.tick(nowSec, renderer.getPixelRatio());
    playerSway?.render(alpha);
    foeSway?.render(alpha);
    // Hit shake is render-only: offset the camera for this draw and put it
    // back, so aim, projection and hit tests never see it.
    shakeT += dt;
    const amp = shakeAmp * Math.exp(-shakeT * 14);
    if (amp > 1e-4) {
      camSaved.p.copy(camera.position);
      camSaved.q.copy(camera.quaternion);
      const t = shakeT * 60;
      _shk.set(Math.sin(t * 0.91) + 0.5 * Math.sin(t * 2.3), Math.sin(t * 1.13 + 1) + 0.5 * Math.sin(t * 2.9), 0)
        .multiplyScalar(amp).applyQuaternion(camera.quaternion);
      camera.position.add(_shk);
      camera.rotateZ(amp * 0.3 * Math.sin(t * 1.7));
      camera.updateMatrixWorld();
      draw();
      camera.position.copy(camSaved.p);
      camera.quaternion.copy(camSaved.q);
      camera.updateMatrixWorld();
    } else {
      shakeAmp = 0;
      draw();
    }
  }
  // First draw waits for prepare(): from the first animation frame (the
  // cached GLB rigs + set have swapped in by then) the scene's new shaders
  // compile off the main thread; a warm session resolves at once. Before
  // that a draw would compile synchronously (the old round-start freeze).
  let drawState: "setup" | "wait" | "compiling" | "live" = "setup";
  function draw(): void {
    if (drawState === "live") { render(); return; }
    if (drawState !== "wait") return;
    drawState = "compiling";
    void prepare(scene).then(() => {
      if (!alive) return;
      drawState = "live";
      renderer.domElement.style.visibility = "";
    });
  }
  frame();
  drawState = "wait";
}
