"""Shared kit for the generated 1v1 map sets (build_saloon.py, build_falls.py,
build_town.py). build_street.py keeps its own copies (its byte-identical
output must never depend on this file); glb_util.py holds the palette /
material / export helpers this kit builds on.

COORDS = the street's SCREEN space: sx = screen right, y = toward the duel
and the camera (the camera looks down -y), z = up. Converted to Blender by
negating x (the game loader's inner yaw of PI turns Blender +Y toward the duel
and mirrors x back). The game anchors the set 9.5m past the foe, so for a
round's duel distance d (6-25 on the arena x axis, the duelists are 6m apart
across it, so the real gap is sqrt(d^2 + 36) = 8.5 .. 25.7m):
    foe     (0, 9.5, 0)
    player  (0, 9.5 + gap, 0)            y 18.0 .. 35.2
    camera  (1.25, player_y + 3.1, 2.05) y 21.1 .. 38.3
    look at (-1.5, 9.5, 1.0)             vertical FOV 40 deg at 16:9
Keep |x| < 2.5 between the camera and the foe clear of anything taller than
the ankles. The game's ground (ragdoll, hit capsules, dust) is z = 0.

OUTPUT NODES (read by src/render/setGlb.ts):
  S_Paint   static vertex-coloured geometry (flat Lambert, one draw call)
  S_Glow    windows / lamps / candles (emissive driven by time of day; red in hell)
  S_Water   moving water (runtime flow shader: vertical faces flow down, flat
            faces ripple; lava in hell). Vertex colour = water tint/foam.
  S_Foliage leaves / grass / ferns (runtime wind sway in the vertex shader,
            amplitude grows with height above z = 0; ground-level stays put)
  S_Sky     openings to the outside seen from INSIDE (saloon windows, door
            gaps): unlit, painted at runtime from the time-of-day sky (bright at
            noon, orange at dusk, dark at night, red in hell). Vertex colour
            is ignored except as a 0..1 brightness (use white).
  S_Shaft   sunlight: bright floor patches under windows + dusty light beams
            (additive, unlit, no fog; faded out at night). Vertex colour = beam
            colour x strength (keep it dim: ~0x40-0x90 per channel).
  A_Sway*   wind sway about the node origin (trees, bushes, laundry)
  A_Swing*  pendulum about the node origin (chandeliers, hanging signs, lamps)
  A_Spin*   spins about the node's camera-facing axis (windmill vanes)
Every bucket is one draw call: keep A_* nodes few (<= 8 per set).
Colour = palette x Cycles AO x ray-cast sun shadow, clamped to 1, in COLOR_0.

Env (per set script): <SET>_OUT, <SET>_BAKE=0 (skip the bake), <SET>_EXPORT=0,
<SET>_PREVIEW=<png path prefix> (Workbench renders from the game camera at
d = 6 / 15 / 25, plus a hell-tinted one).
"""
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix, Euler

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from glb_util import lin, reset_collection, export, slim_glb  # noqa: E402,F401

rng = random.Random(1)

def seed(n):
    rng.seed(n)

def jit(col, amt, r=None):
    r = r or rng
    k = 1.0 + (r.random() * 2 - 1) * amt
    return (col[0] * k, col[1] * k, col[2] * k, 1.0)

def mix(a, b, t):
    return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, 1.0)

def scale(c, k):
    return (c[0] * k, c[1] * k, c[2] * k, 1.0)

# --- buckets: one bmesh per output object --------------------------------------
class Bucket:
    def __init__(self, name, mat, pivot=(0, 0, 0)):
        self.name, self.mat, self.pivot = name, mat, Vector(pivot)
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new("Col")

BUCKETS = {}

def bucket(name, mat="M_Paint", pivot=(0, 0, 0)):
    """Get/create an output node. pivot (screen space) = the node origin, the
    point A_* nodes rotate about."""
    if name not in BUCKETS:
        BUCKETS[name] = Bucket(name, mat, pivot)
    return BUCKETS[name]

CUR = [None]

