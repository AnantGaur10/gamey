// Armory gun viewer (user 2026-11-02): the real in-hand revolver (the hero
// GLB's `H_Gun` node, painted with the shop finish by `paintGun`) turning in
// each gun card; drag to rotate, it spins on its own when left alone.
//
// ONE WebGL context per session (render/arena.ts): the menu backdrop's
// renderer draws each gun into the bottom-left corner of its own canvas
// BEFORE the backdrop frame, the corner is copied into the card's 2D canvas,
// then the backdrop paints over it. No second context, no readPixels.
import * as THREE from "three";
import { loadCowboyGlb } from "../render/cowboyGlb";
import { paintGun } from "../render/cowboy";
import { setMenuPreRender } from "./menuScene";

interface View {
  slot: HTMLElement;
  cv: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  gun: THREE.Object3D;
  yaw: number;
  pitch: number;
  idleAt: number;
  drag: { id: number; x: number; y: number } | null;
}

const BG = 0x1a1007;
const SPIN = 0.7; // rad/s when idle
const IDLE_AFTER = 1600; // ms after a drag before it spins again

export function mountGunViews(slots: Array<{ el: HTMLElement; gunId: string }>): void {
  if (!slots.length) return;
  let alive = true;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xfff2dd, 0x6a5440, 2.1));
  const key = new THREE.DirectionalLight(0xffe2b0, 2.8);
  key.position.set(2, 3, 2);
  scene.add(key);
  const fill = new THREE.DirectionalLight(0x9ab0ff, 0.6);
  fill.position.set(-2, 1, -2);
  scene.add(fill);
  const camera = new THREE.PerspectiveCamera(28, 1, 0.05, 20);
  const views: View[] = [];
  const painted: THREE.BufferGeometry[] = [];
  const clearCol = new THREE.Color();

  void loadCowboyGlb(`${import.meta.env.BASE_URL}models/cowboy_hero.glb`, "H").then((rig) => {
    const src = rig?.group.getObjectByName("H_Gun");
    if (!alive || !src) return; // no GLB: the card keeps its icon only
    for (const { el, gunId } of slots) {
      const gun = src.clone(true);
      gun.position.set(0, 0, 0);
      gun.rotation.set(0, 0, 0);
      gun.scale.set(1, 1, 1);
      const shared = new Set<THREE.BufferGeometry>();
      gun.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) shared.add(m.geometry); });
      paintGun(gun, gunId);
      gun.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !shared.has(m.geometry)) painted.push(m.geometry); });
      // Centre on its bounds; barrel (-Z) to screen right, seen from +X.
      gun.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(gun);
      const pivot = new THREE.Group();
      gun.position.sub(box.getCenter(new THREE.Vector3()));
      pivot.add(gun);
      pivot.visible = false;
      pivot.userData.size = box.getSize(new THREE.Vector3()).length();
      scene.add(pivot);
      const cv = document.createElement("canvas");
      el.appendChild(cv);
      const ctx = cv.getContext("2d");
      if (!ctx) continue;
      const v: View = { slot: el, cv, ctx, gun: pivot, yaw: 0.45 + views.length * 0.9, pitch: 0.18, idleAt: 0, drag: null };
      views.push(v);
      el.classList.add("live");
      cv.addEventListener("pointerdown", (e) => {
        v.drag = { id: e.pointerId, x: e.clientX, y: e.clientY };
        cv.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      cv.addEventListener("pointermove", (e) => {
        if (!v.drag || v.drag.id !== e.pointerId) return;
        v.yaw += (e.clientX - v.drag.x) * 0.012;
        v.pitch = Math.max(-0.9, Math.min(0.9, v.pitch + (e.clientY - v.drag.y) * 0.01));
        v.drag.x = e.clientX;
        v.drag.y = e.clientY;
      });
      const end = (e: PointerEvent) => {
        if (v.drag?.id !== e.pointerId) return;
        v.drag = null;
        v.idleAt = performance.now() + IDLE_AFTER;
      };
      cv.addEventListener("pointerup", end);
      cv.addEventListener("pointercancel", end);
    }
  });

  let last = performance.now();
  setMenuPreRender((renderer) => {
    if (!alive) return false;
    if (!slots.some((s) => s.el.isConnected)) {
      dispose();
      return false;
    }
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!views.length) return true;
    const pr = renderer.getPixelRatio();
    const full = renderer.getSize(new THREE.Vector2());
    const src = renderer.domElement;
    renderer.getClearColor(clearCol);
    const clearA = renderer.getClearAlpha();
    const autoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.setScissorTest(true);
    renderer.setClearColor(BG, 1);
    for (const v of views) {
      const r = v.slot.getBoundingClientRect();
      const w = Math.max(1, Math.min(Math.round(r.width), full.x));
      const h = Math.max(1, Math.min(Math.round(r.height), full.y));
      if (r.width < 2 || r.height < 2) continue;
      const cw = Math.round(r.width * devicePixelRatio), ch = Math.round(r.height * devicePixelRatio);
      if (v.cv.width !== cw || v.cv.height !== ch) { v.cv.width = cw; v.cv.height = ch; }
      if (!v.drag && now > v.idleAt) {
        v.yaw += SPIN * dt;
        v.pitch += (0.18 - v.pitch) * Math.min(1, dt * 1.5);
      }
      v.gun.rotation.set(v.pitch, v.yaw, 0, "YXZ");
      for (const o of views) o.gun.visible = o === v;
      // Fit: side-on, the gun spans ~70% of a wide slot; tall slots fit its width.
      camera.aspect = w / h;
      const size = v.gun.userData.size as number;
      const fitH = Math.max(size * 0.7, size / 0.75 / camera.aspect);
      camera.position.set(fitH / (2 * Math.tan((camera.fov * Math.PI) / 360)), 0, 0);
      camera.lookAt(0, 0, 0);
      camera.updateProjectionMatrix();
      renderer.setViewport(0, 0, w, h);
      renderer.setScissor(0, 0, w, h);
      renderer.clear();
      renderer.render(scene, camera);
      // Bottom-left corner of the drawing buffer (GL y is up).
      v.ctx.clearRect(0, 0, cw, ch);
      v.ctx.drawImage(src, 0, src.height - h * pr, w * pr, h * pr, 0, 0, cw, ch);
    }
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, full.x, full.y);
    renderer.setClearColor(clearCol, clearA);
    renderer.autoClear = autoClear;
    return true;
  });

  function dispose(): void {
    alive = false;
    for (const g of painted) g.dispose();
    painted.length = 0;
    views.length = 0;
  }
}
