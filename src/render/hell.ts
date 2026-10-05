// Hell sudden-death arena (Phase-2 Slice 6).
// Lazy chunk loaded AFTER GameplayStart — never in the initial payload.
// Dark rock ground, emissive scrolling lava strips (shader, no particles),
// red fog/lighting, black-red sky via scene + body CSS class.
import * as THREE from "three";

export interface HellHandle {
  dispose(): void;
}

export function enterHell(scene: THREE.Scene): HellHandle {
  const prevFog = scene.fog;
  const prevBg = (scene as THREE.Scene & { background?: unknown }).background;
  scene.fog = new THREE.FogExp2(0x3a0a06, 0.02);
  scene.background = new THREE.Color(0x0d0202);

  const red = new THREE.DirectionalLight(0xff3a12, 1.1);
  red.position.set(-4, 8, -6);
  const under = new THREE.PointLight(0xff5a1a, 12, 30);
  under.position.set(0, 0.6, 0);
  scene.add(red, under);

  // dark rock disc over the dirt
  const rock = new THREE.Mesh(
    new THREE.CircleGeometry(30, 28),
    new THREE.MeshLambertMaterial({ color: 0x1c0f0c }),
  );
  rock.rotation.x = -Math.PI / 2;
  rock.position.y = 0.026; // above the arena ruts (top 0.022), below the lava (0.035+)
  scene.add(rock);
  // Same rock over the arena's under-ground skirt (y=-5): the bottom rows of
  // the ortho frame see that, not the disc, and it read as a tan band.
  const rockUnder = new THREE.Mesh(
    new THREE.PlaneGeometry(600, 400),
    new THREE.MeshLambertMaterial({ color: 0x1c0f0c, fog: false }),
  );
  rockUnder.rotation.x = -Math.PI / 2;
  rockUnder.position.y = -4.99;
  scene.add(rockUnder);

  // emissive lava strips: scrolling shader, zero textures
  const lavaMat = new THREE.ShaderMaterial({
    uniforms: { t: { value: 0 } },
    vertexShader: `varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }`,
    fragmentShader: `varying vec2 vUv; uniform float t;
      void main(){
        float flow = sin((vUv.x*14.0 - t*2.2)) * sin((vUv.y*6.0 + t*1.4));
        vec3 hot = vec3(1.0, 0.32, 0.05);
        vec3 crust = vec3(0.25, 0.03, 0.01);
        vec3 c = mix(crust, hot, smoothstep(-0.4, 0.9, flow));
        gl_FragColor = vec4(c, 1.0);
      }`,
  });
  const strips: THREE.Mesh[] = [];
  for (let i = 0; i < 3; i++) {
    const s = new THREE.Mesh(new THREE.PlaneGeometry(36, 0.9), lavaMat);
    s.rotation.x = -Math.PI / 2;
    s.position.set((i - 1) * 4, 0.035 + i * 0.004, -4 + i * 3.2);
    s.rotation.z = 0.12 * (i - 1);
    scene.add(s);
    strips.push(s);
  }
  document.body.classList.add("hell");
  let live = true;
  const clock = { t: 0 };
  const iv = window.setInterval(() => {
    if (!live) return;
    clock.t += 0.05;
    lavaMat.uniforms.t.value = clock.t;
  }, 50);

  return {
    dispose() {
      live = false;
      window.clearInterval(iv);
      scene.remove(red, under, rock, rockUnder, ...strips);
      scene.fog = prevFog;
      (scene as THREE.Scene & { background?: unknown }).background = prevBg;
      document.body.classList.remove("hell");
      lavaMat.dispose();
      (rock.geometry as THREE.BufferGeometry).dispose();
      rockUnder.geometry.dispose();
      (rockUnder.material as THREE.Material).dispose();
    },
  };
}
