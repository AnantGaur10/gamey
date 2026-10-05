"""Deterministic GLB build for the cowboys (run headless, never saves the .blend).

    npm run build:models      # = blender -b blender/cowboys.blend --python this

WHY A SCRIPT, NOT EDITS TO THE .blend: the NLA strips HOLD in both directions,
so the saved object properties are whatever strip was topmost at frame 25 (the
held wound_crouch pose), and saving/reloading with tracks unmuted does NOT
round-trip manual rest-pose / pivot edits (verified: save -> reload -> export
diverges on Leg_L, Knee_L/R, elbowR). Keep blender/cowboys.blend as the
untouched source and regenerate the GLBs from it with this script.

Steps: mute NLA -> authored STANDING pose (frame 1 of fall_back_*) -> rebuild the
knee/shin chain in world space -> reparent loose parts (boots, spurs, chaps,
coat tails, left forearm/fingers) preserving world transforms -> bevel segments
1 (~4.4k tris/cowboy, locked budget 3-5k) -> drop the inert wound clips and
re-key the visible flinch/victory/defeat arm clips -> export with
export_apply=True.
Verify afterwards: same node names + node TRS, 28 animations, Pelvis y 0.95,
Knee/Waist 0.
"""
import os
import bpy, mathutils
V, M = mathutils.Vector, mathutils.Matrix
def O(n): return bpy.data.objects[n]
def upd(): bpy.context.view_layer.update()
def set_world(o, w):  # identity rotation/scale assumed (rest pose)
    pm = (o.parent.matrix_world @ o.matrix_parent_inverse) if o.parent else M.Identity(4)
    o.location = pm.inverted() @ V(w)
report = []
for pre, coll in (("H_","Hero"),("O_","Outlaw")):
    for o in bpy.data.collections[coll].objects:
        ad = o.animation_data
        if ad:
            for t in ad.nla_tracks: t.mute = True
    # a. authored standing pose (frame 1 of fall_back) + neutral waist/knees
    for a in bpy.data.actions:
        if not a.name.startswith(pre + "fall_back_"): continue
        o = O(pre + a.name[len(pre + "fall_back_"):])
        for fc in a.fcurves:
            v = fc.evaluate(1)
            if fc.data_path == "location": o.location[fc.array_index] = v
            elif fc.data_path == "rotation_euler": o.rotation_euler[fc.array_index] = v
    for n in ("Knee_L","Knee_R","Waist"): O(pre+n).rotation_euler = (0,0,0)
    upd()
    for s in ("L","R"):
        leg, knee, shin = O(f"{pre}Leg_{s}"), O(f"{pre}Knee_{s}"), O(f"{pre}Shin_{s}")
        x = leg.matrix_world.translation.x
        leg.location.y -= leg.matrix_world.translation.y   # centre the stance in y
        upd()
        set_world(knee, (x, 0.0, 0.22)); upd()
        set_world(shin, (x, 0.0, 0.22)); upd()
        shin.data.transform(M.Scale(0.65, 4, (0,0,1)))      # origin is the shin top
    upd()
    def adopt(child, parent):
        c, p = O(pre+child), O(pre+parent)
        before = c.matrix_world.translation.copy()
        mw = c.matrix_world.copy()
        c.parent = p
        c.matrix_parent_inverse = p.matrix_world.inverted()
        c.matrix_world = mw
        upd()
        d = (c.matrix_world.translation - before).length
        report.append((pre+child, round(d, 5)))
    for s in ("L","R"):
        adopt(f"Boot_{s}", f"Shin_{s}"); adopt(f"Spur_{s}", f"Boot_{s}"); adopt(f"Chaps_{s}", f"Leg_{s}")
        adopt(f"CoatTail_{s}", "Torso")
    adopt("Fore_L", "Sleeve_L")
    for i in range(3): adopt(f"Finger_L{i}", "Hand_L")
bad = [r for r in report if r[1] > 1e-3]
print("adopted", len(report), "moved>1mm:", bad)

