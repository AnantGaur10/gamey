import * as THREE from "three";
import { FXAAShader } from "three/examples/jsm/shaders/FXAAShader.js";

// Post chain (user 2026-10-06, "MSAA is very expensive ... use FXAA"): the
// scene renders into an 8-bit target (no MSAA), then ONE fullscreen
// pass runs FXAA and grades its result: tint (lift/gain) + saturation in
// linear, filmic tone map (ACES), sRGB encode, contrast. A separate grade
// pass cost a whole extra screen of fill on software GL, so edge detection reads a cheap perceptual luma of the linear image and
// the grade runs once per pixel on FXAA's final sample. The renderer's own
// toneMapping stays None (three skips it for render targets anyway).

export interface Grade {
  exposure: number;
  saturation: number;
  contrast: number;
  /** Shadow tint added in linear (0 = none). */
  lift: [number, number, number];
  /** Per-channel multiplier in linear (1 = none). */
  gain: [number, number, number];
}

/** Filmic curve. ACES keeps the baked palette punchy; AgX (tried first)
    washed it out. */
const TONE_FN = "ACESFilmicToneMapping";

export interface Post {
  render(scene: THREE.Scene, camera: THREE.Camera): void;
  /** Drawing-buffer size in device pixels. */
  setSize(w: number, h: number): void;
  setGrade(g: Grade): void;
  dispose(): void;
}

const GRADE = `
  #include <tonemapping_pars_fragment>
  uniform float uSat;
  uniform float uContrast;
  uniform vec3 uLift;
  uniform vec3 uGain;
  vec3 grade(vec3 c) {
    c = c * uGain + uLift * (1.0 - min(c, 1.0));
    float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
    c = max(mix(vec3(l), c, uSat), 0.0);
    c = ${TONE_FN}(c);
    c = sRGBTransferOETF(vec4(c, 1.0)).rgb;
    return clamp((c - 0.5) * uContrast + 0.5, 0.0, 1.0);
  }
`;

/** three's FXAA, reading a LINEAR target: luma for edge detection is
    compressed (sqrt(l / (1 + l)) ~ display luma), the output is graded. */
function fxaaGradeShader(): string {
  const src = FXAAShader.fragmentShader;
  const lumaIn = "return dot( Sample( tex2D, uv ).rgb, vec3( 0.3, 0.59, 0.11 ) );";
  const mainIn = "gl_FragColor = ApplyFXAA( tDiffuse, resolution.xy, vUv );";
  if (!src.includes(lumaIn) || !src.includes(mainIn)) throw new Error("FXAAShader changed");
  return src
    .replace(lumaIn, "float l = dot( Sample( tex2D, uv ).rgb, vec3( 0.3, 0.59, 0.11 ) ); return sqrt( l / ( 1.0 + l ) );")
    .replace("void main() {", `${GRADE}\nvoid main() {`)
    .replace(mainIn, "gl_FragColor = vec4( grade( ApplyFXAA( tDiffuse, resolution.xy, vUv ).rgb ), 1.0 );");
}

export function createPost(renderer: THREE.WebGLRenderer): Post | null {
  try {
    // Plain 8-bit linear storage. On software GL an sRGB target (decoded on
    // each of FXAA's ~20 taps) or half float cost ~100ms more per 1080p frame.
    // Values clip at 1 before the tone map (glows are <= 1).
    const sceneRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true, stencilBuffer: false });

    const tri = new THREE.BufferGeometry();
    tri.setAttribute("position", new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    tri.setAttribute("uv", new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: sceneRT.texture },
        resolution: { value: new THREE.Vector2(1, 1) },
        toneMappingExposure: { value: 1 },
        uSat: { value: 1 },
        uContrast: { value: 1 },
        uLift: { value: new THREE.Vector3() },
        uGain: { value: new THREE.Vector3(1, 1, 1) },
      },
      vertexShader: FXAAShader.vertexShader,
      fragmentShader: fxaaGradeShader(),
      depthTest: false,
      depthWrite: false,
    });
    const quad = new THREE.Mesh(tri, mat);
    quad.frustumCulled = false;

    return {
      render(scene, camera) {
        renderer.setRenderTarget(sceneRT);
        renderer.render(scene, camera);
        renderer.setRenderTarget(null);
        renderer.render(quad, cam);
      },
      setSize(w, h) {
        w = Math.max(1, Math.floor(w));
        h = Math.max(1, Math.floor(h));
        sceneRT.setSize(w, h);
        mat.uniforms.resolution.value.set(1 / w, 1 / h);
      },
      setGrade(g) {
        const u = mat.uniforms;
        u.toneMappingExposure.value = g.exposure;
        u.uSat.value = g.saturation;
        u.uContrast.value = g.contrast;
        u.uLift.value.set(...g.lift);
        u.uGain.value.set(...g.gain);
      },
      dispose() {
        sceneRT.dispose();
        tri.dispose();
        mat.dispose();
      },
    };
  } catch (err) {
    if (import.meta.env.DEV) console.warn("[gamey] post chain failed, rendering direct", err);
    return null;
  }
}
