"""Deterministic street-set build: code -> public/models/street.glb.

    npm run build:street   # = blender -b --factory-startup --python this

Never opens or saves blender/cowboys.blend. Everything is generated here, so
the GLB is reproducible from this file alone. Live iteration: exec this file
through the addon socket (127.0.0.1:9876); it rebuilds only the `Street`
collection (+ a `GameCam` matching the in-game camera) and leaves the rest of
the open scene alone.

WHY IT LOOKS LIKE THIS: the in-game camera is a tight, ~5 deg pitched ortho
over-the-shoulder lens. At every 16:9 size it only sees a ~12.5m x 3.6m strip
of the facades (ground-floor storefronts, up to the porch roofs) and the
ground in front. Sky can never show. So the detail budget goes into vertical,
camera-facing surfaces below ~3.6m: siding, windows, doors, fascia signs,
props, a horse. Horizontal surfaces read ~10x compressed and get little.
Rooflines/upper floors exist only for tall aspects.

COORDS: authored in SCREEN space -- sx = screen right, y = toward the duel
(the camera looks down -y), z = up. Facades sit near y=0, the foe stands at
(0, 9.5, 0) (projects onto the facade around sx 0.2..1.2, z < 1.2: keep that
calm and light). Converted to Blender by negating x (the loader's inner yaw
of PI turns Blender +Y fronts toward the duel and mirrors x back).

OUTPUT NODES: `S_Paint` (all static vertex-coloured geometry, one draw call),
`S_Glow` (window glass / lanterns; the game drives its emissive by time of
day), and `A_*` pivoted parts the game animates by name (streetGlb.ts).
Colour = palette * baked AO * baked sun shadow, all in COLOR_0.

Env: STREET_OUT=<glb path>, STREET_BAKE=0 (skip the Cycles bake for fast
layout passes), STREET_EXPORT=0 (build only).
"""
import bpy, bmesh, math, os, random
from mathutils import Vector, Matrix, Euler

BAKE = os.environ.get("STREET_BAKE", "1") != "0"
EXPORT = os.environ.get("STREET_EXPORT", "1") != "0"
HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
OUT = os.environ.get("STREET_OUT") or os.path.normpath(
    os.path.join(HERE, "..", "..", "public", "models", "street.glb"))
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf"
rng = random.Random(1873)

# --- palette (sRGB hex -> linear) ---------------------------------------------
def lin(h):
    def c(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255), 1.0)

def jit(col, amt, r=rng):
    k = 1.0 + (r.random() * 2 - 1) * amt
    return (col[0] * k, col[1] * k, col[2] * k, 1.0)

P = {k: lin(v) for k, v in dict(
    ground=0xd9b380, dirt=0xc9a06e,
    honey=0x8a5530, honey_dk=0x5e3a20, wood_gray=0x8e8473, wood_bleach=0xb3a48a,
    wood_dk=0x4a3220, wood_mid=0x75522f, plank=0x9b8164, post=0x6a4a2c,
    green=0x2f6a52, green_dk=0x1f4a3a, cream=0xf3e6c4, gold=0xe0aa38,
    store=0xe8dcc0, store_up=0x56707f, store_trim=0x47708f, awn_red=0xb5372b, awn_white=0xf4ecdc,
    stone=0xb39a7a, stone_dk=0x4c4034, brick=0xa04a34, brick_mortar=0x6f5d4e,
    trim_white=0xeee6d2, shutter=0x3f6b4a, barn=0x93352a, barn_trim=0xe6dcc6,
    glass=0x26303c, curtain=0x8e2430, interior=0x2a1c14, iron=0x2b2a2c,
    brass=0xc59a3c, paper=0xe9d7a8, ink=0x3a2a1c,
    horse=0x8a4a26, horse_dk=0x5a2e16, mane=0x241612, hoof=0x2a221c, blaze=0xf0e8da,
    saddle=0x5e3018, blanket=0xa02c28, blanket_b=0xe2c070,
    cactus=0x5f8a3e, cactus_dk=0x46682e, pot=0xb8683e, hay=0xdcb85c, grass=0xb9a352,
    grass_g=0x8c9a44, rock=0x9a8a76, rock_dk=0x7a6a58, apple=0xc0302a, sack=0xd2bd8e,
    shirt_b=0x4a78a8, shirt_r=0xc04a3a, shirt_w=0xeee8dc, cat=0x2a2622, cat_eye=0xe8d040,
    glow=0xffc070, lamp_glass=0xffd890, bunt_r=0xc23a2e, bunt_w=0xf2ece0, bunt_b=0x3a5a9a,
).items()}

# --- buckets: one bmesh per output object ---------------------------------------
class Bucket:
    def __init__(self, name, mat, pivot=(0, 0, 0)):
        self.name, self.mat, self.pivot = name, mat, Vector(pivot)
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new("Col")

BUCKETS = {}
def bucket(name, mat="M_Paint", pivot=(0, 0, 0)):
    if name not in BUCKETS:
        BUCKETS[name] = Bucket(name, mat, pivot)
    return BUCKETS[name]

CUR = [None]  # current target bucket (static paint by default)
class into:
    """with into(bucket): ... -- route primitives to another bucket."""
    def __init__(self, b): self.b = b
    def __enter__(self): self.prev = CUR[0]; CUR[0] = self.b
    def __exit__(self, *a): CUR[0] = self.prev

def to_b(p, b):  # screen point -> bucket-local blender point
    return Vector((-(p[0] - b.pivot[0]), p[1] - b.pivot[1], p[2] - b.pivot[2]))

def face(pts, col, smooth=False, b=None):
    """pts: CCW (outward) in SCREEN space. Mirror flips winding back."""
    b = b or CUR[0]
    vs = [b.bm.verts.new(to_b(p, b)) for p in reversed(pts)]
    f = b.bm.faces.new(vs)
    f.smooth = smooth
    for l in f.loops:
        l[b.col] = col
    return f