# --- bevel budget -----------------------------------------------------------
for c in ("Hero", "Outlaw"):
    for o in bpy.data.collections[c].objects:
        for m in o.modifiers:
            if m.type == 'BEVEL': m.segments = 1
upd()

# --- clips: drop the inert wound set, polish the visible arm clips ----------
# wound_bend / wound_crouch / wounded are never played: wound poses are
# procedural (WOUND_POSE_TARGET / WOUND_JOINTS in home.ts) and these clips key
# Leg/Knee/Waist, which would fight driveJoints anyway. 19 per cowboy.
DROP_TRACKS = ("wounded", "wound_bend", "wound_crouch")
for coll in ("Hero", "Outlaw"):
    for o in bpy.data.collections[coll].objects:
        ad = o.animation_data
        if not ad: continue
        for t in [t for t in ad.nla_tracks if t.name in DROP_TRACKS]:
            ad.nla_tracks.remove(t)
for a in [a for a in bpy.data.actions if any(a.name.startswith(p + d + "_") for p in ("H_", "O_") for d in DROP_TRACKS)]:
    bpy.data.actions.remove(a)
# Visible clips (armR/elbowR rotation x, 24fps, same keys for both rigs; the
# game's shoulder mount makes these standing-frame angles at any wound pose).
# + armR = gun toward the dirt (guns-down 0.55), - = skyward (victory -0.9).
# flinch: impact snap -> recoil overshoot past level -> settle. Ends by f10
#   (~0.4s) at the raised pose, before home.ts releases it (FLINCH_END 0.45s).
# victory: anticipation dip -> overshoot skyward -> settle on -0.9.
# defeat: brief lift -> slump with weight -> small rebound -> settle on 0.9.
CLIP_KEYS = {
    "flinch_armR":    [(1, 0.05), (2, 0.30), (3, 0.40), (5, 0.22), (7, -0.04), (9, 0.07), (10, 0.05)],
    "flinch_elbowR":  [(1, 0.0), (2, -0.38), (3, -0.55), (5, -0.25), (7, 0.08), (9, -0.02), (10, 0.0)],
    "victory_armR":   [(1, 0.05), (4, 0.18), (10, -1.02), (14, -0.86), (17, -0.92), (20, -0.9)],
    "victory_elbowR": [(1, 0.0), (4, -0.12), (10, 0.10), (14, -0.03), (20, 0.0)],
    "defeat_armR":    [(1, 0.05), (3, -0.04), (12, 0.96), (15, 0.86), (18, 0.91), (20, 0.9)],
    "defeat_elbowR":  [(1, 0.0), (3, 0.05), (12, -0.46), (15, -0.36), (20, -0.4)],
}
for pre in ("H_", "O_"):
    for clip, keys in CLIP_KEYS.items():
        fc = bpy.data.actions[pre + clip].fcurves.find("rotation_euler", index=0)
        fc.keyframe_points.clear()
        for f, v in keys:
            fc.keyframe_points.insert(f, v)
        fc.update()
print("clips: dropped", DROP_TRACKS, "rekeyed", sorted(CLIP_KEYS))

# --- holstered start (user 2026-10-05) ----------------------------------------
# The revolver used to be loose meshes on elbowR, always in hand. Now:
#  {P}_Gun        empty under elbowR (origin at the grip), owns every revolver
#                 mesh + gunTip, so the game can move the gun as one node;
#  {P}_GunHolster empty under Pelvis = the Gun's world transform when tucked
#                 in the holster (barrel straight down, cylinder just above the
#                 lip, grip to the rear). Solved from the meshes, not placed.
# The holster is deepened to fit the barrel, and the idle clip is re-keyed so
# the gun hand rests on the holstered grip (solved numerically below).
GUN_PARTS = ("Barrel", "Cylinder", "CylPin", "Ejector", "Frame", "Grip", "GripCap",
             "GuardB", "GuardF", "GuardR", "Hammer", "RearSight", "Sight", "Trigger", "gunTip")