class into:
    """with into(bucket): ... routes primitives to another output node."""
    def __init__(self, b): self.b = b
    def __enter__(self): self.prev = CUR[0]; CUR[0] = self.b
    def __exit__(self, *a): CUR[0] = self.prev

def paint():
    return bucket("S_Paint")

def glow():
    return bucket("S_Glow", "M_Glow")

def water():
    return bucket("S_Water", "M_Water")

def foliage():
    return bucket("S_Foliage", "M_Foliage")

def sky():
    return bucket("S_Sky", "M_Sky")

def shaft():
    return bucket("S_Shaft", "M_Shaft")

def to_b(p, b):  # screen point -> bucket-local Blender point
    return Vector((-(p[0] - b.pivot[0]), p[1] - b.pivot[1], p[2] - b.pivot[2]))

# --- primitives (all points in SCREEN space) ---------------------------------------
def face(pts, col, b=None):
    """pts CCW seen from outside (screen space); the x mirror flips winding back.
    If a face shows inside-out in a preview, reverse its points."""
    b = b or CUR[0]
    vs = [b.bm.verts.new(to_b(p, b)) for p in reversed(pts)]
    f = b.bm.faces.new(vs)
    cols = col if isinstance(col, list) else None
    for i, l in enumerate(f.loops):
        l[b.col] = cols[len(cols) - 1 - i] if cols else col
    return f

