import * as THREE from "three";
import { makeGunHolster, type Cowboy } from "./cowboy";
import { addRimLight } from "./arena";
import { pivotMesh, type SwayNode } from "./sway";

// Loads a Blender-exported cowboy GLB and adapts it to the Cowboy seam so
// game logic never knows the difference. Returns null on ANY failure —
// caller keeps the procedural cowboy (AdBlock/offline/private-mode safe).
// GLBs are +Y-up with model front at -Z (Blender +Y forward through the
// export_yup rotation); inner yaw of PI aims the model at +Z to match
// faceToward(). Pivot empties H_/O_armR/elbowR/gunTip drive the gun arm
// exactly like the procedural armR/elbowR Groups.
export interface CowboyGlb extends Cowboy {
  /** AnimationMixer when the GLB ships clips, else null (procedural no-op path). */
  mixer: THREE.AnimationMixer | null;
  /** True when at least one clip matches name (rig prefix + split aware). */
  hasClip(name: string): boolean;
  /** Play EVERY clip matching name (exporter splits joints: H_draw_armR +
      H_draw_elbowR). Stops other actions first so idle never fights draw.
      loop=true for idle, once+clamp for flourishes. reset() first so a
      finished LoopOnce (e.g. second death after revive) replays cleanly;
      fadeIn blends from the live pose so clips never snap. No-op when absent. */
  playClip(name: string, loop?: boolean): void;
  /** Stop all clip playback (procedural arm takes over). No-op without mixer. */
  stopClips(): void;
  /** Play matches then freeze at their final frame (post-mortem GLB swaps:
      the fresh corpse must arrive already fallen, never re-animate). */
  playFrozen(name: string): void;
  /** Advance mixer; call every frame (no-op without clips). */
  update(dt: number): void;
  /** Hat + coat-tail pivots for render/sway.ts (empty on old GLBs). */
  sway: SwayNode[];
}

let sharedMat: THREE.MeshLambertMaterial | null = null;
function cowboyMaterial(): THREE.MeshLambertMaterial {
  if (!sharedMat) {
    sharedMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
    addRimLight(sharedMat);
  }
  return sharedMat;
}
function rimLambert(color: THREE.Color | undefined): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color: color ?? 0xcccccc, flatShading: true });
  addRimLight(m);
  return m;
}

