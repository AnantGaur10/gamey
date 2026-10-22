"""Store covers (CrazyGames: 1920x1080, 800x1200, 800x800) rendered from the
game's own GLBs: the hero from behind his right hip, a ladder foe down Main
Street, low sun behind the foe. Text-free plates; the title is laid over them
by scripts/covers.mjs (headless Chromium, the game's own Rye + gold CSS).

Run: npm run build:covers (this script, then covers.mjs). Alone:
  blender -b --factory-startup --python scripts/blender/build_covers.py
Env: COVER_OUT (dir, default store/covers/plates), COVER_SAMPLES (default
128), COVER_SCALE (percent, default 100; 25 for fast look-dev),
COVER_ONLY (land|port|square), COVER_FOE (outfit, default outlaw).
Never opens or saves a .blend; reads only public/models/*.glb.
"""
import bpy, math, os
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
MODELS = os.path.join(ROOT, "public", "models")
OUT = os.environ.get("COVER_OUT", os.path.join(ROOT, "store", "covers", "plates"))
SAMPLES = int(os.environ.get("COVER_SAMPLES", "128"))
SCALE = int(os.environ.get("COVER_SCALE", "100"))
ONLY = os.environ.get("COVER_ONLY", "")
FOE = os.environ.get("COVER_FOE", "outlaw")
SET = os.environ.get("COVER_SET", "town")

FOE_Y = 9.5          # set_kit.py: the foe stands at (0, 9.5, 0), facing +Y
GAP = 8.0            # hero <-> foe (along y)
HERO_Y = FOE_Y + GAP
HERO_X = 0.9           # hero and foe off centre so the foe shows past him
FOE_X = -2.0           # in front of the open end of Telegraph Row, under the sun
SUN_FROM = Vector((-0.085, -1.0, 0.15)).normalized()   # behind the foe, above the roofs
SUN_DISC_DEG = 2.2

def srgb(h):
    def c(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255), 1.0)

def clear_scene():
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)

def import_glb(name):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(MODELS, name))
    return [o for o in bpy.data.objects if o not in before]

def vcol_material(src, glow=False):
    """Baked palette x AO lives in the colour attribute: show it lit by the
    sun, plus a little of it as emission so baked shadows never go black."""
    m = bpy.data.materials.new(src.name + "_cov")
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bs = nt.nodes.new("ShaderNodeBsdfPrincipled")
    ca = nt.nodes.new("ShaderNodeVertexColor")
    nt.links.new(ca.outputs["Color"], bs.inputs["Base Color"])
    bs.inputs["Roughness"].default_value = 0.9
    bs.inputs["Specular IOR Level"].default_value = 0.2
    if glow:
        bs.inputs["Emission Color"].default_value = srgb(0xffb860)
        bs.inputs["Emission Strength"].default_value = 3.0
    else:
        nt.links.new(ca.outputs["Color"], bs.inputs["Emission Color"])
        bs.inputs["Emission Strength"].default_value = 0.12
    nt.links.new(bs.outputs["BSDF"], out.inputs["Surface"])
    return m

def repaint(objs):
    cache = {}
    for o in objs:
        if o.type != "MESH":
            continue
        for i, slot in enumerate(o.material_slots):
            src = slot.material
            if src is None:
                continue
            if src.name not in cache:
                cache[src.name] = vcol_material(src, glow="Glow" in src.name)
            o.material_slots[i].material = cache[src.name]

def pose_cowboy(objs, prefix, clip="idle", frame=0):
    """Rest pose + the clip on the gun arm (idle = hand on the holstered
    grip, as before DRAW in game). Drops every other imported clip."""
    for o in objs:
        ad = o.animation_data
        if not ad:
            continue
        for t in list(ad.nla_tracks):
            ad.nla_tracks.remove(t)
        ad.action = bpy.data.actions.get(f"{prefix}_{clip}_{o.name[len(prefix) + 1:]}")
    # makeGunHolster().holster(): the revolver sits in its hip socket.
    gun = bpy.data.objects.get(f"{prefix}_Gun")
    socket = bpy.data.objects.get(f"{prefix}_GunHolster")
    if gun and socket:
        gun.parent = socket
        gun.matrix_parent_inverse.identity()
        gun.location = (0, 0, 0)
        gun.rotation_quaternion = (1, 0, 0, 0)
    bpy.context.scene.frame_set(frame)

