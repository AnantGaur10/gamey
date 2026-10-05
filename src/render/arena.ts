import * as THREE from "three";

// Flat-styled 3D: orthographic camera (exact flat-vector feel),
// unlit-leaning lights, CSS gradient sky behind a transparent canvas,
// sun disc + dirt street + procedural saloon backdrop (zero asset bytes).
// Evening/night/hell re-tint lights+fog here; sky CSS retint lands Phase 2.

export interface TimeOfDay {
  skyTop: number;
  skyBottom: number;
  hemiIntensity: number;
  dirIntensity: number;
  dirColor: number;
  fogColor: number;
  fogDensity: number;
}

export const NOON: TimeOfDay = {
  skyTop: 0x3d6fb4,
  skyBottom: 0xcfe3ef,
  hemiIntensity: 1.15,
  dirIntensity: 0.5,
  dirColor: 0xfff4e0,
  fogColor: 0xe8b07e,
  fogDensity: 0.008,
};

// R1 noon → R2 evening → R3+ night (locked 2026-09-24 §11). Night keeps the
// foe readable: ~15% ambient floor + rim via fill, muzzle flash via smoke.
export const EVENING: TimeOfDay = {
  skyTop: 0x4a3a6e,
  skyBottom: 0xe8875a,
  hemiIntensity: 0.75,
  dirIntensity: 0.42,
  dirColor: 0xff9a4a,
  fogColor: 0xc97a4a,
  fogDensity: 0.011,
};

export const NIGHT: TimeOfDay = {
  skyTop: 0x060a1c,
  skyBottom: 0x2a1a3a,
  hemiIntensity: 0.22,
  dirIntensity: 0.18,
  dirColor: 0x8aa8ff,
  fogColor: 0x141024,
  fogDensity: 0.016,
};

// HiDPI: render at device pixels (capped) so phones/retina aren't upscaled
// blurry. The cap only ever drops (frame-time watchdog in noteFrame) and is
// module-level so a slow device stays at 1x for every later duel.
let pixelRatioCap = 2;

// Duelist shadows are DECALS, not a shadow map: a real-time map (PCF
// lookups on every street pixel + a depth pass of ~100 cowboy meshes) cost
// ~40% frame time on software GL. One soft quad per duelist instead: a
// contact blob at the feet + a streak along the baked sun (light at
// (6,10,4) -> shadows fall toward -x/-z, ~0.72m per metre of height).
const SUN_SHADOW_DIR = new THREE.Vector3(-6, 0, -4).normalize();
const SHADOW_PER_M = Math.hypot(6, 4) / 10;
let shadowTex: THREE.CanvasTexture | null = null;
function shadowTexture(): THREE.CanvasTexture {
  if (shadowTex) return shadowTex;
  const cv = document.createElement("canvas");
  cv.width = 256;
  cv.height = 64;
  const g = cv.getContext("2d")!;
  // Streak: soft capsule fading toward the far end (u = 0 at the feet).
  const lin = g.createLinearGradient(0, 0, 256, 0);
  lin.addColorStop(0, "rgba(0,0,0,0.75)");
  lin.addColorStop(0.7, "rgba(0,0,0,0.45)");
  lin.addColorStop(1, "rgba(0,0,0,0)");
  g.filter = "blur(6px)";
  g.fillStyle = lin;
  g.beginPath();
  g.ellipse(128, 32, 116, 18, 0, 0, Math.PI * 2);
  g.fill();
  g.filter = "none";
  // Contact blob under the feet (darkest, always there).
  const rad = g.createRadialGradient(34, 32, 0, 34, 32, 30);
  rad.addColorStop(0, "rgba(0,0,0,0.85)");
  rad.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = rad;
  g.fillRect(0, 0, 80, 64);
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  shadowTex = tex;
  return tex;
}

export interface ShadowDecal {
  /** feet = world XZ under the duelist; heightM = how tall they stand now
   *  (wound pose), lying = corpse (shadow pools round under the body). */
  place(feet: THREE.Vector3, heightM: number, lying: boolean): void;
  /** 0..1 darkness (sun strength by time of day). */
  setStrength(k: number): void;
  dispose(): void;
}