def grid(o, du, dv, nu, nv, colf, b=None):
    """Quad grid from corner o along du, dv (du x dv = outward). Shared verts."""
    b = b or CUR[0]
    o, du, dv = Vector(o), Vector(du), Vector(dv)
    vs = [[b.bm.verts.new(to_b(o + du * (i / nu) + dv * (j / nv), b)) for j in range(nv + 1)]
          for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            f = b.bm.faces.new((vs[i][j], vs[i][j + 1], vs[i + 1][j + 1], vs[i + 1][j]))  # mirrored winding
            c = colf(i, j) if callable(colf) else colf
            for l in f.loops:
                l[b.col] = c

def wall(x0, z0, w, h, y, nu, nv, col):
    """Vertical grid on the plane y facing +y (the camera): x0..x0+w, z0..z0+h."""
    grid((x0, y, z0), (0, 0, h), (w, 0, 0), nv, nu, col)

def rotm(rot):
    return Euler(rot, "XYZ").to_matrix() if rot else Matrix.Identity(3)

def box(c, size, col, rot=None, cell=None, skip=("-z",), colf=None):
    """Axis box at centre c (screen), size (w,d,h). cell: subdivide faces for AO.
    colf(face_key) -> colour overrides per face."""
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

def cyl(c, r, h, segs, col, rot=None, r2=None, caps=(False, True), smooth=True):
    """Cylinder along local z from c (base centre). r2 = top radius."""
    R = rotm(rot)
    c = Vector(c)
    r2 = r if r2 is None else r2
    ring = [(math.cos(2 * math.pi * i / segs), math.sin(2 * math.pi * i / segs)) for i in range(segs)]
    bot = [c + R @ Vector((x * r, y * r, 0)) for x, y in ring]
    top = [c + R @ Vector((x * r2, y * r2, h)) for x, y in ring]
    for i in range(segs):
        j = (i + 1) % segs
        face((bot[i], bot[j], top[j], top[i]), col, smooth)
    if caps[0]:
        face(list(reversed(bot)), col)
    if caps[1]:
        face(top, col)

def rock(c, s, col, segs=5):
    """Low-poly lumpy rock (squashed, jittered octahedron-ish)."""
    c = Vector(c)
    pts = []
    for i in range(segs):
        a = 2 * math.pi * i / segs + rng.random() * 0.4
        rr = s * (0.8 + rng.random() * 0.4)
        pts.append(c + Vector((math.cos(a) * rr, math.sin(a) * rr * 0.8, s * 0.25)))
    top = c + Vector((rng.uniform(-0.2, 0.2) * s, 0, s * (0.6 + rng.random() * 0.3)))
    base = [c + Vector((p.x - c.x, p.y - c.y, 0)) * 1.1 + Vector((0, 0, 0)) for p in pts]
    for i in range(segs):
        j = (i + 1) % segs
        face((pts[i], pts[j], top), jit(col, 0.08))
        face((base[i], base[j], pts[j], pts[i]), jit(col, 0.08))

# --- text -> flat glyph geometry ----------------------------------------------
_font = [None]
def font():
    if _font[0] is None:
        try:
            _font[0] = bpy.data.fonts.load(FONT_PATH, check_existing=True)
        except Exception:
            _font[0] = bpy.data.fonts.get("Bfont Regular") or bpy.data.fonts[0]
    return _font[0]

def text(s, cx, y, cz, height, col, max_w=None, res=2, spacing=1.0):
    """Flat text facing +y (camera), centred at (cx, cz), cap-height ~height."""
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
        face(list(reversed(pts)), col)  # glyph CCW about +z maps to -y; flip

# --- architectural kit -------------------------------------------------------------
# Facade walls are generated LAST (flush_walls) so every window/door opening
# registered on the same plane is cut out of the siding/blocks behind it.
HOLES = []      # (x0, x1, z0, z1, y)
WALL_JOBS = []

def hole(x0, x1, z0, z1, y):
    HOLES.append((x0, x1, z0, z1, y))

def _holes_on(x0, x1, z0, z1, y):
    return [h for h in HOLES if abs(h[4] - y) < 0.25 and h[0] < x1 and h[1] > x0 and h[2] < z1 and h[3] > z0]

def _spans(x0, x1, cuts):
    """[x0, x1] minus sorted (a, b) cuts -> remaining spans."""
    out, cur = [], x0
    for a, b in sorted(cuts):
        if a > cur:
            out.append((cur, min(a, x1)))
        cur = max(cur, b)
    if cur < x1:
        out.append((cur, x1))
    return [(a, b) for a, b in out if b - a > 1e-4]

def holed_wall(x0, z0, w, h, y, nu, nv, col):
    """wall() minus registered openings: split at hole z-edges, subtract x-ranges."""
    hs = _holes_on(x0, x0 + w, z0, z0 + h, y)
    if not hs:
        wall(x0, z0, w, h, y, nu, nv, col)
        return
    zs = sorted({z0, z0 + h} | {min(max(v, z0), z0 + h) for hh in hs for v in (hh[2], hh[3])})
    for za, zb in zip(zs, zs[1:]):
        if zb - za < 1e-4:
            continue
        zm = (za + zb) / 2
        for a, b in _spans(x0, x0 + w, [(hh[0], hh[1]) for hh in hs if hh[2] < zm < hh[3]]):
            wall(a, za, b - a, zb - za, y, max(1, round(nu * (b - a) / w)), max(1, round(nv * (zb - za) / h)), col)

def flush_walls():
    while WALL_JOBS:
        WALL_JOBS.pop(0)()

def siding(x0, x1, z0, z1, y, col, board=0.2, amt=0.07, colw=0.6):
    """Clapboard wall facing +y: board rows with a thin dark lap-shadow strip."""
    rows = max(1, int(round((z1 - z0) / board)))
    bh = (z1 - z0) / rows
    nu = max(1, int(math.ceil((x1 - x0) / colw)))
    lap = min(0.035, bh * 0.2)
    cols = [jit(col, amt) for _ in range(rows)]
    def job():
        for r in range(rows):
            zb = z0 + r * bh
            c = cols[r]
            sh = (c[0] * 0.55, c[1] * 0.55, c[2] * 0.55, 1)
            holed_wall(x0, zb + lap, x1 - x0, bh - lap, y, nu, 1, c)
            holed_wall(x0, zb, x1 - x0, lap, y + 0.004, nu, 1, sh)
    WALL_JOBS.append(job)

def battens(x0, x1, z0, z1, y, col, gap=0.32, amt=0.06):
    """Board-and-batten: vertical boards (jittered) + proud battens."""
    n = max(1, int(round((x1 - x0) / gap)))
    w = (x1 - x0) / n
    nv = max(1, int(math.ceil((z1 - z0) / 0.6)))
    cols = [jit(col, amt) for _ in range(n)]
    def job():
        for i in range(n):
            holed_wall(x0 + i * w, z0, w, z1 - z0, y, 1, nv, cols[i])
            if i:
                xb = x0 + i * w
                for za, zb in _spans(z0, z1, [(hh[2], hh[3]) for hh in _holes_on(xb - 0.03, xb + 0.03, z0, z1, y)]):
                    box((xb, y + 0.02, (za + zb) / 2), (0.06, 0.04, zb - za), jit(col, amt * 0.5),
                        skip=("-z", "-y", "+z"))
    WALL_JOBS.append(job)

def blocks(x0, x1, z0, z1, y, col, mortar, bw=0.46, bh=0.26, gapw=0.025, amt=0.1, proud=0.015):
    """Stone/brick: backing in mortar colour + separate proud block quads."""
    def job():
        holed_wall(x0, z0, x1 - x0, z1 - z0, y, max(1, int((x1 - x0) / 0.8)),
                   max(1, int((z1 - z0) / 0.8)), mortar)
        rows = int(round((z1 - z0) / bh))
        rh = (z1 - z0) / rows
        for r in range(rows):
            za, zb = z0 + r * rh + gapw / 2, z0 + (r + 1) * rh - gapw / 2
            cuts = [(hh[0], hh[1]) for hh in _holes_on(x0, x1, za, zb, y)]
            x = x0 - ((bw / 2) if r % 2 else 0)
            while x < x1:
                for a, b2 in _spans(max(x, x0), min(x + bw, x1), cuts):
                    if b2 - a > 0.05:
                        face(((a + gapw / 2, y + proud, za), (b2 - gapw / 2, y + proud, za),
                              (b2 - gapw / 2, y + proud, zb), (a + gapw / 2, y + proud, zb)), jit(col, amt))
                x += bw * (0.85 + rng.random() * 0.3) if r % 3 == 2 else bw
    WALL_JOBS.append(job)

def window(cx, z0, w, h, y, frame, panes=(2, 2), curtain=None, shutters=None, glow=True,
           goods=False, bars=False):
    """Framed sash window on the wall plane y. Glass goes to S_Glow."""
    hole(cx - w / 2, cx + w / 2, z0, z0 + h, y)
    t = 0.08
    box((cx, y + 0.05, z0 - 0.05), (w + 0.26, 0.16, 0.08), frame)                  # sill
    box((cx, y + 0.04, z0 + h + 0.07), (w + 0.3, 0.1, 0.14), frame)                # header
    box((cx, y + 0.07, z0 + h + 0.16), (w + 0.38, 0.14, 0.04), frame)              # cornice lip
    for s in (-1, 1):
        box((cx + s * (w / 2 + t / 2), y + 0.035, z0 + h / 2), (t, 0.07, h), frame, skip=("-z", "-y"))
    gy = y - 0.04
    with into(bucket("S_Glow", "M_Glow")):
        wall(cx - w / 2, z0, w, h, gy, 1, 1, P["glass"])
    # interior hints in front of the glass (glass is opaque; reads as behind it)
    if curtain:
        for s in (-1, 1):
            face(((cx + s * w / 2 - (0 if s > 0 else -w * 0.28), gy + 0.01, z0 + 0.02),
                  (cx + s * w / 2 + (-w * 0.28 if s > 0 else 0), gy + 0.01, z0 + 0.02),
                  (cx + s * (w / 2 - w * 0.18), gy + 0.01, z0 + h),
                  (cx + s * w / 2, gy + 0.01, z0 + h)) if s > 0 else
                 ((cx - w / 2, gy + 0.01, z0 + h), (cx - w / 2 + w * 0.18, gy + 0.01, z0 + h),
                  (cx - w / 2 + w * 0.28, gy + 0.01, z0 + 0.02), (cx - w / 2, gy + 0.01, z0 + 0.02)), curtain)
        box((cx, gy + 0.02, z0 + h - 0.08), (w, 0.02, 0.16), jit(curtain, 0.1), skip=())  # valance
    if goods:
        for k in range(2):
            zz = z0 + 0.3 + k * h * 0.42
            box((cx, gy + 0.03, zz), (w * 0.96, 0.04, 0.03), P["wood_mid"])
            x = cx - w / 2 + 0.06
            while x < cx + w / 2 - 0.1:
                gw = 0.06 + rng.random() * 0.08
                gh = 0.08 + rng.random() * 0.16
                gc = rng.choice((P["apple"], P["store_trim"], P["gold"], P["shirt_w"], P["green"], P["sack"]))
                box((x + gw / 2, gy + 0.03, zz + 0.015 + gh / 2), (gw, 0.03, gh), jit(gc, 0.15), skip=("-z", "-y"))
                x += gw + 0.02
    nx, nz = panes
    for i in range(1, nx):
        box((cx - w / 2 + w * i / nx, gy + 0.03, z0 + h / 2), (0.04, 0.03, h), frame, skip=("-z", "-y"))
    for j in range(1, nz):
        box((cx, gy + 0.03, z0 + h * j / nz), (w, 0.03, 0.04), frame, skip=("-z", "-y"))
    if bars:
        for i in range(1, 6):
            cyl((cx - w / 2 + w * i / 6, gy + 0.06, z0), 0.018, h, 5, P["iron"], caps=(False, False))
    if shutters:
        for s in (-1, 1):
            sx = cx + s * (w / 2 + 0.1 + w * 0.26)
            box((sx, y + 0.04, z0 + h / 2), (w * 0.5, 0.05, h + 0.04), shutters, skip=("-z", "-y"))
            for k in range(5):
                box((sx, y + 0.075, z0 + 0.12 + k * (h - 0.2) / 4.0), (w * 0.44, 0.015, 0.03),
                    jit(shutters, 0.1), skip=("-z", "-y"))

def door(cx, z0, w, h, y, frame, panel, knob=P["brass"], dark=False):
    hole(cx - w / 2, cx + w / 2, z0, z0 + h, y)
    box((cx, y + 0.04, z0 + h + 0.08), (w + 0.3, 0.08, 0.16), frame)
    for s in (-1, 1):
        box((cx + s * (w / 2 + 0.05), y + 0.03, z0 + h / 2), (0.1, 0.06, h), frame, skip=("-z", "-y"))
    if dark:
        wall(cx - w / 2, z0, w, h, y - 0.12, 1, 2, P["interior"])
        return
    wall(cx - w / 2, z0, w, h, y - 0.03, 1, 3, panel)
    for zz in (0.25, 0.62):
        box((cx, y - 0.01, z0 + h * zz + h * 0.14), (w * 0.7, 0.03, h * 0.28), jit(panel, 0.12),
            skip=("-z", "-y"))
    box((cx + w * 0.36, y + 0.01, z0 + h * 0.48), (0.05, 0.05, 0.05), knob, skip=("-y",))

def boardwalk(x0, x1, depth=2.2, top=0.32, col=None):
    col = col or P["plank"]
    n = int((x1 - x0) / 0.24)
    for i in range(n):  # planks run front-to-back; only tops visible (barely)
        xa = x0 + i * (x1 - x0) / n
        box((xa + (x1 - x0) / n / 2, depth / 2, top - 0.02), ((x1 - x0) / n - 0.015, depth, 0.04),
            jit(col, 0.12), skip=("-z", "-y", "+x", "-x"))
    grid((x0, 0, 0), (x1 - x0, 0, 0), (0, depth, 0), max(1, int((x1 - x0) / 0.6)), 4,
         P["interior"])  # dark under-gap backing at plank level
    box(((x0 + x1) / 2, depth - 0.04, top / 2 - 0.02), (x1 - x0, 0.08, top - 0.04), P["wood_dk"],
        cell=0.5, skip=("-z", "-y"))  # front stringer
    k = x0 + 0.3
    while k < x1:
        box((k, depth - 0.0, 0.11), (0.1, 0.03, 0.22), jit(P["wood_dk"], 0.2), skip=("-z", "-y"))
        k += 1.2 + rng.random() * 0.6

def porch_roof(x0, x1, zf, y0=0.0, depth=2.2, fascia=0.32, fcol=None, rcol=None, post=None,
               sign=None, sign_col=None, posts_at=None):
    """Shed roof wall->front; posts with braces; fascia board carrying a sign."""
    fcol, rcol, post = fcol or P["wood_dk"], rcol or P["wood_gray"], post or P["post"]
    rise = 0.35
    zt = zf + fascia
    # roof slab sloping down toward the street
    L = math.hypot(depth, rise)
    ang = math.atan2(rise, depth)
    box(((x0 + x1) / 2, y0 + depth / 2, zt + rise / 2), (x1 - x0 + 0.2, L, 0.06), rcol,
        rot=(ang, 0, 0), cell=0.8, skip=())
    box(((x0 + x1) / 2, y0 + depth - 0.02, zf + fascia / 2), (x1 - x0 + 0.24, 0.07, fascia), fcol,
        cell=0.6, skip=("-y",))
    box(((x0 + x1) / 2, y0 + depth - 0.07, zf + 0.02), (x1 - x0, 0.12, 0.04), jit(fcol, 0.2))  # drip
    posts_at = posts_at or [x0 + 0.12 + i * (x1 - x0 - 0.24) / max(1, round((x1 - x0) / 2.6))
                            for i in range(int(round((x1 - x0) / 2.6)) + 1)]
    for px in posts_at:
        box((px, y0 + depth - 0.12, 0.32 + (zf - 0.32) / 2), (0.15, 0.15, zf - 0.32), jit(post, 0.08),
            skip=("-z", "-y"))
        box((px, y0 + depth - 0.12, 0.38), (0.21, 0.21, 0.08), jit(post, 0.1), skip=("-z", "-y"))
        for s in (-1, 1):
            if x0 + 0.2 < px + s * 0.35 < x1 - 0.2:
                box((px + s * 0.22, y0 + depth - 0.12, zf - 0.22), (0.5, 0.07, 0.07), post,
                    rot=(0, s * -0.75, 0), skip=("-y",))
    if sign:
        text(sign, (x0 + x1) / 2, y0 + depth + 0.025, zf + fascia / 2, fascia * 0.62, sign_col,
             max_w=(x1 - x0) * 0.8)
    return zt + rise

def false_front(x0, x1, z0, z1, y, col, trim, kind="siding"):
    if kind == "siding":
        siding(x0, x1, z0, z1, y, col)
    box(((x0 + x1) / 2, y + 0.06, z1 + 0.08), (x1 - x0 + 0.3, 0.2, 0.16), trim)
    box(((x0 + x1) / 2, y + 0.09, z1 + 0.22), (x1 - x0 + 0.4, 0.26, 0.12), trim)
    for s in (-1, 1):
        box((x0 if s < 0 else x1, y + 0.03, (z0 + z1) / 2), (0.16, 0.08, z1 - z0), trim,
            skip=("-z", "-y"))

def side_walls(x0, x1, y, h, col, back=6.0):
    """Cheap side/back walls so alley glimpses and tall aspects never see holes."""
    for x, k in ((x0, "-x"), (x1, "+x")):
        box((x, y - back / 2, h / 2), (0.02, back, h), col, skip=("-z", "+z", "-y", "+y",
                                                                  "+x" if k == "-x" else "-x"))
    box(((x0 + x1) / 2, y - back / 2, h + 0.01), (x1 - x0, back, 0.02), P["wood_dk"],
        skip=("-z", "-y", "+x", "-x", "+y"))

def hanging_sign(name, cx, y, z_hook, w, h, board, txt, txt_col, chain=0.28):
    """Board on two chains from a bracket; pivot at the hook (game sways it)."""
    box((cx, y, z_hook + 0.03), (w + 0.4, 0.06, 0.06), P["iron"])
    with into(bucket(name, "M_Paint", (cx, y, z_hook))):
        for s in (-1, 1):
            box((cx + s * w * 0.38, y, z_hook - chain / 2), (0.02, 0.02, chain), P["iron"], skip=())
        zc = z_hook - chain - h / 2
        box((cx, y, zc), (w, 0.05, h), board, skip=())
        box((cx, y + 0.03, zc), (w - 0.08, 0.01, h - 0.08), jit(board, 0.2), skip=("-y",))
        text(txt, cx, y + 0.04, zc, h * 0.45, txt_col, max_w=w * 0.82)

def barrel(c, r=0.3, h=0.85, col=None, hoop=None):
    col, hoop = col or P["wood_mid"], hoop or P["iron"]
    x, y, z = c
    cyl((x, y, z), r * 0.92, h * 0.5, 10, jit(col, 0.1), r2=r)
    cyl((x, y, z + h * 0.5), r, h * 0.5, 10, jit(col, 0.1), r2=r * 0.92)
    for zz in (0.12, 0.5, 0.88):
        rr = r * (0.94 if zz != 0.5 else 1.0) + 0.012
        cyl((x, y, z + h * zz - 0.03), rr, 0.06, 10, hoop, caps=(False, False))

def crate(c, s, col=None, rot=0.0):
    col = col or P["wood_bleach"]
    x, y, z = c
    box((x, y, z + s / 2), (s, s, s), jit(col, 0.1), rot=(0, 0, rot))
    for zz in (0.08, 0.92):
        box((x, y, z + s * zz), (s + 0.02, s + 0.02, s * 0.1), jit(P["wood_mid"], 0.1), rot=(0, 0, rot))
    box((x, y, z + s / 2), (s * 0.1, s + 0.02, s * 1.1), jit(P["wood_mid"], 0.1),
        rot=(0, 0.79, rot), skip=("-z",))

def sack(c, s=0.32, col=None):
    col = col or P["sack"]
    x, y, z = c
    box((x, y, z + s * 0.45), (s, s * 0.8, s * 0.9), jit(col, 0.08), rot=(0, rng.uniform(-0.15, 0.15), 0))
    box((x, y, z + s * 0.98), (s * 0.45, s * 0.4, s * 0.2), jit(col, 0.12))

def tuft(c, s=0.3, col=None):
    col = col or (P["grass"] if rng.random() < 0.65 else P["grass_g"])
    x, y, z = c
    for k in range(6):
        a = rng.uniform(0, math.pi)
        lean = rng.uniform(-0.5, 0.5)
        h = s * rng.uniform(0.6, 1.1)
        w = s * 0.12
        d = Vector((math.cos(a) * w, math.sin(a) * w, 0))
        tip = Vector((x + lean * s * 0.6, y + rng.uniform(-0.1, 0.1), z + h))
        b0, b1 = Vector((x, y, z)) - d, Vector((x, y, z)) + d
        cc = jit(col, 0.15)
        face((b0, b1, tip), cc)
        face((b1, b0, tip), cc)

def prickly(c, s=0.5):
    x, y, z = c
    pads = [((0, 0, 0.28), 0.0, 1.0), ((0.18, 0, 0.6), 0.5, 0.8), ((-0.17, 0, 0.55), -0.45, 0.75),
            ((0.05, 0, 0.88), 0.1, 0.6)]
    for (dx, dy, dz), tilt, k in pads:
        box((x + dx * s / 0.5, y + dy, z + dz * s / 0.5), (0.36 * k * s / 0.5, 0.08, 0.48 * k * s / 0.5),
            jit(P["cactus"], 0.1), rot=(0, tilt, 0), skip=())
    for _ in range(3):
        box((x + rng.uniform(-0.2, 0.2) * s, y + 0.05, z + rng.uniform(0.4, 1.0) * s), (0.06, 0.04, 0.06),
            P["awn_red"], skip=("-y",))

def barrel_cactus(c, r=0.22):
    x, y, z = c
    cyl((x, y, z), r, r * 1.1, 8, jit(P["cactus_dk"], 0.08), r2=r * 0.7)
    cyl((x, y, z + r * 1.1), r * 0.7, r * 0.25, 8, P["cactus"], r2=0.05)
    box((x, y, z + r * 1.38), (0.08, 0.08, 0.05), P["gold"], skip=())

# --- the street -------------------------------------------------------------------
def build():
    paint = bucket("S_Paint")
    CUR[0] = paint

    # Ground band in front of the row (AO/shadow receiver). Edges stay EXACT
    # arena ground colour so it melts into the arena plane; the interior gets
    # a faint tonal noise (tapered to 0 at the border).
    # Runs from the boardwalk to just past the camera (y 24): the whole
    # visible street floor gets the same tone noise + baked contact shadows.
    gx0, gx1, gy0, gy1 = -20.0, 20.0, 1.9, 25.0
    nu, nv = 64, 34
    def gcol(i, j):
        u, v = (i + 0.5) / nu, (j + 0.5) / nv
        edge = min(u, 1 - u, v * 3, 1 - v) * 6
        w = max(0.0, min(1.0, edge))
        n = (math.sin(i * 0.9 + j * 1.7) * 0.5 + math.sin(i * 0.37 - j * 2.3) * 0.5) * 0.05 * w
        g = P["ground"]
        return (g[0] * (1 + n), g[1] * (1 + n), g[2] * (1 + n), 1)
    grid((gx0, gy0, 0.004), (gx1 - gx0, 0, 0), (0, gy1 - gy0, 0), nu, nv, gcol)

    # Boardwalk along the whole row.
    boardwalk(-19.5, 19.5)

    # ===== 1. LIVERY STABLE (far left; wide aspects) ============================
    x0, x1, yf = -19.5, -9.0, -0.3
    battens(x0, x1, 0.32, 5.2, yf, P["barn"])
    for i in range(10):  # gable steps -> stylised barn peak (tall aspects)
        w = (x1 - x0) * (1 - i / 10)
        box(((x0 + x1) / 2, yf + 0.0, 5.2 + i * 0.22 + 0.11), (w, 0.1, 0.22), jit(P["barn"], 0.05),
            skip=("-z", "-y"))
    door_x = x1 - 3.2
    for s in (-1, 1):  # big X-braced doors
        dx = door_x + s * 0.8
        box((dx, yf + 0.04, 1.75), (1.55, 0.06, 2.85), jit(P["barn"], 0.1), skip=("-z", "-y"))
        for zz in (0.42, 1.75, 3.1):
            box((dx, yf + 0.08, zz), (1.55, 0.04, 0.12), P["barn_trim"], skip=("-z", "-y"))
        for s2 in (-1, 1):
            box((dx + s2 * 0.72, yf + 0.08, 1.75), (0.12, 0.04, 2.85), P["barn_trim"], skip=("-z", "-y"))
        box((dx, yf + 0.09, 1.75), (0.1, 0.03, 2.95), P["barn_trim"], rot=(0, s * 0.5, 0), skip=("-z", "-y"))
    box((door_x, yf + 0.06, 3.3), (3.6, 0.1, 0.12), P["barn_trim"])
    box((door_x, yf + 0.06, 4.15), (1.2, 0.08, 0.9), P["wood_dk"])  # hay loft door
    box((door_x, yf + 0.12, 4.7), (0.12, 0.6, 0.12), P["wood_dk"])  # hoist beam
    box((door_x, yf + 0.08, 3.62), (2.6, 0.06, 0.42), P["wood_dk"])
    text("LIVERY", door_x, yf + 0.115, 3.62, 0.26, P["cream"], max_w=2.2)
    window(x0 + 2.0, 1.2, 0.9, 1.0, yf, P["barn_trim"], panes=(2, 2))
    for (hx, hy, hz) in ((x1 - 0.9, 2.9, 0.0), (x1 - 1.75, 2.95, 0.0), (x1 - 1.3, 2.9, 0.42)):
        box((hx, hy, hz + 0.21), (0.8, 0.5, 0.42), jit(P["hay"], 0.08))
        for zz in (0.12, 0.3):
            box((hx, hy + 0.255, hz + zz), (0.8, 0.01, 0.025), P["wood_mid"], skip=("-y",))
    side_walls(x0, x1, yf, 5.2, P["barn"])

    # ===== 2. ALLEY 1 (laundry) =================================================
    ax0, ax1 = -9.0, -7.6
    am = (ax0 + ax1) / 2
    for k in range(6):  # back fence
        box((ax0 + 0.12 + k * 0.25, -4.5, 1.0), (0.22, 0.05, 2.0 + rng.uniform(-0.2, 0.1)),
            jit(P["wood_gray"], 0.12), skip=("-z", "-y"))
    box((am, -4.45, 1.4), (ax1 - ax0, 0.05, 0.1), P["wood_mid"])
    for s in (-1, 1):  # ladder leaning on the fence
        box((am + 0.2 + s * 0.22, -3.9, 1.1), (0.07, 0.06, 2.2), P["wood_mid"], rot=(0.25, 0, 0))
    for k in range(6):
        box((am + 0.2, -3.9 + math.sin(0.25) * (k * 0.35 - 0.85), 0.25 + k * 0.35), (0.45, 0.04, 0.04),
            P["wood_mid"])
    barrel((ax0 + 0.35, -0.6, 0.0), r=0.3, h=0.9, col=P["wood_gray"])
    box((ax0 + 0.35, -0.6, 0.91), (0.56, 0.56, 0.02), lin(0x3a5a6a), skip=("-z",))
    box((am, -1.6, 2.55), (ax1 - ax0, 0.015, 0.015), P["ink"], skip=())
    with into(bucket("A_Laundry", "M_Paint", (am, -1.6, 2.55))):
        for k, (cxo, cc, w, h) in enumerate(((-0.42, P["shirt_b"], 0.38, 0.55), (0.02, P["shirt_w"], 0.32, 0.7),
                                             (0.42, P["shirt_r"], 0.34, 0.5))):
            cx = am + cxo
            box((cx, -1.6, 2.55 - h / 2), (w, 0.02, h), cc, skip=())
            if k != 1:  # shirt sleeves
                box((cx, -1.6, 2.55 - 0.08), (w + 0.18, 0.02, 0.16), cc, skip=())
            box((cx - w / 2 + 0.03, -1.585, 2.54), (0.03, 0.02, 0.06), P["wood_bleach"], skip=())
    tuft((ax1 - 0.3, 0.5, 0.0), 0.35)
    tuft((ax0 + 0.2, -2.0, 0.0), 0.3)

    # ===== 3. SALOON (left third of the 16:9 frame) =================================
    x0, x1, yf = -7.6, -1.3, -0.35
    dc = -4.45  # doorway centre
    siding(x0, x1, 0.32, 7.4, yf, P["honey"])
    false_front(x0, x1, 7.4, 8.6, yf, P["honey"], P["green_dk"])
    door(dc, 0.32, 1.5, 2.45, yf, P["green_dk"], P["wood_dk"], dark=True)
    with into(bucket("S_Glow", "M_Glow")):  # warm interior glow plane behind the batwings
        wall(dc - 0.75, 0.9, 1.5, 1.6, yf - 0.1, 1, 1, P["interior"])
    for s, nm in ((-1, "A_BatL"), (1, "A_BatR")):  # batwings, hinged on the jambs
        hx = dc + s * 0.73
        with into(bucket(nm, "M_Paint", (hx, yf + 0.02, 0.0))):
            # short chest-high wings (0.98..1.62): dark doorway shows above and below
            for zz in (1.02, 1.58):  # top / bottom rails
                box((hx - s * 0.34, yf + 0.02, zz), (0.66, 0.05, 0.08), P["green_dk"], skip=())
            for k in range(2):        # stiles
                box((hx - s * (0.04 + k * 0.6), yf + 0.02, 1.3), (0.07, 0.05, 0.6), P["green_dk"], skip=())
            for k in range(6):        # louvres, gaps between them show the dark room
                box((hx - s * (0.12 + k * 0.088), yf + 0.02, 1.3), (0.05, 0.035, 0.48), P["green"], skip=())
            box((hx - s * 0.34, yf + 0.05, 1.64), (0.66, 0.03, 0.04), P["gold"], skip=("-y",))
    for wx in (x0 + 1.25, x1 - 1.05):
        window(wx, 0.95, 1.2, 1.45, yf, P["green_dk"], panes=(2, 3), curtain=P["curtain"])
    for wx in (x0 + 1.3, dc, x1 - 1.2):
        window(wx, 4.15, 0.9, 1.35, yf, P["green_dk"], panes=(2, 2), curtain=P["curtain"])
    # balcony over the porch (upper floor; tall aspects)
    box(((x0 + x1) / 2, 1.0, 4.62), (x1 - x0, 0.06, 1.0), P["green_dk"], skip=("-z",))
    for k in range(int((x1 - x0) / 0.22)):
        box((x0 + 0.1 + k * 0.22, 1.95, 4.0), (0.05, 0.05, 0.75), P["wood_mid"], skip=("-z", "-y"))
    box(((x0 + x1) / 2, 1.95, 4.4), (x1 - x0, 0.09, 0.08), P["green_dk"])
    porch_roof(x0, x1, 2.78, y0=0.0, fcol=P["green_dk"], rcol=P["wood_gray"], sign="SALOON",
               sign_col=P["cream"])
    hanging_sign("A_SignWhiskey", x0 + 1.25, 1.45, 2.72, 0.95, 0.38, P["wood_dk"], "WHISKEY", P["gold"])
    # porch furniture
    rx = x0 + 0.55
    with into(bucket("A_Rocker", "M_Paint", (rx, 0.9, 0.32))):  # side-on rocking chair
        for s in (-1, 1):
            box((rx, 0.9 + s * 0.22, 0.36), (0.75, 0.04, 0.05), P["wood_dk"], skip=())
        box((rx, 0.9, 0.78), (0.48, 0.48, 0.05), P["wood_mid"], skip=())
        box((rx - 0.25, 0.9, 1.15), (0.06, 0.46, 0.75), P["wood_mid"], rot=(0, -0.2, 0), skip=())
        for dx in (-0.2, 0.2):
            for s in (-1, 1):
                box((rx + dx, 0.9 + s * 0.22, 0.55), (0.05, 0.05, 0.42), P["wood_dk"], skip=())
    cyl((dc + 1.15, 1.2, 0.32), 0.13, 0.22, 8, P["brass"], r2=0.09)          # spittoon
    barrel((x1 - 0.35, 0.8, 0.32))
    barrel((dc - 1.15, 0.5, 0.32), r=0.26, h=0.75, col=P["wood_dk"])
    # hitching rail + trough + the horse (faces the centre of the frame)
    for hx in (x0 + 0.5, dc, x1 - 0.4):
        box((hx, 3.35, 0.55), (0.12, 0.12, 1.1), jit(P["post"], 0.1))
    box(((x0 + 0.5 + x1 - 0.4) / 2, 3.35, 1.02), (x1 - x0 - 0.8, 0.09, 0.09), P["wood_mid"])
    tx = x0 + 1.4
    box((tx, 3.0, 0.3), (1.5, 0.55, 0.6), P["wood_dk"], skip=("-z",))
    grid((tx - 0.7, 2.76, 0.52), (1.4, 0, 0), (0, 0.48, 0), 3, 1, lin(0x3a5a6a))  # water
    horse(-3.05, 4.05)
    side_walls(x0, x1, yf, 7.4, P["honey_dk"])

    # ===== 4. GENERAL STORE (behind the foe: light + calm low) ===================
    x0, x1, yf = -1.3, 4.4, 0.0
    # two-tone: cream storefront, slate above the awning (sits under the HUD
    # title, which is white text: keep that band mid-dark and calm)
    siding(x0, x1, 0.32, 2.98, yf, P["store"], amt=0.04)
    siding(x0, x1, 2.98, 6.6, yf, P["store_up"], amt=0.04)
    false_front(x0, x1, 6.6, 7.6, yf, P["store_up"], P["store_trim"])
    for a0, a1 in ((x0, 3.0), (3.98, x1)):  # wainscot band + rail, split at the door
        box(((a0 + a1) / 2, yf + 0.03, 0.62), (a1 - a0, 0.06, 0.6), P["store_trim"], skip=("-z", "-y"))
        box(((a0 + a1) / 2, yf + 0.07, 0.94), (a1 - a0, 0.1, 0.05), jit(P["store_trim"], 0.1))
    window(-0.45, 0.98, 1.05, 1.6, yf, P["store_trim"], panes=(2, 2), goods=True)
    window(2.15, 0.98, 0.9, 1.6, yf, P["store_trim"], panes=(2, 2), goods=True)
    door(3.45, 0.32, 0.9, 2.2, yf, P["store_trim"], lin(0x7a4a2a))
    for wx in (-0.2, 1.55, 3.3):
        window(wx, 4.1, 0.85, 1.3, yf, P["store_trim"], panes=(2, 2), curtain=P["shirt_w"],
               shutters=P["store_trim"])
    # striped awning; the store name rides on the cream valance
    ax_0, ax_1, za, zb, ya = -1.15, 4.25, 2.98, 2.62, 1.55
    vh = 0.32
    n = 16
    for i in range(n):
        xa = ax_0 + (ax_1 - ax_0) * i / n
        xb = ax_0 + (ax_1 - ax_0) * (i + 1) / n
        cc = P["awn_red"] if i % 2 == 0 else P["awn_white"]
        face(((xa, 0.02, za), (xb, 0.02, za), (xb, ya, zb), (xa, ya, zb)), cc)
        z2 = zb - vh
        face(((xa, ya, z2), ((xa + xb) / 2, ya, z2 - 0.12), (xb, ya, z2)), cc)
        face(((xb, ya - 0.01, z2), ((xa + xb) / 2, ya - 0.01, z2 - 0.12), (xa, ya - 0.01, z2)), cc)
    wall(ax_0, zb - vh, ax_1 - ax_0, vh, ya, 8, 1, P["cream"])
    grid((ax_0, ya - 0.01, zb - vh), (ax_1 - ax_0, 0, 0), (0, 0, vh), 4, 1, P["cream"])  # back
    box(((ax_0 + ax_1) / 2, ya + 0.01, zb - 0.02), (ax_1 - ax_0, 0.02, 0.04), P["awn_red"], skip=("-y",))
    box(((ax_0 + ax_1) / 2, ya + 0.01, zb - vh + 0.02), (ax_1 - ax_0, 0.02, 0.04), P["awn_red"], skip=("-y",))
    text("GENERAL STORE", (ax_0 + ax_1) / 2, ya + 0.02, zb - vh / 2, vh * 0.58, P["awn_red"],
         max_w=(ax_1 - ax_0) * 0.8)
    for px in (ax_0 + 0.05, ax_1 - 0.05):
        cyl((px, ya - 0.06, 0.32), 0.035, 2.3, 6, P["iron"])
    # goods out front (right side, away from the foe's silhouette)
    sack((2.65, 1.25, 0.32)); sack((2.95, 1.35, 0.32), col=jit(P["sack"], 0.1)); sack((2.8, 1.3, 0.6), s=0.26)
    crate((4.0, 1.2, 0.32), 0.5)
    barrel((-0.95, 1.15, 0.32), r=0.28, h=0.62, col=P["wood_mid"])
    for k in range(9):  # apples heaped in the barrel
        cyl((-0.95 + rng.uniform(-0.17, 0.17), 1.15 + rng.uniform(-0.17, 0.17), 0.9 + rng.uniform(0, 0.08)),
            0.055, 0.08, 5, jit(P["apple"], 0.15), r2=0.03)
    box((3.98, 0.35, 1.0), (0.04, 0.04, 1.3), P["wood_bleach"], rot=(0, -0.12, 0), skip=())  # broom
    box((3.9, 0.35, 0.42), (0.18, 0.08, 0.26), P["hay"], rot=(0, -0.12, 0), skip=())
    # pot plant by the door
    cyl((4.25, 0.5, 0.32), 0.17, 0.28, 8, P["pot"], r2=0.21)
    prickly((4.25, 0.5, 0.6), 0.32)
    side_walls(x0, x1, yf, 6.6, P["store"])

    # ===== 5. ALLEY 2 (crates + the cat, street lamp) ============================
    ax0, ax1 = 4.4, 5.7
    crate((4.75, 0.2, 0.0), 0.6, rot=0.1)
    crate((5.3, 0.15, 0.0), 0.5, rot=-0.15)
    crate((4.95, 0.2, 0.6), 0.45, rot=0.3)
    cat((4.95, 0.2, 1.05))
    # outhouse at the back of the alley
    box((5.05, -4.6, 1.1), (1.0, 1.0, 2.2), jit(P["wood_gray"], 0.05), skip=("-z",))
    box((5.05, -4.05, 2.28), (1.2, 1.2, 0.08), P["wood_dk"], rot=(0.2, 0, 0))
    box((5.05, -4.08, 1.0), (0.6, 0.04, 1.8), jit(P["wood_mid"], 0.05), skip=("-z", "-y"))
    crescent(5.05, -4.055, 1.62, 0.12, P["interior"])  # moon cut-out
    # street lamp on the boardwalk edge
    cyl((5.05, 2.0, 0.32), 0.06, 2.55, 6, P["iron"])
    box((5.05, 2.0, 0.36), (0.2, 0.2, 0.08), P["iron"])
    box((5.05, 2.0, 2.9), (0.26, 0.26, 0.04), P["iron"])
    with into(bucket("S_Glow", "M_Glow")):
        box((5.05, 2.0, 3.08), (0.2, 0.2, 0.32), P["lamp_glass"], skip=())
    cyl((5.05, 2.0, 3.24), 0.17, 0.14, 4, P["iron"], r2=0.02, rot=(0, 0, math.pi / 4))

    # ===== 6. SHERIFF (stone, no porch roof: breaks the band) =====================
    x0, x1, yf = 5.7, 10.7, 0.45
    blocks(x0, x1, 0.32, 4.3, yf, P["stone"], P["stone_dk"])
    box(((x0 + x1) / 2, yf + 0.08, 4.4), (x1 - x0 + 0.2, 0.22, 0.2), jit(P["stone"], 0.05))
    for k in range(6):  # crenellated parapet (tall aspects)
        box((x0 + 0.4 + k * (x1 - x0 - 0.8) / 5, yf + 0.0, 4.75), (0.5, 0.25, 0.5), jit(P["stone"], 0.08),
            skip=("-z",))
    box(((x0 + x1) / 2, yf - 0.05, 4.62), (x1 - x0, 0.25, 0.25), P["stone"], skip=("-z",))
    door(7.75, 0.32, 1.0, 2.25, yf, lin(0x5a4a3a), lin(0x5e3a22))
    for zz in (0.75, 1.5, 2.2):
        for xx in (-0.3, 0.0, 0.3):
            box((7.75 + xx, yf + 0.0, 0.32 + zz), (0.05, 0.03, 0.05), P["iron"], skip=("-y",))
    box((7.75, yf + 0.07, 2.92), (1.9, 0.08, 0.5), P["wood_dk"])
    text("SHERIFF", 7.75, yf + 0.115, 2.92, 0.3, P["gold"], max_w=1.7)
    star(9.0, yf + 0.06, 2.92, 0.22)
    star(6.5, yf + 0.06, 2.92, 0.22)
    window(6.4, 1.05, 0.95, 1.2, yf, lin(0x5a4a3a), panes=(1, 1), bars=True)
    window(9.85, 1.05, 0.95, 1.2, yf, lin(0x5a4a3a), panes=(1, 1), bars=True)
    poster(8.72, yf + 0.04, 1.95, 0)
    poster(8.78, yf + 0.04, 1.3, 1)
    # wall lantern by the door
    box((7.0, yf + 0.12, 2.4), (0.05, 0.25, 0.05), P["iron"])
    with into(bucket("S_Glow", "M_Glow")):
        box((7.0, yf + 0.26, 2.22), (0.16, 0.16, 0.26), P["lamp_glass"], skip=())
    box((7.0, yf + 0.26, 2.38), (0.2, 0.2, 0.05), P["iron"])
    # bench
    box((9.85, yf + 0.45, 0.78), (1.3, 0.4, 0.06), P["wood_mid"])
    for s in (-1, 1):
        box((9.85 + s * 0.55, yf + 0.45, 0.55), (0.08, 0.36, 0.45), P["wood_dk"], skip=())
    side_walls(x0, x1, yf, 4.3, P["stone"])

    # ===== 7. HOTEL (brick, porch + balcony) ===================================
    x0, x1, yf = 10.7, 19.5, -0.2
    blocks(x0, x1, 0.32, 7.0, yf, P["brick"], P["brick_mortar"], bw=0.34, bh=0.14, gapw=0.02, amt=0.12,
           proud=0.01)
    false_front(x0, x1, 7.0, 7.0, yf, P["brick"], P["trim_white"], kind="none")
    door(12.9, 0.32, 1.3, 2.35, yf, P["trim_white"], lin(0x6a3a22))
    for wx in (11.5, 14.4, 16.4, 18.4):
        window(wx, 0.95, 0.95, 1.5, yf, P["trim_white"], panes=(2, 2), curtain=lin(0xd8c8a0),
               shutters=P["shutter"])
    for wx in (11.5, 13.5, 15.5, 17.5):
        window(wx, 4.2, 0.85, 1.35, yf, P["trim_white"], panes=(2, 2), shutters=P["shutter"])
    porch_roof(x0, x1, 2.9, y0=0.0, fcol=P["trim_white"], rcol=P["wood_dk"], post=P["trim_white"],
               sign="HOTEL", sign_col=P["brick"])
    hanging_sign("A_SignRooms", 15.4, 1.45, 2.85, 1.0, 0.36, P["trim_white"], "ROOMS", P["brick"])
    side_walls(x0, x1, yf, 7.0, P["brick"])

    # bunting across the saloon / store front (static)
    bunting(-7.4, -1.5, 1.9, 2.72, 0.3)

    # ===== street dressing: wagon, rocks, tufts, cacti ===========================
    wagon(5.6, 5.6)
    for (x, y) in ((-6.0, 6.4), (8.6, 7.4), (-10.5, 5.8), (11.5, 6.6), (-14.0, 4.5), (14.0, 3.6),
                   (-1.9, 2.9), (3.6, 3.0), (6.8, 2.5), (-12.0, 3.6)):
        rock((x, y, 0.0), rng.uniform(0.12, 0.26), P["rock"] if rng.random() < 0.6 else P["rock_dk"])
    for k in range(48):
        x = rng.uniform(-18.0, 18.0)
        if -1.6 < x < 3.2:
            continue  # keep the foe's backdrop calm
        y = rng.choice((rng.uniform(2.25, 2.7), rng.uniform(2.3, 8.0)))
        tuft((x, y, 0.0), rng.uniform(0.2, 0.42))
    # foreground: sparse scrub at the frame sides, never on the duel line
    # (the player stands at (0, 22.5), the foe at (0, 9.5))
    for k in range(26):
        x = rng.choice((rng.uniform(-8.0, -2.8), rng.uniform(3.4, 10.0)))
        y = rng.uniform(10.0, 23.0)
        if rng.random() < 0.75:
            tuft((x, y, 0.0), rng.uniform(0.22, 0.45))
        else:
            rock((x, y, 0.0), rng.uniform(0.1, 0.22), P["rock"] if rng.random() < 0.5 else P["rock_dk"])
    for (x, y) in ((-13.6, 3.0), (12.2, 2.8), (-17.2, 3.3)):
        barrel_cactus((x, y, 0.0), rng.uniform(0.16, 0.24))
    prickly((-15.0, 3.2, 0.0), 0.55)
    prickly((16.5, 3.0, 0.0), 0.5)

    flush_walls()

    # tumbleweed: sticks in a ball; the game rolls it across the street
    with into(bucket("A_Tumble", "M_Paint", (0.0, 6.2, 0.38))):
        for k in range(26):
            d = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(-1, 1))).normalized()
            ctr = Vector((0.0, 6.2, 0.38)) + d * rng.uniform(0.0, 0.18)
            box(ctr, (0.025, 0.025, rng.uniform(0.35, 0.6)), jit(lin(0x9a7a46), 0.15),
                rot=(rng.uniform(0, 3.14), rng.uniform(0, 3.14), rng.uniform(0, 3.14)), skip=())