def grid(o, du, dv, nu, nv, colf, b=None):
    """Quad grid from corner o along du, dv (du x dv = outward). Shared verts.
    colf: colour or f(i, j) -> colour."""
    b = b or CUR[0]
    o, du, dv = Vector(o), Vector(du), Vector(dv)
    vs = [[b.bm.verts.new(to_b(o + du * (i / nu) + dv * (j / nv), b)) for j in range(nv + 1)]
          for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            f = b.bm.faces.new((vs[i][j], vs[i][j + 1], vs[i + 1][j + 1], vs[i + 1][j]))
            c = colf(i, j) if callable(colf) else colf
            for l in f.loops:
                l[b.col] = c

def wall(x0, z0, w, h, y, nu, nv, col):
    """Vertical grid on plane y facing +y (the camera): x0..x0+w, z0..z0+h."""
    grid((x0, y, z0), (0, 0, h), (w, 0, 0), nv, nu, col)

def wall_x(x, y0, z0, d, h, nu, nv, col, facing=1):
    """Vertical grid on plane x, running y0..y0+d, facing +x (facing=1) or -x.
    Side walls of a street / hall: the left row faces +x, the right row -x."""
    if facing > 0:
        grid((x, y0 + d, z0), (0, 0, h), (0, -d, 0), nv, nu, col)
    else:
        grid((x, y0, z0), (0, 0, h), (0, d, 0), nv, nu, col)

def floor(x0, x1, y0, y1, z, nu, nv, colf):
    """Horizontal grid facing up. colf(i, j) or colour."""
    grid((x0, y0, z), (x1 - x0, 0, 0), (0, y1 - y0, 0), nu, nv, colf)

def ceiling(x0, x1, y0, y1, z, nu, nv, colf):
    """Horizontal grid facing down."""
    grid((x0, y0, z), (0, y1 - y0, 0), (x1 - x0, 0, 0), nv, nu, colf)

def rotm(rot):
    return Euler(rot, "XYZ").to_matrix() if rot else Matrix.Identity(3)

def box(c, size, col, rot=None, cell=None, skip=("-z",), colf=None):
    """Box centred at c (screen), size (w, d, h). cell: subdivide faces (better
    AO). skip: faces never seen. colf(face_key) -> colour per face."""
    R = rotm(rot)
    c = Vector(c)
    hx, hy, hz = size[0] / 2, size[1] / 2, size[2] / 2
    def n(l): return max(1, int(math.ceil(l / cell))) if cell else 1
    F = {
        "+x": ((hx, -hy, -hz), (0, 2 * hy, 0), (0, 0, 2 * hz)),
        "-x": ((-hx, hy, -hz), (0, -2 * hy, 0), (0, 0, 2 * hz)),
        "+y": ((hx, hy, -hz), (-2 * hx, 0, 0), (0, 0, 2 * hz)),
        "-y": ((-hx, -hy, -hz), (2 * hx, 0, 0), (0, 0, 2 * hz)),
        "+z": ((-hx, -hy, hz), (2 * hx, 0, 0), (0, 2 * hy, 0)),
        "-z": ((-hx, hy, -hz), (2 * hx, 0, 0), (0, -2 * hy, 0)),
    }
    for k, (o, du, dv) in F.items():
        if k in skip:
            continue
        du_v, dv_v = R @ Vector(du), R @ Vector(dv)
        cc = colf(k) if colf else col
        grid(c + R @ Vector(o), du_v, dv_v, n(du_v.length), n(dv_v.length), cc)

def cyl(c, r, h, segs, col, rot=None, r2=None, caps=(False, True), top_col=None):
    """Cylinder / frustum along local z from base centre c. r2 = top radius."""
    R = rotm(rot)
    c = Vector(c)
    r2 = r if r2 is None else r2
    ring = [(math.cos(2 * math.pi * i / segs), math.sin(2 * math.pi * i / segs)) for i in range(segs)]
    bot = [c + R @ Vector((x * r, y * r, 0)) for x, y in ring]
    top = [c + R @ Vector((x * r2, y * r2, h)) for x, y in ring]
    for i in range(segs):
        j = (i + 1) % segs
        face((bot[i], bot[j], top[j], top[i]), col)
    if caps[0]:
        face(list(reversed(bot)), col)
    if caps[1] and r2 > 1e-4:
        face(top, top_col or col)

def cone(c, r, h, segs, col, rot=None, tip_col=None):
    """Cone from base centre c up local z (pines, spires)."""
    R = rotm(rot)
    c = Vector(c)
    tip = c + R @ Vector((0, 0, h))
    ring = [c + R @ Vector((math.cos(2 * math.pi * i / segs) * r, math.sin(2 * math.pi * i / segs) * r, 0))
            for i in range(segs)]
    for i in range(segs):
        j = (i + 1) % segs
        face((ring[i], ring[j], tip), [col, col, tip_col or col])

def blob(c, r, col, sub=1, squash=1.0, lump=0.18, col_top=None, flat_bottom=True):
    """Lumpy icosphere (foliage, bushes, boulders). col_top tints the upper half.
    sub=1 is the plain icosahedron (20 faces), sub=2 has 80."""
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=sub, radius=1.0)
    c = Vector(c)
    pts = {}
    for v in bm.verts:
        k = 1 + (rng.random() * 2 - 1) * lump
        p = Vector((v.co.x * r * k, v.co.y * r * k, v.co.z * r * k * squash))
        if flat_bottom and p.z < -r * squash * 0.55:
            p.z = -r * squash * 0.55
        pts[v.index] = c + p
    for f in bm.faces:
        ps = [pts[v.index] for v in f.verts]
        zc = sum(p.z for p in ps) / len(ps) - c.z
        cc = jit(col, 0.08)
        if col_top is not None and zc > 0:
            cc = jit(mix(col, col_top, min(1, zc / (r * squash))), 0.06)
        face(ps, cc)  # bmesh order is CCW-outward in these (screen) coords
    bm.free()

def rock(c, s, col, segs=6, h=0.75):
    """Low-poly boulder (jittered ring + cap)."""
    c = Vector(c)
    ring = []
    for i in range(segs):
        a = 2 * math.pi * i / segs + rng.random() * 0.4
        rr = s * (0.8 + rng.random() * 0.4)
        ring.append(c + Vector((math.cos(a) * rr, math.sin(a) * rr * 0.85, s * h * 0.45)))
    top = c + Vector((rng.uniform(-0.2, 0.2) * s, rng.uniform(-0.1, 0.1) * s, s * h * (0.85 + rng.random() * 0.3)))
    base = [Vector((p.x, p.y, c.z)) + (Vector((p.x, p.y, 0)) - Vector((c.x, c.y, 0))) * 0.12 for p in ring]
    for i in range(segs):
        j = (i + 1) % segs
        face((ring[i], ring[j], top), jit(col, 0.08))
        face((base[i], base[j], ring[j], ring[i]), jit(scale(col, 0.85), 0.08))

