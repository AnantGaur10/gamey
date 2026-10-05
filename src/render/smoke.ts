import * as THREE from "three";

// Gunsmoke + muzzle flash: pooled THREE.Sprites with a procedural
// radial-gradient canvas texture (zero shipped bytes). spawn() is called at
// the gunTip world pos on every shot (player AND foe — same API, symmetric
// for the Slice-2 AI fire path). update(dt) runs every frame.
// Light-wisp style per locked decision: soft pale puff, fast expand, slow
// rise, fade ~0.8s. depthWrite:false, capped pool, ortho-safe soft alpha.
// Muzzle flash = 2-frame additive quad. At night it is the ONLY giveaway of
// the foe (bright variant + afterglow, see spawn).

const SMOKE_POOL = 12;
const FLASH_POOL = 4;
const DUST_POOL = 16;
const SMOKE_LIFE = 0.8;
const FLASH_LIFE = 0.07; // ~2 frames at 60Hz + margin
const DUST_LIFE = 0.75;
// Bright shots (the night foe, user 2026-10-05): the flash is the only
// thing that shows where it stands, so it is bigger and leaves a short
// ember afterglow the eye can still find after the 2-frame flash.
const GLOW_POOL = 4;
const GLOW_LIFE = 0.7;

/** body = hit on a duelist (the locked "no blood, dust puff only"),
 *  ground = a miss striking the street, wood = a miss striking a facade.
 *  Lighter than what they land on (sunlit dust), so they read on tan dirt. */
export type DustKind = "body" | "ground" | "wood";
const DUST: Record<DustKind, { color: number; n: number; size: number; speed: number }> = {
  body: { color: 0xdcc39a, n: 5, size: 0.7, speed: 1.6 },
  ground: { color: 0xf0dcb2, n: 4, size: 0.7, speed: 1.0 },
  wood: { color: 0xf6e8cc, n: 4, size: 0.6, speed: 0.9 },
};

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

interface Dust extends Puff {
  vel: THREE.Vector3;
  size: number;
}

export interface Gunsmoke {
  /** Spawn one wisp + one flash at a world pos; bright = bigger flash +
   *  ember afterglow (night giveaway). */
  spawn(pos: THREE.Vector3, bright?: boolean): void;
  /** Dust burst at an impact point, kicked along the bullet direction. */
  dust(pos: THREE.Vector3, dir: THREE.Vector3, kind: DustKind): void;
  /** Scene light level 0..1 for the unlit smoke/dust sprites (noon 1,
   *  night low) so they never glow brighter than the world around them. */
  setAmbient(k: number): void;
  /** Advance all live puffs/flashes. Call every frame. */
  update(dt: number): void;
  /** Live sprite counts (DEV probes / tests). */
  live(): { smoke: number; dust: number; flash: number; glow: number };
}