def star(cx, y, cz, r):
    pts = []
    for i in range(10):
        a = math.pi / 2 + i * math.pi / 5
        rr = r if i % 2 == 0 else r * 0.42
        pts.append((cx + math.cos(a) * rr, y + 0.02, cz + math.sin(a) * rr))
    c = (cx, y + 0.03, cz)
    for i in range(10):
        face((pts[(i + 1) % 10], pts[i], c), P["gold"])

def crescent(cx, y, cz, r, col, n=10):
    """Crescent moon facing +y: left half-disc minus a narrower half-ellipse,
    built as a strip so the tips close cleanly (no concave n-gon)."""
    outer = [(cx - r * math.sin(math.pi * i / n), y, cz + r * math.cos(math.pi * i / n)) for i in range(n + 1)]
    inner = [(cx - 0.4 * r * math.sin(math.pi * i / n), y, cz + r * math.cos(math.pi * i / n))
             for i in range(n + 1)]
    for i in range(n):  # clockwise in (x, z) = facing +y (same as star())
        if i == 0:
            face((inner[1], outer[1], outer[0]), col)
        elif i == n - 1:
            face((outer[i + 1], outer[i], inner[i]), col)
        else:
            face((inner[i + 1], outer[i + 1], outer[i], inner[i]), col)