def wire(a, b, sag, thick, col, segs=8):
    """Sagging cable a -> b (catenary-ish parabola), a thin camera-facing ribbon
    plus a horizontal one so it reads from any angle."""
    a, b = Vector(a), Vector(b)
    pts = []
    for i in range(segs + 1):
        t = i / segs
        p = a.lerp(b, t)
        p.z -= sag * 4 * t * (1 - t)
        pts.append(p)
    d = (b - a)
    side = Vector((-d.y, d.x, 0)).normalized() if d.xy.length > 1e-6 else Vector((1, 0, 0))
    up = Vector((0, 0, 1))
    for i in range(segs):
        p, q = pts[i], pts[i + 1]
        # Vertical ribbon, both sides. The twins sit 4mm apart: coincident
        # verts would be welded by assemble()'s remove_doubles and one face
        # of the pair dropped.
        n = (q - p).cross(up)
        n = n.normalized() * 0.002 if n.length > 1e-9 else Vector((0, 0, 0))
        face((p - up * thick / 2 + n, q - up * thick / 2 + n, q + up * thick / 2 + n, p + up * thick / 2 + n), col)
        face((p + up * thick / 2 - n, q + up * thick / 2 - n, q - up * thick / 2 - n, p - up * thick / 2 - n), col)
        face((p - side * thick / 2, p + side * thick / 2, q + side * thick / 2, q - side * thick / 2), col)  # faces down

# --- text -> flat glyph geometry ----------------------------------------------------
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
_font = [None]

def font():
    if _font[0] is None:
        try:
            _font[0] = bpy.data.fonts.load(FONT_PATH, check_existing=True)
        except Exception:
            _font[0] = bpy.data.fonts.get("Bfont Regular") or bpy.data.fonts[0]
    return _font[0]

def text(s, cx, y, cz, height, col, max_w=None, res=2, spacing=1.0):
    """Flat text on the plane y facing +y (the camera), centred at (cx, cz)."""
    cu = bpy.data.curves.new("tmp_txt", "FONT")
    cu.body, cu.font, cu.size, cu.resolution_u = s, font(), 1.0, res
    cu.space_character = spacing
    cu.align_x, cu.align_y = "CENTER", "CENTER"
    ob = bpy.data.objects.new("tmp_txt", cu)
    bpy.context.scene.collection.objects.link(ob)
    dg = bpy.context.evaluated_depsgraph_get()
    me = ob.evaluated_get(dg).to_mesh()
    vs = [v.co.copy() for v in me.vertices]
    polys = [list(p.vertices) for p in me.polygons]
    ob.evaluated_get(dg).to_mesh_clear()
    bpy.data.objects.remove(ob)
    bpy.data.curves.remove(cu)
    if not vs:
        return
    minx, maxx = min(v.x for v in vs), max(v.x for v in vs)
    miny, maxy = min(v.y for v in vs), max(v.y for v in vs)
    k = height / max(1e-6, (maxy - miny))
    if max_w and (maxx - minx) * k > max_w:
        k = max_w / (maxx - minx)
    mx, my = (minx + maxx) / 2, (miny + maxy) / 2
    for poly in polys:
        pts = [Vector((cx + (vs[i].x - mx) * k, y, cz + (vs[i].y - my) * k)) for i in poly]
        face(list(reversed(pts)), col)

# --- assemble / materials ---------------------------------------------------------------
def material(name):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    nt.nodes.clear()
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bs = nt.nodes.new("ShaderNodeBsdfPrincipled")
    ca = nt.nodes.new("ShaderNodeVertexColor")
    ca.layer_name = "Col"
    nt.links.new(ca.outputs["Color"], bs.inputs["Base Color"])
    bs.inputs["Roughness"].default_value = 1.0
    bs.inputs["Metallic"].default_value = 0.0
    if name in ("M_Glow", "M_Water", "M_Sky", "M_Shaft"):
        nt.links.new(ca.outputs["Color"], bs.inputs["Emission Color"])
        bs.inputs["Emission Strength"].default_value = 0.6 if name == "M_Glow" else 0.2
    nt.links.new(bs.outputs["BSDF"], out.inputs["Surface"])
    return m

