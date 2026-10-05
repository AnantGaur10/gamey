import * as THREE from "three";

// Gunsmoke + muzzle flash: pooled THREE.Sprites with a procedural
// radial-gradient canvas texture (zero shipped bytes). spawn() is called at
// the gunTip world pos on every shot (player AND foe — same API, symmetric
// for the Slice-2 AI fire path). update(dt) runs every frame.
// Light-wisp style per locked decision: soft pale puff, fast expand, slow
// rise, fade ~0.8s. depthWrite:false, capped pool, ortho-safe soft alpha.
// Muzzle flash = 2-frame additive quad (bright, feeds the locked
// night-readability rule: silhouette + flash at night).

const SMOKE_POOL = 12;
const FLASH_POOL = 4;
const SMOKE_LIFE = 0.8;
const FLASH_LIFE = 0.07; // ~2 frames at 60Hz + margin

function puffTexture(): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 64;
  c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.45, "rgba(255,255,255,0.38)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.needsUpdate = true;
  return tex;
}

interface Puff {
  sprite: THREE.Sprite;
  life: number; // <0 = idle
  seed: number;
}

export interface Gunsmoke {
  /** Spawn one wisp + one flash at a world pos. */
  spawn(pos: THREE.Vector3): void;
  /** Advance all live puffs/flashes. Call every frame. */
  update(dt: number): void;
}

export function createGunsmoke(scene: THREE.Scene): Gunsmoke {
  const shared = puffTexture();
  const smokes: Puff[] = [];
  const flashes: Puff[] = [];
  let nextSmoke = 0;
  let nextFlash = 0;

  for (let i = 0; i < SMOKE_POOL; i++) {
    const mat = new THREE.SpriteMaterial({
      map: shared,
      color: 0xf5f0e6,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    s.visible = false;
    s.scale.setScalar(0.001);
    scene.add(s);
    smokes.push({ sprite: s, life: -1, seed: Math.random() * Math.PI * 2 });
  }
  for (let i = 0; i < FLASH_POOL; i++) {
    const mat = new THREE.SpriteMaterial({
      map: shared,
      color: 0xffd76a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const s = new THREE.Sprite(mat);
    s.visible = false;
    s.scale.setScalar(0.001);
    scene.add(s);
    flashes.push({ sprite: s, life: -1, seed: i });
  }

  function spawn(pos: THREE.Vector3): void {
    const p = smokes[nextSmoke];
    nextSmoke = (nextSmoke + 1) % SMOKE_POOL;
    p.life = 0;
    p.sprite.visible = true;
    p.sprite.position.copy(pos);
    p.sprite.scale.setScalar(0.22);
    p.sprite.material.opacity = 0.5;
    // Slight random drift dir so repeated shots don't stack identically.
    p.seed = Math.random() * Math.PI * 2;

    const f = flashes[nextFlash];
    nextFlash = (nextFlash + 1) % FLASH_POOL;
    f.life = 0;
    f.sprite.visible = true;
    f.sprite.position.copy(pos);
    f.sprite.scale.setScalar(0.55);
    f.sprite.material.opacity = 1;
  }

  function update(dt: number): void {
    const step = Math.min(dt, 0.1);
    for (const p of smokes) {
      if (p.life < 0) continue;
      p.life += step;
      const t = p.life / SMOKE_LIFE;
      if (t >= 1) {
        p.life = -1;
        p.sprite.visible = false;
        continue;
      }
      // Fast expand, slow rise, fade.
      p.sprite.scale.setScalar(0.22 + t * 0.85);
      p.sprite.position.y += step * 0.35;
      p.sprite.position.x += Math.cos(p.seed) * step * 0.12;
      p.sprite.material.opacity = 0.5 * (1 - t);
    }
    for (const f of flashes) {
      if (f.life < 0) continue;
      f.life += step;
      const t = f.life / FLASH_LIFE;
      if (t >= 1) {
        f.life = -1;
        f.sprite.visible = false;
        continue;
      }
      // 2-frame flicker: big on frame 1, slightly smaller on frame 2.
      const frame2 = t > 0.5;
      f.sprite.scale.setScalar(frame2 ? 0.42 : 0.55);
      f.sprite.material.opacity = frame2 ? 0.7 : 1;
    }
  }

  return { spawn, update };
}