def place(objs, prefix, loc, yaw_deg):
    """Like cowboyGlb.ts: centre on the pelvis (outfit GLBs are authored off
    to the side), feet on the ground."""
    bpy.context.view_layer.update()
    pelvis = bpy.data.objects[f"{prefix}_Pelvis"].matrix_world.translation
    feet = min((o.matrix_world @ v.co).z for o in objs if o.type == "MESH" for v in o.data.vertices)
    off = Vector((-pelvis.x, -pelvis.y, -feet))
    root = bpy.data.objects.new("Root", None)
    bpy.context.scene.collection.objects.link(root)
    centre = bpy.data.objects.new("Centre", None)
    bpy.context.scene.collection.objects.link(centre)
    centre.parent = root
    centre.location = off
    for o in objs:
        if o.parent is None:
            o.parent = centre
    root.location = loc
    root.rotation_euler = (0, 0, math.radians(yaw_deg))
    return root

def cowboy(glb, prefix, loc, yaw_deg, clip="idle"):
    objs = import_glb(glb)
    repaint(objs)
    pose_cowboy(objs, prefix, clip)
    place(objs, prefix, loc, yaw_deg)
    return objs

def world():
    w = bpy.data.worlds.new("Sky")
    bpy.context.scene.world = w
    w.use_nodes = True
    nt = w.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputWorld")
    bg = nt.nodes.new("ShaderNodeBackground")
    L = nt.links.new
    tc = nt.nodes.new("ShaderNodeTexCoord")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    L(tc.outputs["Generated"], sep.inputs[0])
    # The game's EVENING sky (arena.ts, top -> horizon) by view elevation.
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "B_SPLINE"
    els = ramp.color_ramp.elements
    stops = [(0.0, 0x7a4a3a), (0.06, 0xe8875a), (0.2, 0xa85a4a), (0.55, 0x3a2a5e)]
    els[0].position, els[0].color = stops[0][0], srgb(stops[0][1])
    els[1].position, els[1].color = stops[-1][0], srgb(stops[-1][1])
    for pos, col in stops[1:-1]:
        e = els.new(pos)
        e.color = srgb(col)
    L(sep.outputs["Z"], ramp.inputs["Fac"])
    # Sun disc + glow around it.
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    L(tc.outputs["Generated"], dot.inputs[0])
    dot.inputs[1].default_value = SUN_FROM
    disc = nt.nodes.new("ShaderNodeMapRange")
    disc.inputs["From Min"].default_value = math.cos(math.radians(SUN_DISC_DEG + 0.15))
    disc.inputs["From Max"].default_value = math.cos(math.radians(SUN_DISC_DEG))
    disc.inputs["To Max"].default_value = 1.0
    L(dot.outputs["Value"], disc.inputs["Value"])
    # Glow = dot^64 (tight) + dot^6 (wide warm wash), no hard edge.
    tight = nt.nodes.new("ShaderNodeMath")
    tight.operation = "POWER"
    L(dot.outputs["Value"], tight.inputs[0])
    tight.inputs[1].default_value = 300.0
    wide = nt.nodes.new("ShaderNodeMath")
    wide.operation = "POWER"
    L(dot.outputs["Value"], wide.inputs[0])
    wide.inputs[1].default_value = 6.0
    halo = nt.nodes.new("ShaderNodeMath")
    halo.operation = "MULTIPLY_ADD"
    L(tight.outputs["Value"], halo.inputs[0])
    halo.inputs[1].default_value = 0.9
    wide_k = nt.nodes.new("ShaderNodeMath")
    wide_k.operation = "MULTIPLY"
    wide_k.use_clamp = False
    L(wide.outputs["Value"], wide_k.inputs[0])
    wide_k.inputs[1].default_value = 0.45
    L(wide_k.outputs["Value"], halo.inputs[2])
    sunc = nt.nodes.new("ShaderNodeMix")
    sunc.data_type = "RGBA"
    sunc.blend_type = "ADD"
    sunc.clamp_result = False
    L(halo.outputs["Value"], sunc.inputs["Factor"])
    L(ramp.outputs["Color"], sunc.inputs["A"])
    sunc.inputs["B"].default_value = srgb(0xffb050)
    discc = nt.nodes.new("ShaderNodeMix")
    discc.data_type = "RGBA"
    discc.blend_type = "ADD"
    discc.clamp_result = False
    L(disc.outputs["Result"], discc.inputs["Factor"])
    L(sunc.outputs["Result"], discc.inputs["A"])
    discc.inputs["B"].default_value = (1.0, 0.95, 0.85, 1.0)
    L(discc.outputs["Result"], bg.inputs["Color"])
    bg.inputs["Strength"].default_value = 1.0
    # Lighting (non-camera rays): a soft warm fill instead of the bright sky.
    fill = nt.nodes.new("ShaderNodeBackground")
    fill.inputs["Color"].default_value = srgb(0xc08870)
    fill.inputs["Strength"].default_value = 0.55
    lp = nt.nodes.new("ShaderNodeLightPath")
    mix = nt.nodes.new("ShaderNodeMixShader")
    L(lp.outputs["Is Camera Ray"], mix.inputs["Fac"])
    L(fill.outputs["Background"], mix.inputs[1])
    L(bg.outputs["Background"], mix.inputs[2])
    L(mix.outputs["Shader"], out.inputs["Surface"])
    sun = bpy.data.objects.new("Sun", bpy.data.lights.new("Sun", "SUN"))
    sun.data.energy = 5.0
    sun.data.color = (1.0, 0.72, 0.45)
    sun.data.angle = math.radians(1.5)
    sun.rotation_euler = SUN_FROM.to_track_quat("Z", "Y").to_euler()
    bpy.context.scene.collection.objects.link(sun)