def assemble(coll):
    objs = []
    for b in BUCKETS.values():
        if not b.bm.faces:
            b.bm.free()
            continue
        bmesh.ops.remove_doubles(b.bm, verts=b.bm.verts, dist=1e-5)
        me = bpy.data.meshes.new(b.name)
        b.bm.to_mesh(me)
        b.bm.free()
        me.materials.append(material(b.mat))
        ca = me.color_attributes.get("Col")
        me.color_attributes.active_color = ca
        me.color_attributes.render_color_index = me.color_attributes.find("Col")
        ob = bpy.data.objects.new(b.name, me)
        ob.location = Vector((-b.pivot[0], b.pivot[1], b.pivot[2]))
        coll.objects.link(ob)
        objs.append(ob)
    return objs

def tris(objs):
    return sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)

# --- bake: AO + sun shadow into the vertex colours -----------------------------------------
SUN_FROM = Vector((-0.513, -0.281, 0.811))   # game dir light (6,10,4) in Blender coords

def sun_shadow(objs, sun_from, rays=7, spread=math.radians(3), max_d=80.0):
    """Cast-shadow factor per face corner (1 lit, 0 shadowed), ray-cast toward
    the sun through a BVH of the whole set (the Cycles SHADOW bake is unbounded:
    never use it). Faces turned away stay 1: the game's Lambert darkens them."""
    from mathutils.bvhtree import BVHTree
    verts, polys = [], []
    for o in objs:
        mw, base = o.matrix_world, len(verts)
        verts.extend(mw @ v.co for v in o.data.vertices)
        polys.extend([base + i for i in p.vertices] for p in o.data.polygons)
    tree = BVHTree.FromPolygons(verts, polys)
    L = Vector(sun_from).normalized()
    t1 = L.orthogonal().normalized()
    t2 = L.cross(t1)
    k = math.tan(spread)
    dirs = [L] + [(L + (t1 * math.cos(a) + t2 * math.sin(a)) * k).normalized()
                  for a in (2 * math.pi * i / (rays - 1) for i in range(rays - 1))]
    out = {}
    for o in objs:
        me, mw = o.data, o.matrix_world
        nm = mw.to_3x3()
        res = [1.0] * len(me.loops)
        for p in me.polygons:
            n = (nm @ p.normal).normalized()
            if n.dot(L) <= 0.02:
                continue
            ctr = mw @ p.center
            for li in p.loop_indices:
                pt = mw @ me.vertices[me.loops[li].vertex_index].co
                org = pt.lerp(ctr, 0.04) + n * 0.004
                hit = sum(1 for d in dirs if tree.ray_cast(org, d, max_d)[0] is not None)
                res[li] = 1.0 - hit / len(dirs)
        out[o.name] = res
    return out

