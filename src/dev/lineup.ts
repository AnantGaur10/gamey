// DEV lineup for preview / store photos (tools/lineup.html; query reference
// there). The game's own arena (sky, fog, time of day, grade, rim light) and
// map sets, the shipped cowboy GLBs, posed in a row where the foe stands,
// facing the camera. Never imported by the game (not in the build).
import * as THREE from "three";
import { createArena, stagePositions, faceToward, createShadowDecal } from "../render/arena";
import { loadCowboyGlb, type CowboyGlb } from "../render/cowboyGlb";
import { loadStreetGlb } from "../render/streetGlb";
import { loadMapSet } from "../render/setGlb";
import { MAPS, type MapId } from "../render/maps";
import { FOE_LOOKS, type FoeLookId } from "../render/foes";
import { LEVELS } from "../game/levels";
import { paintGun } from "../render/cowboy";
import { gaitRig } from "../render/townsfolk";
import { limbGaps, bendAngles } from "./anatomy";

type Pose = "idle" | "draw" | "victory" | "walk";
type Who = "hero" | FoeLookId;

const q = new URLSearchParams(location.search);
const num = (k: string, def: string): number[] => (q.get(k) ?? def).split(",").map(Number);
const mapId = (q.get("map") ?? "town") as MapId | "none";
const todQ = q.get("tod") ?? "0";
const hell = todQ === "hell";
const stage = hell ? 2 : Math.max(0, Math.min(2, Number(todQ) || 0));
const LADDER: Who[] = LEVELS.map((l) => l.foe);
const whoQ = q.get("who") ?? "all";
const who: Who[] = whoQ === "all" ? ["hero", ...LADDER] : whoQ === "ladder" ? LADDER : (whoQ.split(",").filter(Boolean) as Who[]);
const poseQ = q.get("pose") ?? "mixed";
const MIXED: Pose[] = ["draw", "idle", "victory", "walk"];
const poseOf = (i: number): Pose => (poseQ === "mixed" ? MIXED[i % MIXED.length] : poseQ === "aim" ? "draw" : (poseQ as Pose));
const gap = Number(q.get("gap") ?? 1.15);
const nameOf = (w: Who): string => (w === "hero" ? "YOU" : LEVELS.find((l) => l.foe === w)?.name ?? w.toUpperCase());

const DIST = 12;
const root = document.getElementById("app")!;
const arena = createArena(DIST);
const { scene, camera, renderer } = arena;
root.appendChild(renderer.domElement);
renderer.domElement.style.position = "absolute";
renderer.domElement.style.inset = "0";

const mapDef = mapId === "none" ? MAPS.street : MAPS[mapId];
arena.setTimeOfDay(mapDef.tod(stage, hell));
const base = import.meta.env.BASE_URL;
const loads: Array<Promise<unknown>> = [];
if (mapId === "street") {
  arena.buildProceduralStreet();
  loads.push(loadStreetGlb(`${base}models/street.glb`, DIST).then(async (s) => {
    if (!s) return;
    await arena.prepare(s.group);
    for (const n of ["ProceduralStreet", "ProceduralDressing"]) { const o = scene.getObjectByName(n); if (o) o.visible = false; }
    s.setGlow(hell ? 1 : [0, 0.55, 1][stage]);
    scene.add(s.group);
  }));
} else if (mapId !== "none" && mapDef.glb) {
  arena.setFloor(mapDef.floor);
  loads.push(loadMapSet(`${base}models/${mapDef.glb}`, DIST, mapDef.paintGain).then(async (s) => {
    if (!s) return;
    s.setHell(hell);
    s.setGlow(hell ? 1 : mapDef.glow[stage]);
    s.setWindow(mapDef.window[hell ? 3 : stage]);
    s.setShaft(mapDef.shaft[hell ? 3 : stage]);
    s.setNightVis(!hell && stage === 2 ? mapDef.nightVis ?? null : null);
    await arena.prepare(s.group);
    scene.add(s.group);
  }));
}

// No duel furniture in a photo: the arena's gold marker ring under the foe.
scene.traverse((o) => {
  const m = o as THREE.Mesh;
  if (m.isMesh && m.geometry?.type === "RingGeometry") m.visible = false;
});

// The row stands where the foe would, facing the player's side.
const { player: pPos, foe: fPos } = stagePositions(DIST);
const row = new THREE.Group();
row.position.copy(fPos);
faceToward(row, fPos, pPos);
scene.add(row);