def haze():
    """Dusk haze by depth (Z pass) on the set, never on the sky (Z = 1e10)."""
    sc = bpy.context.scene
    bpy.context.view_layer.use_pass_z = True
    sc.use_nodes = True
    nt = sc.node_tree
    nt.nodes.clear()
    rl = nt.nodes.new("CompositorNodeRLayers")
    comp = nt.nodes.new("CompositorNodeComposite")
    far = nt.nodes.new("CompositorNodeMapRange")
    far.use_clamp = True
    far.inputs["From Min"].default_value = 8.0
    far.inputs["From Max"].default_value = 70.0
    far.inputs["To Max"].default_value = 0.45
    nt.links.new(rl.outputs["Depth"], far.inputs["Value"])
    ground = nt.nodes.new("CompositorNodeMath")
    ground.operation = "LESS_THAN"
    ground.inputs[1].default_value = 1000.0
    nt.links.new(rl.outputs["Depth"], ground.inputs[0])
    fac = nt.nodes.new("CompositorNodeMath")
    fac.operation = "MULTIPLY"
    nt.links.new(far.outputs["Value"], fac.inputs[0])
    nt.links.new(ground.outputs["Value"], fac.inputs[1])
    mix = nt.nodes.new("CompositorNodeMixRGB")
    nt.links.new(fac.outputs["Value"], mix.inputs["Fac"])
    nt.links.new(rl.outputs["Image"], mix.inputs[1])
    mix.inputs[2].default_value = srgb(0xd9825a)
    nt.links.new(mix.outputs["Image"], comp.inputs["Image"])

def camera(name, loc, target, lens, shift=(0, 0)):
    cam = bpy.data.objects.new(name, bpy.data.cameras.new(name))
    cam.location = loc
    cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat("-Z", "Y").to_euler()
    cam.data.lens = lens
    cam.data.shift_x, cam.data.shift_y = shift
    cam.data.clip_start = 0.05
    cam.data.clip_end = 600
    bpy.context.scene.collection.objects.link(cam)
    return cam

# Framings: (file, w, h, camera loc, look-at, lens mm, shift). Hero faces -Y
# toward the foe; the camera sits behind his right hip, low, looking down the
# street past him, so he fills one side and the foe stands small in the gap.
SHOTS = {
    "land":   ("cover_1920x1080.png", 1920, 1080, (-1.0, HERO_Y + 3.8, 0.6), (1.4, FOE_Y, 0.6), 26, (0, 0.2)),
    "port":   ("cover_800x1200.png", 800, 1200, (-1.0, HERO_Y + 5.0, 0.6), (0.9, FOE_Y, 0.6), 32, (0, 0.1)),
    "square": ("cover_800x800.png", 800, 800, (-1.0, HERO_Y + 3.8, 0.6), (1.0, FOE_Y, 0.6), 30, (0, 0.15)),
}

def main():
    clear_scene()
    repaint(import_glb(f"{SET}.glb"))
    face = math.degrees(math.atan2(HERO_X - FOE_X, HERO_Y - FOE_Y))   # foe's yaw toward the hero
    cowboy("cowboy_hero.glb", "H", (HERO_X, HERO_Y, 0), 180 - face)
    cowboy(f"cowboy_{FOE}.glb", "O", (FOE_X, FOE_Y, 0), -face)
    world()
    haze()
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = True
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "Medium High Contrast"
    sc.render.film_transparent = False
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGB"
    sc.render.resolution_percentage = SCALE
    os.makedirs(OUT, exist_ok=True)
    for key, (fname, w, h, loc, target, lens, shift) in SHOTS.items():
        if ONLY and key != ONLY:
            continue
        sc.camera = camera(key, loc, target, lens, shift)
        sc.render.resolution_x, sc.render.resolution_y = w, h
        sc.render.filepath = os.path.join(OUT, fname)
        bpy.ops.render.render(write_still=True)
        print("COVER", sc.render.filepath)

main()
