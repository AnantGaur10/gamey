// Hell sudden-death set (Phase-2 Slice 6, rebuilt 2026-10-05).
// Lazy chunk loaded AFTER GameplayStart — never in the initial payload.
// The rock/glow geometry is a Blender asset (scripts/blender/build_hell.py
// -> public/models/hell.glb, nodes X_Paint + X_Glow); the procedural meshes
// below are its null-safe fallback and hide when the GLB lands. Lava sea,
// sky dome, eclipse and the rune hexes stay runtime shaders here.
// Its own place, nothing shared with the street (user 2026-10-05): the
// street floor, buildings and dressing are hidden while it is up. A black
// basalt causeway runs down the duel line over a flowing lava sea; hexagonal
// basalt columns rise out of the lava on both sides; past the foe the
// causeway ends at a dais under two obsidian horns holding a molten ring;
// volcano silhouettes line the horizon under a red eclipse.
// All procedural (zero shipped bytes), ~12 draw calls, two extra lights
// (same count as the old set). Cosmetic only: the causeway top is y=0, the
// same plane the ragdoll and the hit capsules already use.
import * as THREE from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { addDirtDetail } from "./arena";

export interface HellHandle {
  /** Absolute time in seconds (lava flow, glow pulse, light flicker). */
  tick(tSec: number): void;
  dispose(): void;
}

/** Street objects hidden while hell is up (restored on dispose). */
const STREET_PARTS = ["ArenaFloor", "ProceduralStreet", "ProceduralDressing"];