def bbox_w(o):
    pts = [o.matrix_world @ V(c) for c in o.bound_box]
    return V((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))), \
           V((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts)))
def centre_w(o):
    a, b = bbox_w(o)
    return (a + b) / 2
IDLE_POSE = {}
for pre, coll in (("H_", "Hero"), ("O_", "Outlaw")):
    upd()
    col = bpy.data.collections[coll]
    elbow, pelvis = O(pre + "elbowR"), O(pre + "Pelvis")
    extra = [c.name for c in elbow.children if c.name[len(pre):] not in GUN_PARTS + ("Hand_R", "Fore_R")]
    if extra: print("WARN elbowR children not classified:", extra)
    gun = bpy.data.objects.new(pre + "Gun", None)
    col.objects.link(gun)
    gun.parent = elbow
    gun.matrix_parent_inverse = M.Identity(4)
    mw = elbow.matrix_world.copy()
    mw.translation = centre_w(O(pre + "Grip"))
    gun.matrix_world = mw
    upd()
    for n in GUN_PARTS:
        c = O(pre + n)
        w = c.matrix_world.copy()
        c.parent = gun
        c.matrix_parent_inverse = gun.matrix_world.inverted()
        c.matrix_world = w
    upd()
    # Holstered transform: rotate the gun about its cylinder so the muzzle
    # (cylinder -> gunTip) points straight down, then drop the barrel into
    # the holster's centre with the cylinder sitting on the lip.
    hol = O(pre + "Holster")
    h0, h1 = bbox_w(hol)
    cyl = centre_w(O(pre + "Cylinder"))
    tip = O(pre + "gunTip").matrix_world.translation.copy()
    R = (tip - cyl).normalized().rotation_difference(V((0, 0, -1))).to_matrix().to_4x4()
    tgt = V(((h0.x + h1.x) / 2, (h0.y + h1.y) / 2, h1.z + 0.05))
    hold = M.Translation(tgt) @ R @ M.Translation(-cyl) @ gun.matrix_world
    # Centre the BARREL (not the cylinder) in the holster mouth.
    bar = O(pre + "Barrel")
    bc = hold @ gun.matrix_world.inverted() @ centre_w(bar)
    hold = M.Translation(V((tgt.x - bc.x, tgt.y - bc.y, 0))) @ hold
    sock = bpy.data.objects.new(pre + "GunHolster", None)
    col.objects.link(sock)
    sock.parent = pelvis
    sock.matrix_parent_inverse = M.Identity(4)
    sock.matrix_world = hold
    upd()
    # Fit the holster to the holstered gun: it wraps everything below the
    # cylinder (barrel, frame, guards, trigger, sights) with a margin; the
    # cylinder, hammer and grip ride above the lip. Affine remap of the
    # authored holster box (bevel stays a modifier, applied on export).
    rel = hold @ gun.matrix_world.inverted()
    def hbox(names):
        lo, hi = V((1e9, 1e9, 1e9)), V((-1e9, -1e9, -1e9))
        for n in names:
            o = O(pre + n)
            for c in o.bound_box:
                p = rel @ (o.matrix_world @ V(c))
                lo, hi = V((min(lo.x, p.x), min(lo.y, p.y), min(lo.z, p.z))), V((max(hi.x, p.x), max(hi.y, p.y), max(hi.z, p.z)))
        return lo, hi
    cyl_lo, _ = hbox(("Cylinder",))
    lip = cyl_lo.z + 0.035                     # covers the cylinder's lower edge
    blo, bhi = hbox(("Barrel", "Frame", "GuardB", "GuardF", "GuardR", "Trigger", "Sight", "Ejector"))
    m = 0.018
    t_lo = V((blo.x - m, blo.y - m, blo.z - 0.03))
    t_hi = V((bhi.x + m, bhi.y + m, lip))
    if hol.data.users > 1: hol.data = hol.data.copy()
    mw, mwi = hol.matrix_world, hol.matrix_world.inverted()
    for v in hol.data.vertices:
        w = mw @ v.co
        w = V(tuple(t_lo[i] + (w[i] - h0[i]) / max(1e-6, h1[i] - h0[i]) * (t_hi[i] - t_lo[i]) for i in range(3)))
        v.co = mwi @ w
    hol.data.update()
    upd()
    tip_h = (rel @ tip).z
    # Hand-on-holster idle pose: grid-search armR x/z + elbowR x (rotation
    # basis = what the clip keys) so the gun hand sits on the holstered grip.
    grip_h = hold @ gun.matrix_world.inverted() @ centre_w(O(pre + "Grip"))
    target = grip_h + V((0, 0, 0.03))
    arm, hand = O(pre + "armR"), O(pre + "Hand_R")
    a0 = (arm.rotation_euler.x, arm.rotation_euler.z, elbow.rotation_euler.x)
    def frange(a, b, n): return [a + (b - a) * i / n for i in range(n + 1)]
    def search(xs, zs, es):
        best = (1e9, None)
        for ax in xs:
            for az in zs:
                arm.rotation_euler.x, arm.rotation_euler.z = ax, az
                for ex in es:
                    elbow.rotation_euler.x = ex
                    upd()
                    d = (centre_w(hand) - target).length
                    if d < best[0]: best = (d, (ax, az, ex))
        return best
    best = search(frange(-1.4, 1.4, 14), frange(-1.0, 1.0, 10), frange(-2.0, 1.0, 15))   # coarse 0.2 rad
    cx, cz, ce = best[1]
    best = search(frange(cx - 0.2, cx + 0.2, 10), frange(cz - 0.2, cz + 0.2, 10), frange(ce - 0.2, ce + 0.2, 10))
    ax, az, ex = best[1]
    IDLE_POSE[pre] = best[1]
    arm.rotation_euler.x, arm.rotation_euler.z, elbow.rotation_euler.x = a0
    upd()
    print(pre, "holster: tip z", round(tip_h, 3), "holster z", round(t_lo.z, 3), "..", round(t_hi.z, 3), "xy", [round(t_hi[i] - t_lo[i], 3) for i in (0, 1)],
          "| idle pose armR x/z", round(ax, 3), round(az, 3), "elbowR x", round(ex, 3), "hand err", round(best[0], 3))