export function createShadowDecal(scene: THREE.Scene): ShadowDecal {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0.5, 0, 0); // local +x = along the shadow, origin at the near end
  const mat = new THREE.MeshBasicMaterial({
    map: shadowTexture(),
    color: 0x2a1606,
    transparent: true,
    opacity: 0.4,
    depthWrite: false,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.rotation.y = Math.atan2(-SUN_SHADOW_DIR.z, SUN_SHADOW_DIR.x); // +x -> sun shadow dir
  mesh.renderOrder = 1; // over the floor + ruts, under the duelists' sprites
  scene.add(mesh);
  return {
    place(feet, heightM, lying) {
      const len = lying ? 1.5 : 0.45 + heightM * SHADOW_PER_M;
      // Wide in depth on purpose: the ~6 deg view squashes depth ~10x.
      const wid = lying ? 1.2 : 0.85;
      mesh.scale.set(len, 1, wid);
      // Start a little behind the feet so the contact blob sits under them.
      const back = lying ? 0.75 : 0.28;
      mesh.position.set(feet.x - SUN_SHADOW_DIR.x * back, 0.03, feet.z - SUN_SHADOW_DIR.z * back);
    },
    setStrength(k) {
      mat.opacity = Math.max(0, Math.min(1, k));
    },
    dispose() {
      scene.remove(mesh);
      geo.dispose();
      mat.dispose();
    },
  };
}

// Procedural dirt detail (zero shipped bytes): a greyscale tileable map
// (0.5 = neutral) multiplied onto the street floor in WORLD XZ, so the arena
// ground and the street GLB's own ground band (vertex colours, no UVs) get
// the identical pattern and meet without a seam. The ortho camera sees the
// floor at ~6 deg (depth foreshortened ~10x), so it repeats every 10m across
// but 50m in depth: round marks read as round-ish on screen. Seeded.
let dirtTex: THREE.CanvasTexture | null = null;
function dirtDetailTexture(): THREE.CanvasTexture {
  if (dirtTex) return dirtTex;
  const S = 512;
  const cv = document.createElement("canvas");
  cv.width = S;
  cv.height = S;
  const g = cv.getContext("2d")!;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  g.fillStyle = "rgb(128,128,128)";
  g.fillRect(0, 0, S, S);
  const wrapped = (x: number, y: number, r: number, draw: (x: number, y: number) => void) => {
    for (const ox of [-S, 0, S]) for (const oy of [-S, 0, S]) {
      if (x + ox + r < 0 || x + ox - r > S || y + oy + r < 0 || y + oy - r > S) continue;
      draw(x + ox, y + oy);
    }
  };
  // Low-frequency mottling (soft light/dark blotches).
  for (let i = 0; i < 46; i++) {
    const x = rnd() * S, y = rnd() * S, r = 30 + rnd() * 90;
    const v = rnd() < 0.55 ? 0 : 255;
    const a = 0.12 + rnd() * 0.16;
    wrapped(x, y, r, (cx, cy) => {
      const gr = g.createRadialGradient(cx, cy, 0, cx, cy, r);
      gr.addColorStop(0, `rgba(${v},${v},${v},${a})`);
      gr.addColorStop(1, `rgba(${v},${v},${v},0)`);
      g.fillStyle = gr;
      g.fillRect(cx - r, cy - r, r * 2, r * 2);
    });
  }
  // Pebbles + clods: small dark flecks with a sunlit top edge.
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S, y = rnd() * S, r = 0.8 + rnd() * 1.8;
    const a = 0.35 + rnd() * 0.4;
    wrapped(x, y, r + 1, (cx, cy) => {
      g.fillStyle = `rgba(20,20,20,${a})`;
      g.beginPath();
      g.ellipse(cx, cy, r * 1.3, r, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = "rgba(255,255,255,0.5)";
      g.fillRect(cx - r, cy - r - 0.6, r * 1.6, 0.8);
    });
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.NoColorSpace; // data, not colour
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  dirtTex = tex;
  return tex;
}

/** Multiply the dirt detail onto a Lambert material's fragments that sit at
 *  floor height (world y < maxY). `axis` = the duel direction (sets the
 *  stretched repeat). Same texture + projection everywhere = no seams. */
export function addDirtDetail(
  mat: THREE.Material,
  axis: THREE.Vector3,
  maxY: number,
): void {
  const tex = dirtDetailTexture();
  // No anisotropic filtering: the texture is pre-stretched 5x in depth, and
  // 4x aniso cost ~25% frame time on software GL (CrazyGames low-end QA).
  tex.anisotropy = 1;
  const a = axis.clone().setY(0).normalize();
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uDirt = { value: tex };
    sh.uniforms.uDirtAx = { value: new THREE.Vector4(-a.z / 10, a.x / 10, a.x / 50, a.z / 50) };
    sh.uniforms.uDirtMaxY = { value: maxY };
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDirtW;")
      .replace("#include <begin_vertex>", "#include <begin_vertex>\nvDirtW = (modelMatrix * vec4(transformed, 1.0)).xyz;");
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vDirtW;\nuniform sampler2D uDirt;\nuniform vec4 uDirtAx;\nuniform float uDirtMaxY;")
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        if (vDirtW.y < uDirtMaxY) {
          vec2 duv = vec2(dot(vDirtW.xz, uDirtAx.xy), dot(vDirtW.xz, uDirtAx.zw));
          diffuseColor.rgb *= 1.0 + (texture2D(uDirt, duv).r - 0.5) * 0.6;
        }`,
      );
  };
  mat.needsUpdate = true;
}

/** roundIndex (0-based) → TimeOfDay preset. */
export function timeOfDayForRound(i: number): TimeOfDay {
  if (i <= 0) return NOON;
  if (i === 1) return EVENING;
  return NIGHT;
}

/** Matching CSS sky gradient for the page background (transparent canvas). */
export function cssSkyForRound(i: number): string {
  if (i <= 0) return "linear-gradient(#2f6cb3 0%, #7fa8d0 45%, #d9b380 78%, #c49a68 100%)";
  if (i === 1) return "linear-gradient(#3a2a5e 0%, #a85a4a 48%, #e8875a 75%, #7a4a3a 100%)";
  return "linear-gradient(#04060f 0%, #141230 50%, #3a1a3a 78%, #1c0f0c 100%)";
}

// Diagonal duel line: player bottom-left foreground, foe top-right
// background, same ground plane (photo reads height from perspective).
export function stagePositions(distM: number): {
  player: THREE.Vector3;
  foe: THREE.Vector3;
} {
  return {
    player: new THREE.Vector3(-distM / 2, 0, 3.0),
    foe: new THREE.Vector3(distM / 2, 0, -3.0),
  };
}

export function faceToward(
  obj: THREE.Object3D,
  from: THREE.Vector3,
  to: THREE.Vector3,
): void {
  obj.rotation.y = Math.atan2(to.x - from.x, to.z - from.z);
}

export function createArena(distM: number): {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  getHalfH(): number;
  setTimeOfDay(t: TimeOfDay): void;
  fitCamera(): void;
  /** Feed every rendered frame's dt: sustained slow frames drop HiDPI to 1x. */
  noteFrame(dt: number): void;
} {
  const scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(NOON.fogColor, NOON.fogDensity);
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

  // Negative near (legal for ortho): the bottom rows' rays start BELOW the
  // ground at the camera plane, so with near > 0 they never met it and showed
  // a fake under-ground skirt (ruts/shadows/lava cut off in a hard line).
  // Extending the frustum behind the camera lets them hit the real ground
  // ~12m back. FogExp2 squares depth, so negative depths fog the same.
  const camera = new THREE.OrthographicCamera(-8, 8, 4.5, -4.5, -40, 200);
  // Tight over-the-gun-shoulder 3rd person (locked): the camera rides just
  // above + behind the player's gun-side shoulder and looks past the head
  // at the foe. The whole player stays in front of the near plane, so the
  // body renders solid. Offset toward the gun side keeps the shooting arm
  // and the foe in frame together.
  const duelDir = new THREE.Vector3(distM, 0, -6.0).normalize();
  const { player: pPos, foe: fPos } = stagePositions(distM);
  const playerYaw = Math.atan2(fPos.x - pPos.x, fPos.z - pPos.z);
  const gunSide = new THREE.Vector3(Math.cos(playerYaw), 0, -Math.sin(playerYaw)); // armR local +x in world
  camera.position
    .copy(pPos)
    .addScaledVector(duelDir, -1.55)
    .addScaledVector(gunSide, 0.68)
    .add(new THREE.Vector3(0, 2.1, 0));
  camera.lookAt(pPos.clone().lerp(fPos, 0.66).add(new THREE.Vector3(0, 1.32, 0)));

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0); // CSS sunset gradient shows through

  const hemi = new THREE.HemisphereLight(0xfff2dd, 0x8a6f4d, NOON.hemiIntensity);
  const dir = new THREE.DirectionalLight(NOON.dirColor, NOON.dirIntensity);
  // Same sun the street bake ray-casts from (build_street.py SUN_FROM);
  // the duelists' shadow decals (createShadowDecal) fall along it too.
  dir.position.set(6, 10, 4);
  // Fill from the camera side: the chase cam stares at the player's BACK
  // all duel, and with only a frontal key the coat tails + vest fell to
  // grey. Low warm fill keeps true colors without flattening the noon look.
  const fill = new THREE.DirectionalLight(0xffe8c8, 0.45);
  fill.position.copy(pPos).addScaledVector(duelDir, -6).add(new THREE.Vector3(0, 4, 0));
  scene.add(hemi, dir, fill);

  // Ground: dusty main street + wagon ruts running down the duel line.
  // Oversized on purpose: at narrow aspects the ortho frustum reaches far
  // past the duel, and any unbuilt pixel shows page background as a band.
  // Dirt detail in world XZ (shared with the street GLB's ground band).
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xd9b380 });
  addDirtDetail(groundMat, duelDir, 1);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 400), groundMat);
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  // Lit (not Basic): unlit ruts glowed as bright stripes at night / in hell.
  // Long enough to run under the camera: the bottom rows see the ground
  // ~12m behind it (negative near plane above).
  const rutMat = new THREE.MeshLambertMaterial({ color: 0xb08c5a });
  const rutMid = pPos.clone().lerp(fPos, 0.5).addScaledVector(duelDir, -10);
  const rutPerp = new THREE.Vector3(-duelDir.z, 0, duelDir.x);
  const rutYaw = Math.atan2(duelDir.x, duelDir.z);
  for (const s of [-0.9, 0.9]) {
    const rut = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.02, 90), rutMat);
    rut.position.copy(rutMid).addScaledVector(rutPerp, s);
    rut.position.y = 0.012;
    rut.rotation.y = rutYaw;
    scene.add(rut);
  }

  // Sun disc (photo's pale sun), fixed to face the static camera.
  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(2.5, 40),
    new THREE.MeshBasicMaterial({ color: 0xf7e3ac, fog: false }),
  );
  sun.position.copy(pPos).addScaledVector(duelDir, 22).add(new THREE.Vector3(0, 10, 0));
  sun.lookAt(camera.position);
  scene.add(sun);

  // Duel markers at the staged feet: a faint scuffed circle (the sun
  // shadows carry the contact now).
  const { player, foe } = { player: pPos, foe: fPos };
  const markerMat = new THREE.MeshBasicMaterial({ color: 0x6b543a, transparent: true, opacity: 0.45, depthWrite: false });
  for (const p of [player, foe]) {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.52, 0.6, 32), markerMat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(p.x, 0.02, p.z);
    scene.add(m);
  }

  // Frontier main street (ref: specs/references/cboysaloon.jpeg): wood row
  // left, cream restaurant + gray stone right, red false-front closing the
  // vista, boardwalks, corral fence + wagon wheel foreground. Procedural
  // boxes only — zero shipped bytes; signs are runtime canvas textures.
  // Street-local axes: +z faces the duel/camera, x runs across the street.
  {
    const mid = pPos.clone().lerp(fPos, 0.5);
    const street = new THREE.Group();
    street.name = "ProceduralStreet"; // hidden when the Blender street GLB lands
    street.position.copy(mid).addScaledVector(duelDir, mid.distanceTo(fPos) + 9.5);
    street.rotation.y = Math.atan2(-duelDir.x, -duelDir.z); // local +z faces the duel
    const lam = (c: number) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    const glow = (c: number) => new THREE.MeshBasicMaterial({ color: c, fog: false });
    const wood = lam(0x9a7a52); // sun-bleached siding
    const darkWood = lam(0x6e4f30);
    const walkMat = lam(0xb08c5a);
    const cream = lam(0xe9dcc2);
    const stone = lam(0x8f9299);
    const brickRed = lam(0xa8503c);
    // Box helper: mesh built, placed (optionally rotated), parented.
    function B(parent: THREE.Object3D, w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number, ry = 0, rz = 0, rx = 0): THREE.Mesh {
      const ms = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
      ms.position.set(x, y, z);
      ms.rotation.set(rx, ry, rz);
      parent.add(ms);
      return ms;
    }
    function textTex(text: string, fg: string): THREE.CanvasTexture {
      const cv = document.createElement("canvas");
      cv.width = 512;
      cv.height = 96;
      const g = cv.getContext("2d")!;
      g.clearRect(0, 0, 512, 96);
      g.font = "bold 64px Georgia, serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillStyle = fg;
      g.fillText(text, 256, 52);
      const tx = new THREE.CanvasTexture(cv);
      tx.colorSpace = THREE.SRGBColorSpace;
      return tx;
    }
    function signBoard(parent: THREE.Object3D, text: string, fg: string, bg: THREE.Material, w: number, x: number, y: number, z: number): void {
      B(parent, w, 1.0, 0.22, bg, x, y, z);
      const p = new THREE.Mesh(
        new THREE.PlaneGeometry(w - 0.4, 0.85),
        new THREE.MeshBasicMaterial({ map: textTex(text, fg), transparent: true, fog: false }),
      );
      p.position.set(x, y, z + 0.13);
      parent.add(p);
    }
    // Window unit: dark frame, warm pane, side shutters, sill.
    function windowUnit(parent: THREE.Object3D, x: number, y: number, z: number, shutter: THREE.Material | null): void {
      B(parent, 1.5, 1.7, 0.08, darkWood, x, y, z);
      const pane = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 1.5), glow(0xffd98a));
      pane.position.set(x, y, z + 0.06);
      parent.add(pane);
      B(parent, 1.5, 0.1, 0.14, darkWood, x, y - 0.9, z + 0.02); // sill
      if (shutter) {
        B(parent, 0.5, 1.7, 0.06, shutter, x - 1.0, y, z + 0.02);
        B(parent, 0.5, 1.7, 0.06, shutter, x + 1.0, y, z + 0.02);
      }
    }

    // LEFT ROW (weathered wood, like the ref's left side).
    const leftRow = new THREE.Group();
    leftRow.position.set(-6.5, 0, 0);
    street.add(leftRow);
    // Saloon: false front + porch + batwing doors + signs.
    B(leftRow, 9, 5, 1, wood, 0, 2.5, 0);
    B(leftRow, 9, 1.8, 0.6, darkWood, 0, 5.6, 0.2); // false-front parapet
    B(leftRow, 9, 0.22, 3.0, darkWood, 0, 3.2, 2.0); // porch roof
    for (const px of [-3.8, -1.3, 1.3, 3.8]) {
      B(leftRow, 0.26, 3.1, 0.26, darkWood, px, 1.55, 3.2, 0, (px > 0 ? 1 : -1) * 0.02);
    }
    windowUnit(leftRow, -2.6, 2.3, 0.52, lam(0x4a6a4a));
    windowUnit(leftRow, 2.6, 2.3, 0.52, lam(0x4a6a4a));
    const rec = new THREE.Mesh(new THREE.PlaneGeometry(1.9, 2.7), new THREE.MeshBasicMaterial({ color: 0x20140c }));
    rec.position.set(0, 1.45, 0.53);
    leftRow.add(rec);
    B(leftRow, 0.8, 1.1, 0.06, darkWood, -0.44, 1.0, 0.58);
    B(leftRow, 0.8, 1.1, 0.06, darkWood, 0.44, 1.0, 0.58);
    signBoard(leftRow, "SALOON", "#f7e3ac", darkWood, 6, 0, 4.35, 0.75);
    B(leftRow, 0.12, 0.12, 1.4, darkWood, 1.8, 3.0, 1.1); // blade-sign bracket
    B(leftRow, 1.5, 0.9, 0.1, wood, 1.8, 2.4, 1.7); // hanging blade sign
    // Two-story neighbor with balcony (ref's left balcony).
    const lodge = new THREE.Group();
    lodge.position.set(0, 0, -9.5);
    leftRow.add(lodge);
    B(lodge, 8, 6.5, 1, lam(0x7d6a52), 0, 3.25, 0);
    B(lodge, 8, 0.5, 1.2, darkWood, 0, 6.6, 0); // cornice
    B(lodge, 8, 0.25, 2.2, darkWood, 0, 3.35, 1.4); // balcony floor
    B(lodge, 8, 0.12, 0.12, darkWood, 0, 4.25, 2.4); // balcony rail
    for (let i = -3; i <= 3; i++) B(lodge, 0.09, 0.85, 0.09, darkWood, i * 1.05, 3.82, 2.4);
    B(lodge, 0.24, 3.2, 0.24, darkWood, -3.4, 1.6, 2.2);
    B(lodge, 0.24, 3.2, 0.24, darkWood, 3.4, 1.6, 2.2);
    windowUnit(lodge, -2, 1.9, 0.52, lam(0x8a4a3a));
    const dlodge = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.5), new THREE.MeshBasicMaterial({ color: 0x2a1c10 }));
    dlodge.position.set(1.8, 1.25, 0.53);
    lodge.add(dlodge);
    windowUnit(lodge, -2, 5.0, 0.52, null);
    windowUnit(lodge, 2, 5.0, 0.52, null);
    // Boardwalk spanning the row + steps + barrels.
    B(leftRow, 3.2, 0.35, 20, walkMat, 0, 0.175, -1.5);
    B(leftRow, 3.2, 0.18, 1.2, walkMat, 0, 0.09, 9.0);
    B(leftRow, 3.2, 0.18, 1.2, walkMat, 0, 0.09, -12.0);
    for (const [bx, bz] of [[-1.1, 8.2], [0.1, 8.6]] as const) {
      const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.38, 0.9, 12), wood);
      bar.position.set(bx, 0.45, bz);
      leftRow.add(bar);
      B(leftRow, 0.72, 0.06, 0.72, darkWood, bx, 0.25, bz);
      B(leftRow, 0.72, 0.06, 0.72, darkWood, bx, 0.68, bz);
    }

    // RIGHT ROW (cream restaurant + gray stone, like the ref's right side).
    const rightRow = new THREE.Group();
    rightRow.position.set(6.5, 0, 0);
    street.add(rightRow);
    B(rightRow, 10, 5, 1, cream, 0, 2.5, 0);
    B(rightRow, 10, 0.9, 0.7, cream, 0, 5.3, 0.1); // parapet cap
    B(rightRow, 10, 0.16, 3.4, lam(0x9a8a68), 0, 3.35, 2.0, 0, 0, 0.1); // slanted awning
    for (const px of [-4.2, -1.4, 1.4, 4.2]) B(rightRow, 0.24, 3.2, 0.24, darkWood, px, 1.6, 3.4);
    signBoard(rightRow, "RESTAURANT", "#f2e6c4", lam(0x2e5d3a), 7, 0, 4.35, 0.65);
    windowUnit(rightRow, -3.2, 2.2, 0.52, null);
    windowUnit(rightRow, -1.1, 2.2, 0.52, null);
    windowUnit(rightRow, 3.2, 2.2, 0.52, null);
    const rdoor = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.5), new THREE.MeshBasicMaterial({ color: 0x3a2a1a }));
    rdoor.position.set(1.1, 1.25, 0.53);
    rightRow.add(rdoor);
    // Gray stone 2-story.
    const stone2 = new THREE.Group();
    stone2.position.set(0, 0, -10);
    rightRow.add(stone2);
    B(stone2, 8, 6.5, 1, stone, 0, 3.25, 0);
    B(stone2, 8.4, 0.4, 1.3, lam(0x6a6d75), 0, 6.6, 0); // cornice
    windowUnit(stone2, -2, 1.9, 0.52, null);
    windowUnit(stone2, 2, 1.9, 0.52, null);
    windowUnit(stone2, -2, 5.0, 0.52, null);
    windowUnit(stone2, 2, 5.0, 0.52, null);
    const sdoor = new THREE.Mesh(new THREE.PlaneGeometry(1.3, 2.5), new THREE.MeshBasicMaterial({ color: 0x2a2d33 }));
    sdoor.position.set(0, 1.25, 0.53);
    stone2.add(sdoor);
    B(rightRow, 3.2, 0.35, 20, walkMat, 0, 0.175, -2.5); // boardwalk
    B(rightRow, 3.2, 0.18, 1.2, walkMat, 0, 0.09, 8.0);
    // End of street: faded-red false front closes the vista (ref's red block).
    const end = new THREE.Group();
    end.position.set(0, 0, -16);
    street.add(end);
    B(end, 12, 5.5, 1, brickRed, 0, 2.75, 0);
    B(end, 12, 1.6, 0.7, lam(0x7e3a2c), 0, 6.1, 0.1);
    signBoard(end, "BANK", "#f2e6c4", lam(0x7e3a2c), 5, 0, 4.6, 0.65);
    windowUnit(end, -3.5, 2.6, 0.52, null);
    windowUnit(end, 3.5, 2.6, 0.52, null);
    const edoor = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 2.8), new THREE.MeshBasicMaterial({ color: 0x2a1a10 }));
    edoor.position.set(0, 1.4, 0.53);
    end.add(edoor);
    // Corral fence + wagon wheel, foreground right (ref's right fence).
    const corral = new THREE.Group();
    corral.position.set(4.6, 0, 10.5);
    street.add(corral);
    for (const px of [-2.4, 0, 2.4]) B(corral, 0.22, 1.25, 0.22, darkWood, px, 0.62, 0);
    B(corral, 5.4, 0.16, 0.16, darkWood, 0, 1.1, 0);
    B(corral, 5.4, 0.16, 0.16, darkWood, 0, 0.62, 0);
    const wheel = new THREE.Group();
    wheel.position.set(3.4, 0.6, 0.4);
    wheel.rotation.set(0.22, 0.45, 0);
    corral.add(wheel);
    wheel.add(new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.07, 8, 20), darkWood));
    for (let i = 0; i < 8; i++) {
      const sp = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1.0, 6), wood);
      sp.rotation.z = (i / 8) * Math.PI * 2;
      wheel.add(sp);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.16, 8), darkWood);
    hub.rotation.x = Math.PI / 2;
    wheel.add(hub);

    scene.add(street);
  }

  // Dressing: depth + life for zero shipped bytes (all procedural boxes).
  // Buildings sit ~12-14m past mid; keep new props clear of the duel line.
  // Grouped as "ProceduralDressing": hidden with the street when the Blender
  // set (which carries its own props + lamps) lands.
  {
    const dressing = new THREE.Group();
    dressing.name = "ProceduralDressing";
    scene.add(dressing);
    const mid = pPos.clone().lerp(fPos, 0.5);
    const perp = new THREE.Vector3(-duelDir.z, 0, duelDir.x);
    const lam2 = (c: number) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
    const basic = (c: number, fog = true) => new THREE.MeshBasicMaterial({ color: c, fog });
    // Distant mesas (haze silhouettes past the street).
    const mesaMat = lam2(0xb98a63);
    const mesaCap = lam2(0x8f5f43);
    for (const [sx, dd, w, h] of [[-14, 26, 10, 4], [6, 34, 14, 6], [22, 28, 8, 3]] as const) {
      const mesa = new THREE.Mesh(new THREE.BoxGeometry(w, h, 3), mesaMat);
      mesa.position.copy(mid).addScaledVector(duelDir, dd).addScaledVector(perp, sx);
      mesa.position.y = h / 2 - 0.2;
      dressing.add(mesa);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, h * 0.35, 3.2), mesaCap);
      cap.position.copy(mesa.position);
      cap.position.y += h * 0.55;
      dressing.add(cap);
    }
    // Clouds: flat-shaded puffs high past the street.
    const cloudMat = basic(0xfdf6e8);
    for (const [sx, dd, y] of [[-10, 20, 16], [8, 26, 20], [0, 30, 24]] as const) {
      const cl = new THREE.Group();
      for (let k = 0; k < 3; k++) {
        const puff = new THREE.Mesh(new THREE.SphereGeometry(1.6 - k * 0.3, 7, 5), cloudMat);
        puff.position.set(k * 1.8 - 1.8, (k % 2) * 0.5, 0);
        puff.scale.y = 0.55;
        cl.add(puff);
      }
      cl.position.copy(mid).addScaledVector(duelDir, dd).addScaledVector(perp, sx);
      cl.position.y = y;
      dressing.add(cl);
    }
    // Water tower beside the street.
    const tower = new THREE.Group();
    const towerWood = lam2(0x7a5a38);
    for (const [lx, lz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]] as const) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 7, 0.3), towerWood);
      leg.position.set(lx, 3.5, lz);
      tower.add(leg);
    }
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(1.8, 2.0, 2.6, 10), lam2(0x8a6a45));
    tank.position.y = 8.2;
    tower.add(tank);
    const roof = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 2.1, 1.2, 10), lam2(0x5e4226));
    roof.position.y = 10.1;
    tower.add(roof);
    tower.position.copy(mid).addScaledVector(duelDir, 10).addScaledVector(perp, 14);
    dressing.add(tower);
    // Telegraph pole + sagging wire roadside.
    const poleMat = lam2(0x5e4226);
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.15, 7.5, 7), poleMat);
    pole.position.copy(mid).addScaledVector(duelDir, 2).addScaledVector(perp, -11);
    pole.position.y = 3.75;
    dressing.add(pole);
    const cross2 = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.12, 0.12), poleMat);
    cross2.position.copy(pole.position);
    cross2.position.y = 6.9;
    dressing.add(cross2);
    const wireMat = basic(0x2e2620);
    for (let k = 0; k < 4; k++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.03, 3.2), wireMat);
      seg.position.copy(pole.position).addScaledVector(duelDir, 1.8 + k * 3.1);
      seg.position.y = 6.85 - Math.sin((k / 3) * Math.PI) * 0.35;
      seg.rotation.y = Math.atan2(duelDir.x, duelDir.z);
      dressing.add(seg);
    }
    // Porch lanterns: warm glow points near the storefronts.
    const lampGlow = basic(0xffc46b, false);
    const lampBase = lam2(0x2e2620);
    for (const sx of [-4, 0.5, 5]) {
      const post = mid.clone().addScaledVector(duelDir, 12.5).addScaledVector(perp, sx);
      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.22), lampBase);
      housing.position.set(post.x, 3.1, post.z);
      dressing.add(housing);
      const glow = new THREE.Mesh(new THREE.SphereGeometry(0.13, 8, 6), lampGlow);
      glow.position.set(post.x, 3.05, post.z);
      dressing.add(glow);
    }
    // Crates + sacks stacked by the boardwalk.
    const crateM = lam2(0x9a7a52);
    const crateDefs = [[-7.5, 10.2, 0.9], [-6.5, 10.5, 0.7], [-7.1, 10.3, 0.55]] as const;
    crateDefs.forEach(([sx, dd, s], i) => {
      const c = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), crateM);
      c.position.copy(mid).addScaledVector(duelDir, dd).addScaledVector(perp, sx);
      c.position.y = i === 2 ? s * 1.4 : s / 2;
      c.rotation.y = i * 0.4;
      dressing.add(c);
    });
    const sackM = lam2(0xc9b183);
    for (const [sx, dd] of [[9.5, 10.5], [10.3, 10.2]] as const) {
      const s = new THREE.Mesh(new THREE.SphereGeometry(0.55, 7, 5), sackM);
      s.scale.y = 0.75;
      s.position.copy(mid).addScaledVector(duelDir, dd).addScaledVector(perp, sx);
      s.position.y = 0.4;
      dressing.add(s);
    }
    // Ground tone patches (dirt variation, kills the flat-floor read).
    const patchM = new THREE.MeshBasicMaterial({ color: 0xc49a68 });
    for (const [sx, dd, r] of [[-3, 1, 3.2], [4, -2, 2.4], [0, 6, 4.0]] as const) {
      const p = new THREE.Mesh(new THREE.CircleGeometry(r, 18), patchM);
      p.rotation.x = -Math.PI / 2;
      p.position.copy(mid).addScaledVector(duelDir, dd).addScaledVector(perp, sx);
      p.position.y = 0.015;
      dressing.add(p);
    }
  }

  function setTimeOfDay(t: TimeOfDay): void {
    (scene.fog as THREE.FogExp2).color.setHex(t.fogColor);
    (scene.fog as THREE.FogExp2).density = t.fogDensity;
    hemi.intensity = t.hemiIntensity;
    dir.intensity = t.dirIntensity;
    dir.color.setHex(t.dirColor);
    // Night floor: never pitch black (~15% enemy ambient + rim). Lantern
    // meshes are MeshBasic (unlit) so they auto-pop at night, no handle needed.
    fill.intensity = Math.max(0.14, 0.45 * (t.hemiIntensity / NOON.hemiIntensity));
  }

  let halfH = 3.4;
  function fitCamera(): void {
    const host = renderer.domElement.parentElement;
    const w = host ? host.clientWidth : window.innerWidth;
    const h = host ? host.clientHeight : window.innerHeight;
    // Hit tests/aim read getBoundingClientRect (CSS px), so the backing
    // store's pixel ratio never changes gameplay.
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2, pixelRatioCap));
    renderer.setSize(w, h, false);
    const aspect = w / Math.max(1, h);
    // Over-shoulder: the player is foreground (always in frame), so the
    // frustum only needs the foe + saloon; tighter = closer feel. All QA
    // sizes are ~16:9, where the 3.4 floor binds and the foe fills ~1/3
    // of screen height. Holster zone is DOM-clamped on-screen regardless.
    halfH = Math.max(3.4, (distM * 0.6 + 3) / (2 * aspect));
    camera.left = -halfH * aspect;
    camera.right = halfH * aspect;
    camera.top = halfH;
    camera.bottom = -halfH;
    camera.updateProjectionMatrix();
  }

  // Watchdog: after a short warm-up, a 1s window averaging > 22ms/frame
  // (its single longest frame left out, so one shader-compile or GLB-swap
  // stall can't trip it) while above 1x drops to 1x for the session. Short
  // so a slow device leaves the heavy ratio before the Focus QTE matters.
  let warm = 0, winT = 0, winN = 0, winMax = 0;
  function noteFrame(dt: number): void {
    if (renderer.getPixelRatio() <= 1) return;
    if (warm < 0.75) { warm += dt; return; }
    winT += dt;
    winN += 1;
    winMax = Math.max(winMax, dt);
    if (winT < 1) return;
    if (winN > 1 && (winT - winMax) / (winN - 1) > 0.022) {
      pixelRatioCap = 1;
      fitCamera();
    }
    winT = 0;
    winN = 0;
    winMax = 0;
  }

  return {
    scene,
    camera,
    renderer,
    getHalfH: () => halfH,
    setTimeOfDay,
    fitCamera,
    noteFrame,
  };
}
