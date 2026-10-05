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

# --- export (NLA stays muted; this process never saves the .blend) ----------
OUT = os.environ.get("GLB_OUT") or os.path.normpath(
    os.path.join(os.path.dirname(bpy.data.filepath), "..", "public", "models"))
for coll, name in (("Hero", "cowboy_hero"), ("Outlaw", "cowboy_outlaw")):
    bpy.context.view_layer.active_layer_collection = bpy.context.view_layer.layer_collection.children[coll]
    bpy.ops.export_scene.gltf(filepath=os.path.join(OUT, name + ".glb"), export_format="GLB",
                              use_active_collection=True, export_apply=True, export_animations=True)
print("EXPORTED to", OUT)