def poster(cx, y, cz, i):
    box((cx, y, cz), (0.42, 0.02, 0.56), jit(P["paper"], 0.05), skip=("-y",))
    text("WANTED", cx, y + 0.012, cz + 0.2, 0.065, P["ink"], max_w=0.36, res=1)
    box((cx, y + 0.012, cz - 0.02), (0.2, 0.005, 0.22), jit(P["paper"], 0.25) if i else lin(0xb89a70),
        skip=("-y",))
    box((cx, y + 0.016, cz - 0.0), (0.1, 0.005, 0.1), P["ink"], skip=("-y",))
    text("$500" if i == 0 else "$200", cx, y + 0.012, cz - 0.2, 0.05, P["awn_red"], max_w=0.3, res=1)

def bunting(x0, x1, y, z, sag):
    n = int((x1 - x0) / 0.32)
    cols = (P["bunt_r"], P["bunt_w"], P["bunt_b"])
    prev = None
    for i in range(n + 1):
        t = i / n
        x = x0 + (x1 - x0) * t
        zz = z - sag * 4 * t * (1 - t)
        if prev:
            box(((prev[0] + x) / 2, y, (prev[1] + zz) / 2), (x - prev[0], 0.01, 0.012), P["ink"], skip=(),
                rot=(0, -math.atan2(zz - prev[1], x - prev[0]), 0))
        if i < n:
            xa, xb = x + 0.03, x + (x1 - x0) / n - 0.03
            tm = (i + 0.5) / n
            zm = z - sag * 4 * tm * (1 - tm)
            cc = cols[i % 3]
            face(((xa, y, zz), ((xa + xb) / 2, y, zm - 0.24), (xb, y, zm)), cc)
            face(((xb, y - 0.005, zm), ((xa + xb) / 2, y - 0.005, zm - 0.24), (xa, y - 0.005, zz)), cc)
        prev = (x, zz)