export async function loadCowboyGlb(
  url: string,
  prefix: "H" | "O",
): Promise<CowboyGlb | null> {
  try {
    const { GLTFLoader } = await import(
      "three/examples/jsm/loaders/GLTFLoader.js"
    );
    const gltf = await new GLTFLoader().loadAsync(url);
    const inner = gltf.scene;
    // Cull collection-leak stowaways at any depth (e.g. St_Sign_* street
    // texts once shipped inside cowboy_outlaw.glb, floating above the head
    // and falling with setFall). Only the rig prefix belongs to the cowboy;
    // unnamed containers are kept, named mismatches are dropped with their
    // whole subtree.
    const strays: THREE.Object3D[] = [];
    inner.traverse((o) => {
      if (o !== inner && o.name && !o.name.startsWith(`${prefix}_`)) {
        strays.push(o);
      }
    });
    for (const s of strays) s.removeFromParent();
    // Palette x baked AO ride in COLOR_0 (build_glbs.py), so the loader's PBR
    // material is swapped for one flat Lambert (cheaper per pixel on low-end
    // GPUs, same shading as the street) with the rim light. Old GLBs without
    // COLOR_0 keep their material colour.
    inner.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.material = m.geometry.getAttribute("color")
        ? cowboyMaterial()
        : rimLambert((m.material as THREE.MeshStandardMaterial).color);
    });
    // Self-center: modeling space is NOT origin-centered (Outlaw stood ~3.5m
    // off-origin beside Hero in the .blend), but game logic (hit capsule,
    // marker rings, ragdoll bodies, gun-side math) all live at the group
    // origin. Without this the visual renders meters from its own hitbox.
    // Order matters: yaw FIRST, then measure. inner.position lives in the
    // parent frame, so the bbox must be read after the PI rotation —
    // centering in the unrotated frame doubles the error instead of fixing it.
    // X/Z only — Y stays authored so feet remain grounded.
    inner.rotation.y = Math.PI;
    inner.updateMatrixWorld(true);
    const bbox = new THREE.Box3().setFromObject(inner);
    if (!bbox.isEmpty()) {
      const center = bbox.getCenter(new THREE.Vector3());
      inner.position.x -= center.x;
      inner.position.z -= center.z;
    }
    // Wrap in an `anim` group so idle/victory clips never fight setFall on
    // the outer group (locked Slice-8 seam): anim = performance, outer = death.
    const anim = new THREE.Group();
    anim.name = `${prefix}_anim`;
    anim.add(inner);
    const group = new THREE.Group();
    // YXZ like the procedural rig (see cowboy.ts): wound pitches lean local.
    group.rotation.order = "YXZ";
    group.add(anim);
    // Sway pivots (build_glbs.py keeps the hat and coat tails as their own
    // meshes): the hat rocks on its brim, the tails hang from their tops.
    const sway: SwayNode[] = [];
    inner.updateMatrixWorld(true);
    for (const [n, kind] of [["Hat", "hat"], ["CoatTail_L", "tail"], ["CoatTail_R", "tail"]] as const) {
      const m = inner.getObjectByName(`${prefix}_${n}`);
      if (!m) continue;
      const b = new THREE.Box3().setFromObject(m);
      if (b.isEmpty()) continue;
      const at = b.getCenter(new THREE.Vector3());
      at.y = kind === "hat" ? b.min.y : b.max.y;
      const pivot = pivotMesh(m, at, `${prefix}_${n}Pivot`);
      if (pivot) sway.push({ pivot, kind });
    }
    const armR = inner.getObjectByName(`${prefix}_armR`) as THREE.Group | undefined;
    const elbowR = inner.getObjectByName(`${prefix}_elbowR`) as THREE.Group | undefined;
    const gunTip = inner.getObjectByName(`${prefix}_gunTip`);
    if (!armR || !elbowR || !gunTip) return null;

    function setGunsDown(): void {
      armR!.rotation.set(0.55, 0, 0); // muzzle toward dirt (standoff pose)
      elbowR!.rotation.x = -0.25;
    }
    function setRaised(): void {
      armR!.rotation.set(0.05, 0, 0); // muzzle level toward the foe
      elbowR!.rotation.x = 0;
    }
    function setFall(dead: boolean): void {
      group.rotation.x = dead ? -Math.PI / 2 + 0.12 : 0;
      group.position.y = dead ? 0.35 : 0;
    }
    setGunsDown();
    // Per-part ragdoll refs by node name (null-safe: missing parts are
    // skipped by the ragdoll, which degrades to fewer bodies, never a crash).
    // Right arm binds the armR PIVOT so the whole gun assembly follows it.
    const byName = (n: string): THREE.Object3D | null => inner.getObjectByName(`${prefix}_${n}`) ?? null;
    const parts = {
      pelvis: byName("Pelvis"),
      torso: byName("Torso"),
      head: byName("Head"),
      upperArmL: byName("Sleeve_L"),
      upperArmR: armR as unknown as THREE.Object3D,
      thighL: byName("Leg_L"),
      thighR: byName("Leg_R"),
      shinL: byName("Shin_L"),
      shinR: byName("Shin_R"),
      forearmR: elbowR as unknown as THREE.Object3D,
    };
    // Wound-pose joints (null-safe: older GLBs lack Knee/Waist nodes and
    // simply keep the group-tilt fallback path).
    const joints = {
      thighL: byName("Leg_L"),
      thighR: byName("Leg_R"),
      kneeL: byName("Knee_L"),
      kneeR: byName("Knee_R"),
      waist: byName("Waist"),
      head: byName("Head"),
      // Leg_L/R pivot mid-thigh (y 0.52); the thigh/chaps mesh tops out at
      // the pelvis underside (~0.78), which is where a hip should bend.
      hipLift: 0.26,
      // Sleeve_L (with forearm + hand) and the separate cuff hang off the
      // torso; the shoulder sits just under the pad (torso-local y 0.28).
      armL: (() => {
        const n = [byName("Sleeve_L"), byName("Cuff_L")].filter((o): o is THREE.Object3D => !!o);
        return n.length ? { nodes: n, pivot: new THREE.Vector3(-0.36, 0.25, 0) } : null;
      })(),
      hips: byName("Pelvis"),
      // Joints sit under `inner` (rotation.y = PI): local x is mirrored.
      sign: -1 as const,
    };
    // Mixer seam: play shipped clips when present (Blender session lands the
    // full set later); procedural no-op path keeps behavior identical without.
    let mixer: THREE.AnimationMixer | null = null;
    try {
      if (gltf.animations && gltf.animations.length > 0) {
        mixer = new THREE.AnimationMixer(anim);
      }
    } catch {
      mixer = null;
    }
    function norm(n: string): string {
      return n.replace(/^[HO]_/i, "").toLowerCase();
    }
    function matches(name: string): THREE.AnimationClip[] {
      const want = name.toLowerCase();
      return gltf.animations.filter((a) => {
        const n = norm(a.name);
        return n === want || n.startsWith(want + "_");
      });
    }
    function hasClip(name: string): boolean {
      if (!mixer) return false;
      return matches(name).length > 0;
    }
    function playClip(name: string, loop = false): void {
      if (!mixer) return;
      const found = matches(name);
      if (found.length === 0) return;
      mixer.stopAllAction();
      for (const clip of found) {
        const action = mixer.clipAction(clip);
        action.reset();
        if (loop) {
          action.setLoop(THREE.LoopRepeat, Infinity);
        } else {
          action.setLoop(THREE.LoopOnce, 1);
          action.clampWhenFinished = true;
        }
        action.fadeIn(0.15);
        action.play();
      }
    }
    function playFrozen(name: string): void {
      if (!mixer) return;
      const found = matches(name);
      if (found.length === 0) return;
      mixer.stopAllAction();
      for (const clip of found) {
        const action = mixer.clipAction(clip);
        action.reset();
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        action.play();
        action.time = clip.duration;
      }
      mixer.update(0);
    }
    function stopClips(): void {
      if (mixer) mixer.stopAllAction();
    }
    function update(dt: number): void {
      if (mixer) mixer.update(Math.min(dt, 0.1));
    }
    // Idle sways whenever clips exist and nothing else plays (flinch/
    // victory stop it via playClip's stop-all; engage stops it via stopClips).
    playClip("idle", true);
    // Revolver node + holster socket (build_glbs.py). Old GLBs lack them:
    // makeGunHolster no-ops and the gun stays in hand. The idle clip keys the
    // hand onto the holstered grip, so holster() only moves the gun.
    const gun = byName("Gun");
    const holsterCtl = makeGunHolster(gun, byName("GunHolster"), elbowR);
    return { group, armR, elbowR, gunTip, parts, joints, setGunsDown, setRaised, setFall, mixer, hasClip, playClip, stopClips, playFrozen, update, sway,
      gun, holster: holsterCtl.holster, drawStep: holsterCtl.drawStep, gunState: holsterCtl.gunState };
  } catch (err) {
    // Silent in prod (procedural fallback covers AdBlock/offline/file://);
    // noisy in dev so a broken model/swap is impossible to miss.
    if (import.meta.env.DEV) console.warn(`[gamey] cowboy GLB failed: ${url}`, err);
    return null;
  }
}

// Swap a live cowboy for its GLB twin mid-duel: pose + placement transfer
// so the swap is invisible (arm angles, fall state, stage position).
export function swapCowboy(
  scene: THREE.Scene,
  oldC: Cowboy,
  next: Cowboy,
): Cowboy {
  next.group.position.copy(oldC.group.position);
  next.group.rotation.copy(oldC.group.rotation);
  next.armR.rotation.copy(oldC.armR.rotation);
  next.elbowR.rotation.copy(oldC.elbowR.rotation);
  scene.remove(oldC.group);
  scene.add(next.group);
  return next;
}