export function enterHell(scene: THREE.Scene, playerAt: THREE.Vector3, foeAt: THREE.Vector3, glbUrl?: string): HellHandle {
  const prevBg = scene.background;
  scene.background = new THREE.Color(0x0a0202);
  const hidden: THREE.Object3D[] = [];
  for (const n of STREET_PARTS) {
    const o = scene.getObjectByName(n);
    if (o && o.visible) { o.visible = false; hidden.push(o); }
  }

  const axis = foeAt.clone().sub(playerAt).setY(0).normalize();
  const mid = playerAt.clone().lerp(foeAt, 0.5).setY(0);
  // The set is anchored on the FOE (same frame as build_hell.py): the gate
  // stands a fixed few metres behind it at any duel distance (6-25m).
  const anchor = foeAt.clone().setY(0);
  // Set-local frame: +z = down the duel line toward the foe, x = across.
  const set = new THREE.Group();
  set.name = "HellSet";
  set.position.copy(anchor);
  set.rotation.y = Math.atan2(axis.x, axis.z);
  scene.add(set);
  // Procedural stand-in for the Blender geometry (hidden once hell.glb loads).
  const fallback = new THREE.Group();
  fallback.name = "HellProcedural";
  set.add(fallback);
  let seed = 23;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const disposables: { dispose(): void }[] = [];
  const keep = <T extends { dispose(): void }>(x: T): T => { disposables.push(x); return x; };

  // Sky dome: black zenith, ember-red horizon band (fog-free, behind all).
  const skyMat = keep(new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec3 vDir;
      void main(){
        float h = vDir.y;
        vec3 top = vec3(0.02, 0.004, 0.004);
        vec3 mid = vec3(0.12, 0.02, 0.012);
        vec3 hor = vec3(0.42, 0.08, 0.02);
        vec3 c = mix(hor, mid, smoothstep(-0.02, 0.16, h));
        c = mix(c, top, smoothstep(0.16, 0.6, h));
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  const sky = new THREE.Mesh(keep(new THREE.SphereGeometry(300, 24, 12)), skyMat);
  sky.renderOrder = -2;
  set.add(sky);

  // Red eclipse high over the far end: dark disc, pulsing corona.
  const eclipseMat = keep(new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 } },
    transparent: true,
    depthWrite: false,
    fog: false,
    vertexShader: `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float t;
      void main(){
        float r = length(vUv - 0.5) * 2.0;
        float disc = 1.0 - smoothstep(0.4, 0.415, r);
        float corona = exp(-pow((r - 0.42) * 9.0, 2.0)) * (0.85 + 0.15 * sin(t * 1.7));
        float halo = exp(-max(r - 0.42, 0.0) * 4.0) * 0.35;
        vec3 c = vec3(1.0, 0.35, 0.08) * (corona + halo);
        float a = max(disc, clamp(corona + halo, 0.0, 1.0));
        gl_FragColor = vec4(mix(c, vec3(0.03, 0.0, 0.0), disc), a);
      }`,
  }));
  const eclipse = new THREE.Mesh(keep(new THREE.PlaneGeometry(70, 70)), eclipseMat);
  eclipse.position.set(-18, 52, 170);
  eclipse.rotation.y = Math.PI; // face back down the duel line at the camera
  eclipse.renderOrder = -1;
  set.add(eclipse);

  // Lava sea: domain-warped flow in world XZ, bright veins between dark
  // crust plates, fading into the horizon glow with distance (no fog chunk).
  const lavaMat = keep(new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 } },
    fog: false,
    vertexShader: `varying vec3 vW; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `varying vec3 vW; uniform float t;
      float cells(vec2 p){
        vec2 q = p + vec2(sin(p.y * 0.9 + t * 0.35), cos(p.x * 0.8 - t * 0.3)) * 0.8;
        vec2 f = fract(q) - 0.5;
        return 1.0 - smoothstep(0.32, 0.5, max(abs(f.x), abs(f.y)) + 0.08 * sin(q.x * 3.1 + q.y * 2.3));
      }
      void main(){
        vec2 p = vW.xz * 0.28;
        float crust = cells(p) * cells(p * 1.9 + 7.3);
        float pulse = 0.5 + 0.5 * sin(t * 0.8 + vW.x * 0.07 + vW.z * 0.05);
        vec3 hot = mix(vec3(1.0, 0.33, 0.04), vec3(1.0, 0.62, 0.16), pulse);
        vec3 c = mix(hot, vec3(0.09, 0.02, 0.012), crust);
        float d = length(vW - cameraPosition);
        c = mix(c, vec3(0.42, 0.08, 0.02), smoothstep(40.0, 160.0, d));
        gl_FragColor = vec4(c, 1.0);
      }`,
  }));
  const lava = new THREE.Mesh(keep(new THREE.PlaneGeometry(700, 700)), lavaMat);
  lava.rotation.x = -Math.PI / 2;
  lava.position.y = -1.3;
  set.add(lava);

  // Causeway: the duel floor (top at y=0), from well behind the camera to
  // a round dais past the foe. World-XZ dirt detail gives the rock grain.
  const rockMat = keep(new THREE.MeshLambertMaterial({ color: 0x3a2622, flatShading: true }));
  addDirtDetail(rockMat, axis, 0.05);
  const CW = 7.5;
  const causeFrom = -62; // behind the farthest camera (25m duel + ~3m)
  const causeTo = 6;
  const causeway = new THREE.Mesh(keep(new THREE.BoxGeometry(CW, 3, causeTo - causeFrom)), rockMat);
  causeway.position.set(0, -1.5, (causeFrom + causeTo) / 2);
  fallback.add(causeway);
  const dais = new THREE.Mesh(keep(new THREE.CylinderGeometry(7, 7.6, 3, 9)), rockMat);
  dais.position.set(0, -1.49, 12);
  fallback.add(dais);

  // Glowing fissures in the causeway top (one merged mesh).
  const fissureParts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 26; i++) {
    const g = new THREE.PlaneGeometry(0.05 + rnd() * 0.07, 0.6 + rnd() * 1.8);
    g.rotateX(-Math.PI / 2);
    g.rotateY((rnd() - 0.5) * 1.4);
    g.translate((rnd() - 0.5) * (CW - 1), 0.006, causeFrom + 20 + rnd() * (causeTo - causeFrom - 20));
    fissureParts.push(g);
  }
  const fissureGeo = keep(mergeGeometries(fissureParts)!);
  for (const g of fissureParts) g.dispose();
  const fissureMat = keep(new THREE.MeshBasicMaterial({ color: 0xff5a14, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  fallback.add(new THREE.Mesh(fissureGeo, fissureMat));

  // Hexagonal basalt columns out of the lava on both sides (instanced).
  const colMat = keep(new THREE.MeshLambertMaterial({ color: 0x241614, flatShading: true }));
  const COLS = 70;
  const cols = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(1, 1, 1, 6)), colMat, COLS);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const sc = new THREE.Vector3();
  const ps = new THREE.Vector3();
  const tint = new THREE.Color();
  for (let i = 0; i < COLS; i++) {
    const side = i % 2 ? 1 : -1;
    const x = side * (CW / 2 + 1.6 + Math.pow(rnd(), 1.4) * 34);
    const z = causeFrom + 14 + rnd() * (causeTo - causeFrom + 50);
    const r = 0.6 + rnd() * 1.3;
    const top = -0.6 + Math.pow(rnd(), 1.6) * 9 * Math.min(1, Math.abs(x) / 9);
    const h = top + 1.6;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
    m4.compose(ps.set(x, top - h / 2, z), q, sc.set(r, h, r));
    cols.setMatrixAt(i, m4);
    cols.setColorAt(i, tint.setHSL(0.02, 0.35, 0.55 + rnd() * 0.45));
  }
  fallback.add(cols);

  // Gate on the dais: two leaning obsidian horns + a molten ring between
  // them, framing the far end behind the foe.
  const hornMat = keep(new THREE.MeshLambertMaterial({ color: 0x140b0b, flatShading: true }));
  const horns = new THREE.InstancedMesh(keep(new THREE.ConeGeometry(1.25, 15, 5)), hornMat, 2);
  for (const [i, s] of [[0, -1], [1, 1]] as const) {
    q.setFromEuler(new THREE.Euler(0.1, 0, -s * 0.22));
    m4.compose(ps.set(s * 5.4, 6.6, 14), q, sc.set(1, 1, 1));
    horns.setMatrixAt(i, m4);
  }
  fallback.add(horns);
  const ringMat = keep(new THREE.MeshBasicMaterial({ color: 0xff6a1c, fog: false }));
  const ring = new THREE.Mesh(keep(new THREE.TorusGeometry(3.3, 0.2, 8, 40)), ringMat);
  ring.position.set(0, 7.2, 14);
  fallback.add(ring);

  // Volcano silhouettes on the horizon (fog greys them into the red band)
  // with glowing craters.
  const VOLC = 7;
  const volMat = keep(new THREE.MeshLambertMaterial({ color: 0x120707, flatShading: true }));
  const vols = new THREE.InstancedMesh(keep(new THREE.ConeGeometry(1, 1, 7)), volMat, VOLC);
  const capMat = keep(new THREE.MeshBasicMaterial({ color: 0xff4a10, fog: false }));
  const caps = new THREE.InstancedMesh(keep(new THREE.CylinderGeometry(1, 1, 1, 7)), capMat, VOLC);
  for (let i = 0; i < VOLC; i++) {
    const a = -1.15 + (i / (VOLC - 1)) * 2.3 + (rnd() - 0.5) * 0.15;
    const d = 150 + rnd() * 70;
    const r = 28 + rnd() * 26;
    const h = 22 + rnd() * 26;
    const cx = Math.sin(a) * d;
    const cz = Math.cos(a) * d;
    m4.compose(ps.set(cx, h / 2 - 1.3, cz), q.identity(), sc.set(r, h, r));
    vols.setMatrixAt(i, m4);
    // Crater = the cone's cut top, glowing.
    m4.compose(ps.set(cx, h * 0.96 - 1.3, cz), q.identity(), sc.set(r * 0.06, 0.6, r * 0.06));
    caps.setMatrixAt(i, m4);
  }
  fallback.add(vols, caps);

  // Rune circles under each duelist (world space, merged).
  const runeParts = [playerAt, foeAt].map((p) => {
    const g = new THREE.RingGeometry(0.5, 0.6, 6);
    g.rotateX(-Math.PI / 2);
    g.translate(p.x, 0.012, p.z);
    return g;
  });
  const runeGeo = keep(mergeGeometries(runeParts)!);
  for (const g of runeParts) g.dispose();
  const runeMat = keep(new THREE.MeshBasicMaterial({ color: 0xff5a1a, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  const runes = new THREE.Mesh(runeGeo, runeMat);
  scene.add(runes);

  // Lights: lava glow from BELOW (lights the undersides of brims, arms,
  // coat) + a crimson rim from beyond the gate toward the camera.
  const up = new THREE.DirectionalLight(0xff4a14, 1.0);
  up.position.copy(mid).add(new THREE.Vector3(0, -10, 0));
  up.target.position.copy(mid);
  const rim = new THREE.DirectionalLight(0xff2a12, 0.9);
  rim.position.copy(foeAt).addScaledVector(axis, 20).add(new THREE.Vector3(0, 8, 0));
  rim.target.position.copy(mid);
  scene.add(up, up.target, rim, rim.target);

  document.body.classList.add("hell");

  // Blender set: same frame as build_hell.py (origin = the foe's feet,
  // Blender +Y = away from the player -> glTF -Z, so the street's yaw
  // formula applies).
  let live = true;
  let glb: THREE.Group | null = null;
  const glbMats: THREE.Material[] = [];
  if (glbUrl) {
    void (async () => {
      try {
        const { GLTFLoader } = await import("three/examples/jsm/loaders/GLTFLoader.js");
        const gltf = await new GLTFLoader().loadAsync(glbUrl);
        if (!live) return;
        // No normals shipped: Lambert + flatShading (derivative normals),
        // double-sided because the generated shells are open.
        const paint = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
        addDirtDetail(paint, axis, 0.05);
        const glow = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false });
        glbMats.push(paint, glow);
        gltf.scene.traverse((o) => {
          const m = o as THREE.Mesh;
          if (!m.isMesh) return;
          (m.material as THREE.Material).dispose();
          m.material = o.name.startsWith("X_Glow") ? glow : paint;
        });
        const g = new THREE.Group();
        g.name = "HellGlb";
        g.add(gltf.scene);
        g.position.copy(anchor);
        g.rotation.y = Math.atan2(-axis.x, -axis.z);
        scene.add(g);
        glb = g;
        fallback.visible = false;
      } catch (err) {
        if (import.meta.env.DEV) console.warn(`[gamey] hell GLB failed: ${glbUrl}`, err);
      }
    })();
  }

  return {
    tick(tSec) {
      lavaMat.uniforms.t.value = tSec;
      eclipseMat.uniforms.t.value = tSec;
      const flick = 0.5 + 0.5 * Math.sin(tSec * 2.3) * Math.sin(tSec * 0.7 + 1.1);
      up.intensity = 0.85 + 0.3 * flick;
      fissureMat.opacity = 0.6 + 0.35 * flick;
    },
    dispose() {
      live = false;
      scene.remove(set, runes, up, up.target, rim, rim.target);
      if (glb) {
        scene.remove(glb);
        glb.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) m.geometry.dispose(); });
      }
      for (const m of glbMats) m.dispose();
      for (const o of hidden) o.visible = true;
      scene.background = prevBg;
      document.body.classList.remove("hell");
      cols.dispose();
      horns.dispose();
      vols.dispose();
      caps.dispose();
      for (const d of disposables) d.dispose();
    },
  };
}