# Re-key idle on the solved pose (+ a slow breath on the shoulder).
for pre in ("H_", "O_"):
    ax, az, ex = IDLE_POSE[pre]
    for clip, keys in (("idle_armR", [(1, ax), (13, ax + 0.02), (25, ax), (37, ax - 0.02), (48, ax)]),
                       ("idle_elbowR", [(1, ex), (25, ex - 0.015), (48, ex)])):
        fc = bpy.data.actions[pre + clip].fcurves.find("rotation_euler", index=0)
        fc.keyframe_points.clear()
        for f, v in keys: fc.keyframe_points.insert(f, v)
        fc.update()
    act = bpy.data.actions[pre + "idle_armR"]
    fz = act.fcurves.find("rotation_euler", index=2) or act.fcurves.new("rotation_euler", index=2)
    fz.keyframe_points.clear()
    for f in (1, 13, 25, 37, 48): fz.keyframe_points.insert(f, az)  # same frames as x: no exporter re-bake
    fz.update()

# --- export (NLA stays muted; this process never saves the .blend) ----------
OUT = os.environ.get("GLB_OUT") or os.path.normpath(
    os.path.join(os.path.dirname(bpy.data.filepath), "..", "public", "models"))
for coll, name in (("Hero", "cowboy_hero"), ("Outlaw", "cowboy_outlaw")):
    bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection.children[coll]
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + ".glb"), export_format="GLB",
                              use_active_collection=True, export_apply=True, export_animations=True)
print("EXPORTED to", OUT)