def horse(cx, cy, S=1.08):
    """Boxy bay horse side-on, head toward screen right. Head+neck and tail are
    separate pivoted parts (game nods / swishes them). rot about y: + tips the
    local +x end DOWN / the local +z end toward +x."""
    H, D, M = P["horse"], P["horse_dk"], P["mane"]
    def b(x, z, size, col, rot=None, dy=0.0, skip=()):
        box((cx + x * S, cy + dy * S, z * S), tuple(v * S for v in size), col, rot=rot, skip=skip)
    for lx, ly in ((0.58, -0.15), (0.58, 0.15), (-0.58, -0.15), (-0.58, 0.15)):
        b(lx, 0.66, (0.16, 0.14, 0.46), jit(H, 0.05), dy=ly)            # forearm / gaskin
        b(lx, 0.27, (0.11, 0.11, 0.34), jit(D, 0.05), dy=ly)            # cannon
        b(lx, 0.05, (0.15, 0.15, 0.1), P["hoof"], dy=ly)
    b(0.0, 1.13, (1.45, 0.48, 0.52), H)                                # barrel
    b(0.66, 1.12, (0.36, 0.46, 0.58), jit(H, 0.03))                    # chest
    b(-0.6, 1.18, (0.46, 0.5, 0.56), jit(H, 0.03), rot=(0, -0.25, 0))  # haunch
    b(0.0, 0.86, (1.05, 0.4, 0.08), jit(D, 0.05))                      # belly shade
    # blanket, saddle, horn, stirrup
    b(0.0, 1.25, (0.62, 0.52, 0.44), P["blanket"])
    b(0.0, 1.07, (0.64, 0.53, 0.06), P["blanket_b"])
    b(0.0, 1.42, (0.5, 0.5, 0.1), P["saddle"])
    b(-0.24, 1.5, (0.1, 0.46, 0.14), P["saddle"])
    b(0.21, 1.53, (0.06, 0.06, 0.14), P["saddle"])
    b(0.0, 1.08, (0.04, 0.02, 0.42), P["saddle"], dy=0.28)
    b(0.0, 0.85, (0.14, 0.05, 0.05), P["iron"], dy=0.28)
    with into(bucket("A_HorseHead", "M_Paint", (cx + 0.55 * S, cy, 1.35 * S))):
        b(0.84, 1.68, (0.34, 0.3, 0.8), H, rot=(0, 0.62, 0))           # neck
        for k in range(6):                                              # mane along the crest
            b(0.6 + k * 0.085, 1.6 + k * 0.105, (0.09, 0.12, 0.2), jit(M, 0.1), rot=(0, 0.62, 0))
        b(1.17, 1.88, (0.56, 0.26, 0.25), H, rot=(0, 0.75, 0))         # head
        b(1.36, 1.66, (0.2, 0.25, 0.2), D, rot=(0, 0.75, 0))           # muzzle
        b(1.18, 1.86, (0.4, 0.01, 0.07), P["blaze"], rot=(0, 0.75, 0), dy=0.131)
        b(1.05, 1.98, (0.05, 0.01, 0.05), P["ink"], dy=0.131)          # eye
        for s in (-1, 1):
            b(0.98, 2.15, (0.06, 0.05, 0.15), D, rot=(0, -0.25, 0), dy=s * 0.07)  # ears
        b(1.15, 1.85, (0.5, 0.012, 0.025), P["saddle"], rot=(0, 0.75, 0), dy=0.135)  # bridle
    with into(bucket("A_HorseTail", "M_Paint", (cx - 0.82 * S, cy, 1.38 * S))):
        for k in range(4):
            b(-0.88 - k * 0.05, 1.27 - k * 0.17, (0.13 - k * 0.015, 0.11, 0.24), jit(M, 0.08),
              rot=(0, -0.25, 0))
    # reins: muzzle down to the hitching rail behind
    box((cx + 1.3 * S, cy - 0.35, 1.25), (0.02, 0.02, 0.85), P["saddle"], rot=(0.75, 0, 0), skip=())