def bake(objs, sun_from=SUN_FROM, ao_distance=1.6, k_ao=0.7, k_sh=0.42, sun=True, ground=True,
         samples=48, glow_k=(0.25, 0.0)):
    """Multiply Cycles AO (and the ray-cast sun shadow when sun=True) into Col.
    ground=True adds a temporary z=0 plane as an AO occluder (outdoor sets)."""
    sc = bpy.context.scene
    prev_engine = sc.render.engine
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = samples
    sc.cycles.seed = 0
    sc.render.bake.target = "VERTEX_COLORS"
    sc.render.bake.margin = 0
    if not sc.world:
        sc.world = bpy.data.worlds.new("World")
    sc.world.light_settings.distance = ao_distance
    helpers = []
    if ground:
        gme = bpy.data.meshes.new("BakeGround")
        gbm = bmesh.new()
        bmesh.ops.create_grid(gbm, x_segments=1, y_segments=1, size=80)
        gbm.to_mesh(gme)
        gbm.free()
        g = bpy.data.objects.new("BakeGround", gme)
        g.location.z = -0.002
        sc.collection.objects.link(g)
        helpers.append(g)
    # S_Sky / S_Shaft are unlit at runtime: keep their authored colour and
    # keep the window panes + beam sheets from occluding the AO.
    unlit = [o for o in objs if o.name in ("S_Sky", "S_Shaft")]
    lit = [o for o in objs if o not in unlit]
    for o in unlit:
        o.hide_render = True
    bpy.ops.object.select_all(action="DESELECT")
    for o in lit:
        if o.data.color_attributes.get("AO"):
            o.data.color_attributes.remove(o.data.color_attributes["AO"])
        o.data.color_attributes.new("AO", "FLOAT_COLOR", "CORNER")
        o.data.color_attributes.active_color = o.data.color_attributes["AO"]
        o.select_set(True)
    bpy.context.view_layer.objects.active = lit[0]
    bpy.ops.object.bake(type="AO")
    shadow = sun_shadow(lit, sun_from) if sun else {}
    for o in lit:
        me = o.data
        col, ao = me.color_attributes["Col"].data, me.color_attributes["AO"].data
        sh = shadow.get(o.name)
        ka, ks = glow_k if o.name in ("S_Glow", "S_Water") else (k_ao, k_sh)
        for i in range(len(col)):
            a = min(1.0, max(0.0, ao[i].color[0]))
            m = (1 - ka * (1 - a)) * ((1 - ks * (1 - sh[i])) if sh else 1.0)
            c = col[i].color
            col[i].color = (min(1.0, c[0] * m), min(1.0, c[1] * m), min(1.0, c[2] * m), 1.0)
        me.color_attributes.remove(me.color_attributes["AO"])
        me.color_attributes.active_color = me.color_attributes["Col"]
    for o in unlit:
        o.hide_render = False
        o.data.color_attributes.active_color = o.data.color_attributes["Col"]
    for h in helpers:
        data = h.data
        bpy.data.objects.remove(h, do_unlink=True)
        bpy.data.meshes.remove(data)
    sc.render.engine = prev_engine

# --- look-dev: the in-game camera + hell tint preview ------------------------------------------
def duel_gap(d):
    return math.sqrt(d * d + 36.0)

def game_camera(d=15.0):
    """Perspective camera exactly where the game puts it for duel distance d."""
    cam = bpy.data.objects.get("GameCam")
    if not cam:
        cam = bpy.data.objects.new("GameCam", bpy.data.cameras.new("GameCam"))
        bpy.context.scene.collection.objects.link(cam)
    cam.data.type = "PERSP"
    cam.data.sensor_fit = "VERTICAL"
    cam.data.angle_y = math.radians(40)
    cam.data.clip_start, cam.data.clip_end = 0.1, 400
    py = 9.5 + duel_gap(d)
    cam.location = Vector((-1.25, py + 3.1, 2.05))          # screen x mirrored
    look = Vector((1.5, 9.5, 1.0))
    cam.rotation_euler = (look - cam.location).to_track_quat("-Z", "Y").to_euler()
    sc = bpy.context.scene
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = 960, 540
    return cam

# Same ramp as src/render/setGlb.ts HELL_TINT (linear colours): luma -> very
# dark brown -> blood red -> ember. Keep the two in sync.
HELL_DARK = (0.035, 0.013, 0.008)
HELL_MID = (0.26, 0.055, 0.025)
HELL_HOT = (0.85, 0.32, 0.08)
HELL_KEEP = 0.15          # share of the original colour kept

def _smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)

def hell_tint(c):
    l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
    r = mix(HELL_DARK, HELL_MID, _smooth(0.0, 0.22, l))
    r = mix(r, HELL_HOT, _smooth(0.3, 0.85, l))
    return mix(r, c, HELL_KEEP)

