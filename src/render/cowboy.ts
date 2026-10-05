import * as THREE from "three";

// Procedural frontier cowboy: joint hierarchy with shoulder/elbow pivots +
// gun socket so Blender GLBs can drop in later under the same joint names
// with no logic change. Key heights (head 1.9, torso 1.2-1.4) are load
// bearing for hit zones — do not move them.
export interface Cowboy {
  group: THREE.Group;
  armR: THREE.Group; // shoulder pivot (raise on DRAW)
  elbowR: THREE.Group;
  gunTip: THREE.Object3D;
  /** Per-part bodies for the articulated ragdoll (null entries skipped). */
  parts: {
    pelvis: THREE.Object3D | null;
    torso: THREE.Object3D | null;
    head: THREE.Object3D | null;
    upperArmL: THREE.Object3D | null;
    upperArmR: THREE.Object3D | null;
    thighL: THREE.Object3D | null;
    thighR: THREE.Object3D | null;
    shinL?: THREE.Object3D | null;
    shinR?: THREE.Object3D | null;
    forearmR?: THREE.Object3D | null;
  };
  /** Wound-pose joints, driven procedurally every frame (damped chase in
      home.ts). kneeL/R pivot at the knee, waist at the waist, head at its
      centre. thighL/R pivot `hipLift` m BELOW the hip (GLB legs pivot
      mid-thigh; the driver shifts them so they swing about the hip). Null
      when the rig predates them (old GLBs) — always skipped. */
  joints: {
    thighL: THREE.Object3D | null;
    thighR: THREE.Object3D | null;
    kneeL: THREE.Object3D | null;
    kneeR: THREE.Object3D | null;
    waist: THREE.Object3D | null;
    head: THREE.Object3D | null;
    hipLift: number;
    /** Left-arm swing: these nodes rotate together about `pivot` (the
        shoulder, in their shared parent's frame). */
    armL: { nodes: THREE.Object3D[]; pivot: THREE.Vector3 } | null;
    /** Pelvis node whose yaw turns the legs (the waist counter-turns so the
        upper body keeps facing the foe). Null = no hip turn on this rig. */
    hips: THREE.Object3D | null;
    /** +1 when joint rotation.x already follows the group-pitch convention
        (+ tips the top toward the foe); -1 when the rig sits under a node
        turned PI about y (the GLB inner), which mirrors every x rotation. */
    sign: 1 | -1;
  };
  setGunsDown(): void;
  setRaised(): void;
  setFall(dead: boolean): void;
}