def cat(c):
    x, y, z = c
    box((x, y, z + 0.11), (0.3, 0.14, 0.18), P["cat"], skip=())
    box((x + 0.16, y, z + 0.24), (0.14, 0.13, 0.13), P["cat"], skip=())
    for s in (-1, 1):
        box((x + 0.17, y + s * 0.04, z + 0.33), (0.04, 0.03, 0.06), P["cat"], skip=())
        box((x + 0.16 + s * 0.035, y + 0.066, z + 0.25), (0.025, 0.005, 0.025), P["cat_eye"], skip=())
    with into(bucket("A_CatTail", "M_Paint", (x - 0.15, y, z + 0.12))):
        box((x - 0.2, y, z + 0.1), (0.12, 0.04, 0.04), P["cat"], rot=(0, 0.6, 0), skip=())
        box((x - 0.27, y, z + 0.0), (0.04, 0.04, 0.16), P["cat"], skip=())

def wagon(cx, cy):
    """Buckboard side-on (wheels face the camera), tongue toward screen right."""
    W = P["wood_mid"]
    box((cx, cy, 0.95), (2.3, 1.1, 0.08), W)
    for s in (-1, 1):
        box((cx, cy + s * 0.53, 1.12), (2.3, 0.05, 0.3), jit(W, 0.08), skip=())
    box((cx - 1.13, cy, 1.12), (0.05, 1.1, 0.3), W)
    box((cx + 1.13, cy, 1.2), (0.05, 1.1, 0.45), W)
    box((cx + 0.75, cy, 1.35), (0.45, 0.9, 0.06), P["wood_dk"])   # seat
    box((cx + 0.95, cy, 1.2), (0.05, 0.9, 0.3), P["wood_dk"])
    box((cx + 2.0, cy, 0.55), (1.8, 0.07, 0.07), P["wood_dk"], rot=(0, 0.22, 0))  # tongue
    for (wx, r) in ((cx - 0.75, 0.52), (cx + 0.8, 0.44)):
        for s in (-1, 1):
            wy = cy + s * 0.62
            wheel(wx, wy, r, front=(s > 0))
    barrel((cx - 0.5, cy, 0.99), r=0.25, h=0.6)
    crate((cx + 0.15, cy - 0.1, 0.99), 0.4, rot=0.2)
    sack((cx - 0.05, cy + 0.25, 0.99), 0.3)