interface Posed { rig: CowboyGlb; label: HTMLElement | null; walk: ((p: number, a: number) => number) | null; phase: number; slot: number }
const posed: Posed[] = [];
const feet = new THREE.Vector3();
who.forEach((w, i) => {
  const url = `${base}models/${w === "hero" ? "cowboy_hero.glb" : FOE_LOOKS[w].glb}`;
  const prefix = w === "hero" ? "H" : "O";
  loads.push(loadCowboyGlb(url, prefix).then((rig) => {
    if (!rig) return;
    rig.group.position.set((i - (who.length - 1) / 2) * gap, 0, 0);
    rig.group.rotation.y = 0; // +Z = toward the camera side
    row.add(rig.group);
    if (w === "hero") paintGun(rig.gun, q.get("gun") ?? "default");
    const pose = poseOf(i);
    let walk: Posed["walk"] = null;
    if (pose === "idle" || pose === "walk") {
      rig.holster?.();
      if (rig.hasClip("idle")) rig.playClip("idle", true);
      if (pose === "walk") walk = gaitRig(rig);
    } else if (pose === "draw") {
      rig.stopClips(); // the loader starts `idle`, which rewrites the gun arm every frame
      rig.drawStep?.(1);
      aimAtCamera(rig);
    } else {
      rig.drawStep?.(1);
      rig.setRaised();
      if (rig.hasClip("victory")) rig.playClip("victory");
    }
    const label = q.get("labels") ? Object.assign(document.createElement("div"), { className: "lbl", textContent: nameOf(w) }) : null;
    if (label) document.body.appendChild(label);
    const shadow = createShadowDecal(scene);
    rig.group.updateWorldMatrix(true, false);
    rig.group.getWorldPosition(feet);
    shadow.place(feet, 1.9, false);
    posed.push({ rig, label, walk, phase: 0.6 + i * 1.3, slot: i });
  }));
});

/** Gun drawn, barrel at the lens: the shoulder + elbow angles (whatever sign
    the rig's frame gives them) that point the barrel (grip -> muzzle) most
    squarely at the camera, held a little out from the body. The visible arm
    follows through the game's own IK (cowboyGlb armVisualIk). */
function aimAtCamera(rig: CowboyGlb): void {
  const tip = new THREE.Vector3(), grip = new THREE.Vector3(), want = new THREE.Vector3(), dir = new THREE.Vector3();
  let best = [0, 0, 0], bestScore = Infinity;
  const grid = (a0: number, a1: number, e0: number, e1: number, y0: number, y1: number, step: number, ystep: number) => {
    for (let yw = y0; yw <= y1 + 1e-9; yw += ystep) {
      for (let a = a0; a <= a1; a += step) {
        for (let e = e0; e <= e1; e += step) {
          rig.armR.rotation.set(a, yw, 0);
          rig.elbowR.rotation.x = e;
          rig.group.updateWorldMatrix(true, true);
          rig.gunTip.getWorldPosition(tip);
          (rig.gun ?? rig.gunTip).getWorldPosition(grip);
          dir.subVectors(tip, grip).normalize();
          want.subVectors(camera.position, tip).normalize();
          // Barrel square to the lens first; then a muzzle well out in front.
          const score = (1 - dir.dot(want)) + 0.02 * tip.distanceTo(camera.position);
          if (score < bestScore) { bestScore = score; best = [a, e, yw]; }
        }
      }
    }
  };
  // The duel aims across with armR.rotation.y too: search pitch, elbow, yaw.
  grid(-2, 2, -1.6, 1.6, -0.8, 0.8, 0.1, 0.2);
  grid(best[0] - 0.1, best[0] + 0.1, best[1] - 0.1, best[1] + 0.1, best[2] - 0.2, best[2] + 0.2, 0.02, 0.05);
  rig.armR.rotation.set(best[0], best[2], 0);
  rig.elbowR.rotation.x = best[1];
}

// Camera in lineup space (origin = the row's centre on the ground).
const width = (who.length - 1) * gap + 1.2;
const fov = Number(q.get("fov") ?? 40);
const fitZ = Math.max(4, (width / 2 / Math.tan((fov * Math.PI) / 360)) * (innerHeight / innerWidth) * 1.15 + 1);
const [cx, cy, cz] = num("cam", `0,1.5,${fitZ.toFixed(2)}`);
const [lx, ly, lz] = num("look", "0,1.05,0");
function placeCamera(): void {
  row.updateMatrixWorld(true);
  camera.fov = fov;
  camera.aspect = innerWidth / innerHeight;
  camera.position.copy(row.localToWorld(new THREE.Vector3(cx, cy, cz)));
  camera.lookAt(row.localToWorld(new THREE.Vector3(lx, ly, lz)));
  camera.updateProjectionMatrix();
}
arena.fitCamera();
placeCamera();
addEventListener("resize", () => { arena.fitCamera(); placeCamera(); });

const head = new THREE.Vector3();
let last = performance.now();
function frame(): void {
  requestAnimationFrame(frame);
  const now = performance.now();
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  for (const p of posed) {
    p.rig.update(dt);
    if (p.walk) p.rig.group.position.y = -p.walk(p.phase, 0.45); // a frozen mid-stride: a photo, not a clip
    if (p.label) {
      (p.rig.parts.pelvis ?? p.rig.group).getWorldPosition(head);
      head.y = 0.05;
      head.project(camera);
      p.label.style.left = `${((head.x + 1) / 2) * innerWidth}px`;
      p.label.style.top = `${((1 - head.y) / 2) * innerHeight + 4 + (p.slot % 2) * 18}px`; // staggered: long names never overlap
    }
  }
  arena.render();
}
frame();
void Promise.all(loads).then(() => setTimeout(() => ((window as unknown as { __ready: boolean }).__ready = true), 1500));
// Anatomy gaps per posed cowboy (src/dev/anatomy.ts): 0 = joint contiguous.
(window as unknown as { __anatomy: () => unknown }).__anatomy = () =>
  posed.map((p, i) => {
    const pre = p.rig.group.getObjectByName("H_Pelvis") ? "H" : "O";
    p.rig.solveArm?.();
    return { i, gaps: limbGaps(p.rig.group, pre), bend: bendAngles(p.rig.group, pre) };
  });