export function createCowboy(opts: {
  coat: number;
  hat: number;
  skin: number;
  facing: 1 | -1;
  accent?: number; // bandana + hat band
  moustache?: boolean; // outlaw facial hair (GLB parity for the fallback)
}): Cowboy {
  const { coat, hat, skin, facing, accent = 0xa33b2e, moustache = false } = opts;
  const mat = (c: number) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });
  const dark = mat(0x2e2620);
  const group = new THREE.Group();
  // YXZ: yaw first, then local-X pitch. Wound poses pitch about the LOCAL X
  // axis (local +Z faces the foe on both sides), so bend/crouch/prone lean
  // TOWARD the foe. Default XYZ pitches about world X, which leans the
  // player (yaw ~119°) backward. Single-axis users (setFall, faceToward,
  // firing rock) are unaffected.
  group.rotation.order = "YXZ";

  // Boots + segmented legs (thigh pivots at the hip, shin at the knee) so
  // wound poses kneel for real instead of tilting rigidly. Front is local
  // +Z (faceToward aims +Z at the foe). Geometry is origin-shifted so each
  // mesh rotates about its joint, not its center.
  let thighL: THREE.Mesh | null = null;
  let thighR: THREE.Mesh | null = null;
  let shinL: THREE.Mesh | null = null;
  let shinR: THREE.Mesh | null = null;
  let kneeL: THREE.Group | null = null;
  let kneeR: THREE.Group | null = null;
  for (const s of [-1, 1]) {
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.2, 0.34), mat(0x3a2a1a));
    boot.position.set(s * 0.15, 0.1, 0.05);
    const thighGeo = new THREE.BoxGeometry(0.17, 0.32, 0.19);
    thighGeo.translate(0, -0.16, 0); // origin at hip (top)
    const thigh = new THREE.Mesh(thighGeo, mat(0x4a4640));
    thigh.position.set(s * 0.15, 0.85, 0);
    // Knee hangs under the thigh (mirrors the GLB chain Pelvis>Thigh>Knee>
    // Shin) so bindAccessories sees the shin as joint-driven, never loose.
    const knee = new THREE.Group();
    knee.position.set(0, -0.32, 0); // knee point, relative to hip origin
    const shinGeo = new THREE.BoxGeometry(0.15, 0.33, 0.17);
    shinGeo.translate(0, -0.165, 0); // origin at knee (top)
    const shin = new THREE.Mesh(shinGeo, mat(0x4a4640));
    knee.add(shin);
    thigh.add(knee);
    if (s < 0) { thighL = thigh; kneeL = knee; shinL = shin; } else { thighR = thigh; kneeR = knee; shinR = shin; }
    group.add(boot, thigh);
  }
  // Waist group at hip height: everything above the belt rides it, so wound
  // bends fold at the waist instead of the ankles.
  const waist = new THREE.Group();
  waist.position.set(0, 1.12, 0);
  group.add(waist);
  // Children of waist are positioned relative to it (groupY - 1.12).
  const w = (o: THREE.Object3D, x: number, y: number, z: number): void => {
    o.position.set(x, y - 1.12, z);
    waist.add(o);
  };

  // Pelvis + gun belt with brass buckle.
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.3), mat(0x3a2f26));
  pelvis.position.y = 0.95;
  const belt = new THREE.Mesh(new THREE.BoxGeometry(0.53, 0.1, 0.33), mat(0x241a10));
  belt.position.y = 1.1;
  const buckle = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.08, 0.04), mat(0xd4af37));
  buckle.position.set(0, 1.1, 0.17);
  group.add(pelvis, belt, buckle);

  // Torso coat + vest panels + coat tails + bandana (ride the waist).
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.6, 0.32), mat(coat));
  w(torso, 0, 1.4, 0);
  for (const s of [-1, 1]) {
    const vest = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.5, 0.05), mat(0x2c2018));
    const tail = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.42, 0.06), mat(coat));
    tail.rotation.x = 0.14;
    w(vest, s * 0.14, 1.4, 0.17);
    w(tail, s * 0.13, 1.02, -0.19);
  }
  const bandana = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.13, 0.06), mat(accent));
  w(bandana, 0, 1.66, 0.15);

  // Head + wide-brim hat with band (rides the waist).
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.34, 0.32), mat(skin));
  head.position.y = 1.9 - 1.12;
  waist.add(head);
  // Blocky facial features, parented to the HEAD (local coords = world − 1.9y)
  // so they ride it in the ragdoll. GLB parity: the fallback is never blank.
  const eyeW = mat(0xf2e8d8);
  const pupilM = mat(0x241407);
  for (const s of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.09, 0.02), eyeW);
    eye.position.set(s * 0.08, 0.03, 0.165);
    const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.04, 0.012), pupilM);
    pupil.position.set(s * 0.08, 0.03, 0.178);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.025, 0.02), dark);
    brow.position.set(s * 0.08, 0.1, 0.165);
    head.add(eye, pupil, brow);
  }
  const nose = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.07, 0.04), mat(0xb57e4e));
  nose.position.set(0, -0.03, 0.17);
  head.add(nose);
  if (moustache) {
    const mo = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.04, 0.03), mat(0x2a1a10));
    mo.position.set(0, -0.08, 0.165);
    head.add(mo);
  }
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.35, 0.05, 12), mat(hat));
  brim.position.y = 2.06 - 1.12;
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.175, 0.185, 0.07, 12), mat(accent));
  band.position.y = 2.12 - 1.12;
  const top = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.24, 12), mat(hat));
  top.position.y = 2.22 - 1.12;
  waist.add(brim, band, top);

  // Left arm: sleeve + skin hand, hanging (rides the waist).
  const armL = new THREE.Group();
  armL.position.set(-0.36, 1.62 - 1.12, 0);
  const sleeveL = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.5, 0.15), mat(coat));
  sleeveL.position.y = -0.25;
  const handL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.13, 0.12), mat(skin));
  handL.position.y = -0.55;
  armL.add(sleeveL, handL);
  armL.rotation.z = 0.08;
  waist.add(armL);

  // Right (gun) arm: shoulder pivot -> upper sleeve -> elbow pivot ->
  // forearm sleeve + skin hand gripping a proper revolver.
  const armR = new THREE.Group(); // shoulder pivot
  armR.position.set(0.36, 1.62 - 1.12, 0);
  const upper = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.34, 0.15), mat(coat));
  upper.position.y = -0.17;
  armR.add(upper);
  const elbowR = new THREE.Group();
  elbowR.position.y = -0.34;
  const fore = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.3, 0.13), mat(coat));
  fore.position.y = -0.15;
  const handR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.13, 0.13), mat(skin));
  handR.position.set(0, -0.32, 0.05);
  elbowR.add(fore, handR);
  // Revolver: grip in fist, cylinder, long barrel, top frame.
  const steel = mat(0x3a3a40);
  const grip = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.2, 0.1), mat(0x4a2c14));
  grip.position.set(0, -0.36, 0.06);
  grip.rotation.x = 0.35;
  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.075, 0.13, 10), steel);
  cylinder.rotation.x = Math.PI / 2;
  cylinder.position.set(0, -0.29, 0.15);
  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.08, 0.44), steel);
  barrel.position.set(0, -0.28, 0.4);
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.3), steel);
  frame.position.set(0, -0.235, 0.28);
  const gunTip = new THREE.Object3D();
  gunTip.position.set(0, -0.28, 0.63);
  elbowR.add(grip, cylinder, barrel, frame, gunTip);
  armR.add(elbowR);
  waist.add(armR);

  group.rotation.y = facing > 0 ? 0 : Math.PI;

  function setGunsDown(): void {
    armR.rotation.set(0.55, 0, 0); // muzzle toward dirt (standoff pose)
    elbowR.rotation.x = -0.25;
  }
  function setRaised(): void {
    // Muzzle level toward the foe. NOTE: rotation.x ≈ 0 is level here
    // (+X rotation pitches +Z muzzle DOWN, so PI/2 aims at the dirt).
    armR.rotation.set(0.05, 0, 0);
    elbowR.rotation.x = 0;
  }
  function setFall(dead: boolean): void {
    group.rotation.x = dead ? -Math.PI / 2 + 0.12 : 0;
    group.position.y = dead ? 0.35 : 0;
  }
  setGunsDown();
  const parts = {
    pelvis, torso, head,
    upperArmL: armL as THREE.Object3D,
    upperArmR: armR as THREE.Object3D,
    thighL: thighL as THREE.Object3D | null,
    thighR: thighR as THREE.Object3D | null,
    shinL: shinL as THREE.Object3D | null,
    shinR: shinR as THREE.Object3D | null,
    forearmR: elbowR as THREE.Object3D,
  };
  const joints = {
    thighL: thighL as THREE.Object3D | null,
    thighR: thighR as THREE.Object3D | null,
    kneeL: kneeL as THREE.Object3D | null,
    kneeR: kneeR as THREE.Object3D | null,
    waist: waist as THREE.Object3D | null,
    head: null, // hat parts ride the waist, not the head: a nod would leave them
    hipLift: 0, // thighs already pivot at the hip
    armL: { nodes: [armL], pivot: armL.position.clone() },
    hips: null, // legs hang off the group, no pelvis node to turn
    sign: 1 as const,
  };
  return { group, armR, elbowR, gunTip, parts, joints, setGunsDown, setRaised, setFall };
}