def wheel(cx, cy, r, front=True):
    n = 14
    pts_o = [(cx + math.cos(2 * math.pi * i / n) * r, cy, r + math.sin(2 * math.pi * i / n) * r) for i in range(n)]
    for i in range(n):
        a = 2 * math.pi * (i + 0.5) / n
        L = 2 * r * math.sin(math.pi / n) + 0.01
        box((cx + math.cos(a) * r * 0.95, cy, r + math.sin(a) * r * 0.95), (0.06, 0.06, L),
            P["wood_dk"], rot=(0, -a, 0), skip=() if front else ("-y",))
    for i in range(8):
        a = 2 * math.pi * i / 8
        box((cx + math.cos(a) * r * 0.48, cy, r + math.sin(a) * r * 0.48), (0.035, 0.03, r * 0.9),
            P["wood_mid"], rot=(0, -a + math.pi / 2, 0), skip=())
    box((cx, cy, r), (0.12, 0.12, 0.12), P["iron"])

# --- assemble objects, materials ---------------------------------------------------
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
    if name == "M_Glow":
        bs.inputs["Emission Color"].default_value = lin(0xffb860)
        bs.inputs["Emission Strength"].default_value = 1.0
    nt.links.new(bs.outputs["BSDF"], out.inputs["Surface"])
    return m