def preview(prefix, objs, sky=(0.55, 0.7, 0.85), dists=(6, 15, 25), hell=True):
    """Workbench renders (vertex colours, studio light) from the game camera.
    Writes <prefix>_d6.png ... and <prefix>_hell_d15.png. Two characters-sized
    markers stand at the duel spots so scale reads."""
    sc = bpy.context.scene
    sc.render.engine = "BLENDER_WORKBENCH"
    sh = sc.display.shading
    sh.light = "STUDIO"
    sh.color_type = "VERTEX"
    sh.show_shadows = False
    sh.show_cavity = False
    sh.show_backface_culling = True   # the game renders FrontSide only
    if not sc.world:
        sc.world = bpy.data.worlds.new("World")
    sc.world.color = sky
    sc.view_settings.view_transform = "Standard"
    # S_Shaft is additive + transparent in game: Workbench would draw it as
    # opaque slabs, so previews leave it out.
    for o in objs:
        if o.name == "S_Shaft":
            o.hide_render = True
    marks = []
    for (y, col) in ((9.5, (0.5, 0.1, 0.1, 1)), (None, (0.1, 0.2, 0.5, 1))):
        me = bpy.data.meshes.new("Mark")
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=8, radius1=0.25, radius2=0.2, depth=1.8)
        bm.to_mesh(me)
        bm.free()
        ca = me.color_attributes.new("Col", "FLOAT_COLOR", "CORNER")
        for d_ in ca.data:
            d_.color = col
        ob = bpy.data.objects.new("Mark", me)
        ob.location = (0, y or 0, 0.9)
        sc.collection.objects.link(ob)
        marks.append(ob)
    outs = []
    for d in dists:
        marks[1].location.y = 9.5 + duel_gap(d)
        game_camera(d)
        sc.render.filepath = f"{prefix}_d{d}.png"
        bpy.ops.render.render(write_still=True)
        outs.append(sc.render.filepath)
    if hell:
        saved = {}
        for o in objs:
            ca = o.data.color_attributes["Col"].data
            saved[o.name] = [tuple(x.color) for x in ca]
            for x in ca:
                x.color = hell_tint(x.color) if o.name != "S_Glow" else (1.0, 0.25, 0.05, 1.0)
        sc.world.color = (0.12, 0.02, 0.01)
        marks[1].location.y = 9.5 + duel_gap(15)
        game_camera(15)
        sc.render.filepath = f"{prefix}_hell_d15.png"
        bpy.ops.render.render(write_still=True)
        outs.append(sc.render.filepath)
        for o in objs:
            ca = o.data.color_attributes["Col"].data
            for x, c in zip(ca, saved[o.name]):
                x.color = c
    for o in objs:
        o.hide_render = False
    for m in marks:
        me = m.data
        bpy.data.objects.remove(m, do_unlink=True)
        bpy.data.meshes.remove(me)
    print("PREVIEW", outs)
    return outs

# --- driver ---------------------------------------------------------------------------------
def run(set_name, build_fn, coll_name, default_out, bake_kw=None, sky=(0.55, 0.7, 0.85)):
    """Build -> assemble -> bake -> preview -> export. set_name: env prefix
    (e.g. "SALOON" -> SALOON_OUT / SALOON_BAKE / SALOON_EXPORT / SALOON_PREVIEW)."""
    E = lambda k, d=None: os.environ.get(f"{set_name}_{k}", d)
    out = E("OUT") or os.path.normpath(os.path.join(HERE, "..", "..", "public", "models", default_out))
    # --factory-startup ships a cube at the origin (= right behind the foe):
    # it would print into the AO bake and the previews.
    for n in ("Cube", "Light", "Camera"):
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)
    BUCKETS.clear()
    coll = reset_collection(coll_name)
    CUR[0] = paint()
    build_fn()
    objs = assemble(coll)
    print(set_name, "objects:", sorted(o.name for o in objs), "tris:", tris(objs))
    if E("BAKE", "1") != "0":
        bake(objs, **(bake_kw or {}))
    if E("PREVIEW"):
        preview(E("PREVIEW"), objs, sky=sky)
    if E("EXPORT", "1") != "0":
        os.makedirs(os.path.dirname(out), exist_ok=True)
        bpy.ops.object.select_all(action="DESELECT")
        export(coll, out)
        slim_glb(out)
        print("EXPORTED", out, os.path.getsize(out) // 1024, "KB")
    return objs