export function createGunsmoke(scene: THREE.Scene): Gunsmoke {
  const shared = puffTexture();
  const smokes: Puff[] = [];
  const flashes: Puff[] = [];
  const dusts: Dust[] = [];
  const glows: Puff[] = [];
  let nextGlow = 0;
  let nextSmoke = 0;
  let nextFlash = 0;
  let nextDust = 0;
  let ambient = 1;
  const smokeBase = new THREE.Color(0xf5f0e6);

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
      fog: false, // cuts through the night fog: the night foe's only giveaway
    });
    const s = new THREE.Sprite(mat);
    s.visible = false;
    s.scale.setScalar(0.001);
    scene.add(s);
    flashes.push({ sprite: s, life: -1, seed: i });
  }
  for (let i = 0; i < GLOW_POOL; i++) {
    const mat = new THREE.SpriteMaterial({
      map: shared,
      color: 0xff8a3a,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
    });
    const s = new THREE.Sprite(mat);
    s.visible = false;
    s.scale.setScalar(0.001);
    scene.add(s);
    glows.push({ sprite: s, life: -1, seed: i });
  }
  for (let i = 0; i < DUST_POOL; i++) {
    const mat = new THREE.SpriteMaterial({
      map: shared,
      color: 0xd8bf94,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const s = new THREE.Sprite(mat);
    s.visible = false;
    s.scale.setScalar(0.001);
    scene.add(s);
    dusts.push({ sprite: s, life: -1, seed: 0, vel: new THREE.Vector3(), size: 0.4 });
  }

  function spawn(pos: THREE.Vector3, bright = false): void {
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
    f.seed = bright ? 1 : 0; // scale multiplier flag for update()
    f.sprite.scale.setScalar(bright ? 1.1 : 0.55);
    f.sprite.material.opacity = 1;
    if (bright) {
      const g = glows[nextGlow];
      nextGlow = (nextGlow + 1) % GLOW_POOL;
      g.life = 0;
      g.sprite.visible = true;
      g.sprite.position.copy(pos);
      g.sprite.scale.setScalar(1.6);
      g.sprite.material.opacity = 1;
    }
  }

  function dust(pos: THREE.Vector3, dir: THREE.Vector3, kind: DustKind): void {
    const cfg = DUST[kind];
    for (let k = 0; k < cfg.n; k++) {
      const d = dusts[nextDust];
      nextDust = (nextDust + 1) % DUST_POOL;
      d.life = 0;
      d.size = cfg.size * (0.75 + Math.random() * 0.5);
      d.sprite.visible = true;
      d.sprite.position.copy(pos);
      d.sprite.scale.setScalar(d.size * 0.3);
      d.sprite.material.color.setHex(cfg.color).multiplyScalar(ambient);
      d.sprite.material.opacity = 0.75;
      // Kicked along the shot (out the far side of a body, back up off the
      // dirt/wall), fanned out, with a little lift.
      const out = kind === "body" ? 1 : -0.6;
      d.vel.set(
        dir.x * out + (Math.random() - 0.5) * 1.6,
        0.3 + Math.random() * 0.9,
        dir.z * out + (Math.random() - 0.5) * 1.6,
      ).multiplyScalar(cfg.speed);
    }
  }

  function setAmbient(k: number): void {
    ambient = Math.max(0.15, Math.min(1, k));
    for (const p of smokes) p.sprite.material.color.copy(smokeBase).multiplyScalar(ambient);
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
    for (const d of dusts) {
      if (d.life < 0) continue;
      d.life += step;
      const t = d.life / DUST_LIFE;
      if (t >= 1) {
        d.life = -1;
        d.sprite.visible = false;
        continue;
      }
      // Burst out fast, drag to a hang, slight fall; grow + fade.
      const drag = Math.exp(-step * 5);
      d.vel.multiplyScalar(drag);
      d.vel.y -= step * 0.6;
      d.sprite.position.addScaledVector(d.vel, step);
      d.sprite.scale.setScalar(d.size * (0.35 + 0.65 * Math.sqrt(t)));
      d.sprite.material.opacity = 0.75 * (1 - t);
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
      f.sprite.scale.setScalar((frame2 ? 0.42 : 0.55) * (f.seed ? 2 : 1));
      f.sprite.material.opacity = frame2 ? 0.7 : 1;
    }
  }

  function updateGlows(step: number): void {
    for (const g of glows) {
      if (g.life < 0) continue;
      g.life += step;
      const t = g.life / GLOW_LIFE;
      if (t >= 1) {
        g.life = -1;
        g.sprite.visible = false;
        continue;
      }
      g.sprite.scale.setScalar(1.6 - 0.9 * t);
      g.sprite.material.opacity = (1 - t) * (1 - t);
    }
  }

  function live(): { smoke: number; dust: number; flash: number; glow: number } {
    const n = (a: Puff[]) => a.filter((p) => p.life >= 0).length;
    return { smoke: n(smokes), dust: n(dusts), flash: n(flashes), glow: n(glows) };
  }

  return { spawn, dust, setAmbient, update: (dt) => { update(dt); updateGlows(Math.min(dt, 0.1)); }, live };
}