def reset_collection(name):
    coll = bpy.data.collections.get(name)
    if coll:
        for o in list(coll.objects):
            me = o.data
            bpy.data.objects.remove(o, do_unlink=True)
            if me and me.users == 0:
                bpy.data.meshes.remove(me)
    else:
        coll = bpy.data.collections.new(name)
        bpy.context.scene.collection.children.link(coll)
    return coll

def assemble(coll):
    objs = []
    for b in BUCKETS.values():
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

def game_camera():
    cam = bpy.data.objects.get("GameCam")
    if not cam:
        cam = bpy.data.objects.new("GameCam", bpy.data.cameras.new("GameCam"))
        bpy.context.scene.collection.objects.link(cam)
    cam.data.type = "ORTHO"
    cam.data.ortho_scale = 2 * 3.4 * 16 / 9   # halfH 3.4 at 16:9 (fitCamera floor)
    cam.data.clip_start, cam.data.clip_end = 0.1, 200
    cam.location = (0.68, 24.021, 2.1)        # in-game camera, distM 11.5 (see header)
    d = Vector((0, 13.91, 1.32)) - cam.location
    cam.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()
    sc = bpy.context.scene
    sc.camera = cam
    sc.render.resolution_x, sc.render.resolution_y = 1920, 1080
    return cam

# --- bake: AO + sun shadow into the vertex colours -------------------------------------
SUN_FROM = Vector((-0.513, -0.281, 0.811))   # game dir light (6,10,4) in Blender coords

def sun_shadow(objs, rays=7, spread=math.radians(3)):
    """Cast-shadow factor per face corner (1 = lit, 0 = fully shadowed) by
    ray-casting toward the sun through a BVH of the whole set. Replaces the
    Cycles SHADOW bake, whose output is unbounded (values up to ~1e4 blew the
    horse neck / signs out). Faces turned away from the sun stay 1: the game's
    Lambert term already darkens them. A few jittered rays soften the edges."""
    from mathutils.bvhtree import BVHTree
    verts, polys = [], []
    for o in objs:
        mw, base = o.matrix_world, len(verts)
        verts.extend(mw @ v.co for v in o.data.vertices)
        polys.extend([base + i for i in p.vertices] for p in o.data.polygons)
    tree = BVHTree.FromPolygons(verts, polys)
    L = SUN_FROM.normalized()
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
                org = pt.lerp(ctr, 0.04) + n * 0.004   # off the edge + off the face
                hit = sum(1 for d in dirs if tree.ray_cast(org, d, 80.0)[0] is not None)
                res[li] = 1.0 - hit / len(dirs)
        out[o.name] = res
    return out

def bake(objs):
    sc = bpy.context.scene
    prev_engine = sc.render.engine
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 48
    sc.render.bake.target = "VERTEX_COLORS"
    sc.render.bake.margin = 0
    if not sc.world:
        sc.world = bpy.data.worlds.new("World")
    sc.world.light_settings.distance = 1.6
    helpers = []
    gme = bpy.data.meshes.new("BakeGround")
    gbm = bmesh.new()
    bmesh.ops.create_grid(gbm, x_segments=1, y_segments=1, size=60)
    gbm.to_mesh(gme)
    gbm.free()
    g = bpy.data.objects.new("BakeGround", gme)
    sc.collection.objects.link(g)
    helpers.append(g)
    sun = bpy.data.objects.new("BakeSun", bpy.data.lights.new("BakeSun", "SUN"))
    sun.data.angle = math.radians(6)
    sun.rotation_euler = SUN_FROM.to_track_quat("Z", "Y").to_euler()
    sc.collection.objects.link(sun)
    helpers.append(sun)
    bpy.ops.object.select_all(action="DESELECT")
    for o in objs:
        if o.data.color_attributes.get("AO"):
            o.data.color_attributes.remove(o.data.color_attributes["AO"])
        o.data.color_attributes.new("AO", "FLOAT_COLOR", "CORNER")
        o.data.color_attributes.active_color = o.data.color_attributes["AO"]
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.bake(type="AO")
    shadow = sun_shadow(objs)
    for o in objs:
        me = o.data
        col, ao = me.color_attributes["Col"].data, me.color_attributes["AO"].data
        sh = shadow[o.name]
        glow = o.name == "S_Glow"
        k_ao, k_sh = (0.25, 0.0) if glow else (0.7, 0.42)
        for i in range(len(col)):
            a = min(1.0, max(0.0, ao[i].color[0]))
            m = (1 - k_ao * (1 - a)) * (1 - k_sh * (1 - sh[i]))
            c = col[i].color
            col[i].color = (min(1.0, c[0] * m), min(1.0, c[1] * m), min(1.0, c[2] * m), 1.0)
        me.color_attributes.remove(me.color_attributes["AO"])
        me.color_attributes.active_color = me.color_attributes["Col"]
    for h in helpers:
        data = h.data
        bpy.data.objects.remove(h, do_unlink=True)
        if isinstance(data, bpy.types.Mesh):
            bpy.data.meshes.remove(data)
        else:
            bpy.data.lights.remove(data)
    sc.render.engine = prev_engine

def export(coll, path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in coll.objects:
        o.select_set(True)
    kw = dict(filepath=path, export_format="GLB", use_selection=True, export_apply=True,
              export_animations=False, export_yup=True, export_materials="EXPORT",
              export_texcoords=False, export_normals=False)
    try:
        bpy.ops.export_scene.gltf(**kw, export_vertex_color="ACTIVE")
    except TypeError:
        bpy.ops.export_scene.gltf(**kw, export_colors=True)

def slim_glb(path):
    """Post-export: drop NORMAL (the game flat-shades from derivatives) and store
    COLOR_0 as normalized uint16 RGBA instead of float RGB. ~40% smaller."""
    import json, struct
    with open(path, "rb") as f:
        data = f.read()
    jl = struct.unpack_from("<I", data, 12)[0]
    j = json.loads(data[20:20 + jl])
    bl = struct.unpack_from("<I", data, 20 + jl)[0]
    binc = data[28 + jl:28 + jl + bl]
    acc, views = j["accessors"], j["bufferViews"]
    size = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}
    csize = {5121: 1, 5123: 2, 5125: 4, 5126: 4}
    out, new_acc, new_views, remap = bytearray(), [], [], {}
    def add(raw, a, target):
        while len(out) % 4:
            out.append(0)
        new_views.append({"buffer": 0, "byteOffset": len(out), "byteLength": len(raw),
                          **({"target": target} if target else {})})
        out.extend(raw)
        a["bufferView"] = len(new_views) - 1
        a.pop("byteOffset", None)
        new_acc.append(a)
        return len(new_acc) - 1
    def raw_of(a):
        v = views[a["bufferView"]]
        n = a["count"] * size[a["type"]] * csize[a["componentType"]]
        o = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        return binc[o:o + n], v.get("target")
    for m in j["meshes"]:
        for pr in m["primitives"]:
            at = pr["attributes"]
            at.pop("NORMAL", None)
            for k in list(at):
                old = at[k]
                a = dict(acc[old])
                raw, tg = raw_of(a)
                if k == "COLOR_0" and a["componentType"] == 5126:
                    nc = size[a["type"]]
                    fl = struct.unpack("<%df" % (a["count"] * nc), raw)
                    q = []
                    for i in range(a["count"]):
                        px = fl[i * nc:(i + 1) * nc]
                        q.extend(int(round(max(0.0, min(1.0, c)) * 65535)) for c in px[:3])
                        q.append(65535)
                    raw = struct.pack("<%dH" % len(q), *q)
                    a.update(componentType=5123, type="VEC4", normalized=True)
                    a.pop("min", None); a.pop("max", None)
                key = (old, k == "COLOR_0")
                if key not in remap:
                    remap[key] = add(raw, a, tg)
                at[k] = remap[key]
            if "indices" in pr:
                key = (pr["indices"], "idx")
                if key not in remap:
                    a = dict(acc[pr["indices"]])
                    raw, tg = raw_of(a)
                    remap[key] = add(raw, a, tg)
                pr["indices"] = remap[key]
    while len(out) % 4:
        out.append(0)
    j["accessors"], j["bufferViews"] = new_acc, new_views
    j["buffers"] = [{"byteLength": len(out)}]
    js = json.dumps(j, separators=(",", ":")).encode()
    js += b" " * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(path, "wb") as f:
        f.write(struct.pack("<III", 0x46546C67, 2, total))
        f.write(struct.pack("<I4s", len(js), b"JSON")); f.write(js)
        f.write(struct.pack("<I4s", len(out), b"BIN\0")); f.write(out)

def main():
    BUCKETS.clear()
    HOLES.clear()
    WALL_JOBS.clear()
    coll = reset_collection("Street")
    for c in list(bpy.data.collections):
        if c.name.startswith("Street") and c is not coll and not c.objects and not c.children:
            bpy.data.collections.remove(c)
    build()
    objs = assemble(coll)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    print("street objects:", [o.name for o in objs], "tris:", tris)
    if not bpy.app.background:
        game_camera()
    if BAKE:
        bake(objs)
    if EXPORT:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        export(coll, OUT)
        slim_glb(OUT)
        print("EXPORTED", OUT, os.path.getsize(OUT) // 1024, "KB")
    return tris

main()
