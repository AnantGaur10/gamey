"""Deterministic saloon-interior build: code -> public/models/saloon.glb.

    blender -b --factory-startup --python scripts/blender/build_saloon.py

Never opens or saves a .blend; everything is generated here from a seeded rng,
so two runs give byte-identical GLBs.

THE PLACE (user 2026-10-12, "inside a saloon", ref = a grand two-storey
western saloon, "take inspiration, don't copy"): a long timber hall with a
worn plank floor, galleries with baluster railings along both side walls and
the back wall, two staircases dropping from the side galleries toward the
middle of the back wall (a V that frames the foe), heavy turned pillars,
wagon-wheel chandeliers, round card tables (two cloth-covered), a long bar with
a mirror and bottle shelves on the left, an upright piano on the right, and
bright windows on the right wall throwing light stripes across the floor.

WHY IT LOOKS LIKE THIS: the duel runs down the middle of the hall. The camera
sees the back wall 24-41m away (the V of the stairs, the back gallery, the
paintings), the LEFT wall from y ~9-22 forward (bar side: most visible), the
right wall only on long duels. The ceiling shows only on long duels (top of
frame). The room must be closed at every distance: the hall runs from the
back wall (y -3) to a front wall behind the camera (y 46).
The area behind the foe (back wall, x -2..1, z 0..3) stays plain mid-tone
wallpaper over a dark wainscot so any foe colour reads against it.

LIGHT: interior, no sun. Lamps (chandeliers, sconces, bar lanterns, table
candles) are baked as a ray-cast point-light pass into the vertex colours
(light pools, dark corners: the luma range the runtime hell tint needs), then
the kit's Cycles AO bake. Daylight is runtime: window panes are S_Sky (painted
from the time-of-day sky) and the window light on the floor + dusty beams are
S_Shaft (additive, faded out at night).

COORDS: set_kit SCREEN space (sx right, y toward the camera, z up); foe at
(0, 9.5, 0), player at (0, 18..35.2), camera (1.25, 21.1..38.3, 2.05). Floor
top is z = 0 (the game's ground). Clear aisle: nothing above the ankles in
|x| < 2.5 for y 4..46.

OUTPUT NODES: S_Paint (everything static), S_Glow (flames, sconce shades,
lantern glass: lit at all times), S_Sky (window panes), S_Shaft (floor light
stripes + beams, emitted with both windings: render it FrontSide).
No A_* nodes.

Env: SALOON_OUT=<glb path>, SALOON_BAKE=0 (skip the Cycles AO bake; the lamp
pass always runs, it is part of the build), SALOON_EXPORT=0,
SALOON_PREVIEW=<png prefix>. Full build ~10s.
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector
from mathutils.bvhtree import BVHTree

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
sys.path.insert(0, HERE)
import set_kit as K  # noqa: E402
from set_kit import lin, jit, mix, scale, cyl, cone, face, grid, wall_x, into  # noqa: E402

K.seed(1879)
rng = K.rng

P = {k: lin(v) for k, v in dict(
    plank=0x62462f, plank_lt=0x7a583a, plank_dk=0x43301f, worn=0x86705a, gap=0x1c120b,
    wood_dk=0x3a2516, wood=0x6a4528, wood_mid=0x7d5432, honey=0x94643a, trim=0xa87a4a,
    paper=0x5d6855, paper_b=0x56604e, paper_up=0x675c4b, paper_upb=0x605646,
    frieze=0x2e2117, ceil=0x3b2a1c, beam=0x2f1f13,
    cloth=0xa39278, cloth_dk=0x84745c, wine=0x6a2622, felt=0x2f4a34,
    brass=0xb08a3a, iron=0x2a2420, mirror=0x56605e, mirror_dk=0x3c4442,
    green_b=0x2f5a3a, amber=0x7a4a1a, clear=0xa0a89a, red_b=0x6a1f1a,
    wax=0xe8dcc0, flame=0xffc070, flame_hot=0xffe2a0, shade=0xffcf86,
    gold=0xa0782e, canvas_sky=0x8aa0b0, canvas_dusk=0xc08a5a, canvas_hill=0x5f6470,
    canvas_grass=0x7a6a40, canvas_dark=0x3a3328, bone=0xe2d6bc, horn=0xcdbf9e,
    piano=0x2a1a12, key_w=0xe8e0d0, key_b=0x151010, paper_w=0xe0d0a8, ink=0x3a2a1c,
    glass_sh=0xa8b0aa, barrel=0x6e4a2c, hoop=0x2b2622, sawdust=0x9a7a50,
).items()}

# --- the hall ----------------------------------------------------------------------
X0, X1 = -11.5, 10.5       # side walls (left = bar side, the camera sees more of it)
Y0, Y1 = -3.0, 46.0        # back wall, front wall (behind the camera at every distance)
ZC = 9.5                   # ceiling
ZG = 4.2                   # gallery floor top
GL, GR = -8.5, 7.5         # side gallery fronts
BG = -0.8                  # back gallery front
POST_Y = (BG, 5.0, 11.0, 17.0, 23.0, 29.0, 35.0, 41.0)   # gallery posts along the fronts
PILLAR_Y = (16.0, 28.0, 40.0)                           # free-standing pillars at x = +-4.5
LIGHTS = []                # (screen pos, intensity, radius, tint)

def box(c, size, col, rot=None, cell=None, skip=("-z",), colf=None):
    """K.box minus the -y face: the camera always looks down -y, so a face
    turned to -y is a back face from every duel distance (unrotated boxes)."""
    if rot is None and "-y" not in skip:
        skip = tuple(skip) + ("-y",)
    K.box(c, size, col, rot=rot, cell=cell, skip=skip, colf=colf)

def light(p, i, r, tint=(1.0, 0.86, 0.68)):
    LIGHTS.append((Vector(p), i, r, tint))

# --- local helpers -----------------------------------------------------------------
def rect(c, n, hu, hv, col, nu=1, nv=1):
    """Flat rectangle centred at c facing axis n ('+x','-x','+y','+z','-z'),
    half sizes hu (horizontal) x hv (vertical, or depth for +-z)."""
    N = {"+x": Vector((1, 0, 0)), "-x": Vector((-1, 0, 0)), "+y": Vector((0, 1, 0)),
         "-y": Vector((0, -1, 0)), "+z": Vector((0, 0, 1)), "-z": Vector((0, 0, -1))}[n]
    V = Vector((0, 1, 0)) if n in ("+z", "-z") else Vector((0, 0, 1))
    U = V.cross(N)
    c = Vector(c)
    grid(c - U * hu - V * hv, U * 2 * hu, V * 2 * hv, nu, nv, col)

def oface(pts, col, out):
    """Face with outward normal on the side of direction `out` (auto-winding)."""
    pts = [Vector(p) for p in pts]
    n = (pts[1] - pts[0]).cross(pts[-1] - pts[0])
    face(pts if n.dot(Vector(out)) >= 0 else list(reversed(pts)), col)

def beam(a, b, w, h, col, ends=False):
    """Box from a to b with cross-section w (horizontal) x h."""
    a, b = Vector(a), Vector(b)
    d = (b - a).normalized()
    side = d.cross(Vector((0, 0, 1)))
    side = side.normalized() if side.length > 1e-6 else Vector((1, 0, 0))
    up = side.cross(d).normalized()
    sw, uh = side * (w / 2), up * (h / 2)
    corners = lambda p: [p - sw - uh, p + sw - uh, p + sw + uh, p - sw + uh]
    A, B = corners(a), corners(b)
    mid = (a + b) / 2
    for i in range(4):
        j = (i + 1) % 4
        q = [A[i], A[j], B[j], B[i]]
        oface(q, col, (sum(q, Vector()) / 4) - mid)
    if ends:
        oface(A, col, a - b)
        oface(B, col, b - a)

def turned(cx, cy, z0, z1, r, col, plinth=True, segs=8):
    """Turned post: square plinth, round shaft with rings, square cap."""
    z = z0
    if plinth:
        box((cx, cy, z0 + 0.45), (r * 3.0, r * 3.0, 0.9), scale(col, 0.8), cell=0.6)
        box((cx, cy, z0 + 0.93), (r * 3.3, r * 3.3, 0.07), scale(col, 0.9))
        z = z0 + 0.96
    cyl((cx, cy, z), r * 1.15, 0.1, segs, col, caps=(False, True))
    cyl((cx, cy, z + 0.1), r, (z1 - 0.3) - (z + 0.1), segs, col, caps=(False, False))
    for k in range(int((z1 - z) / 2.4)):
        zz = z + 1.4 + k * 2.4
        if zz < z1 - 0.6:
            cyl((cx, cy, zz), r * 1.22, 0.09, segs, scale(col, 1.1), caps=(False, True))
    box((cx, cy, z1 - 0.15), (r * 2.8, r * 2.8, 0.3), scale(col, 0.85))

def text_x(s, x, cy, cz, height, col, facing=1, max_w=None):
    """Text on the plane x facing +x (left wall) or -x (right wall)."""
    cu = bpy.data.curves.new("tmp_txt", "FONT")
    cu.body, cu.font, cu.size, cu.resolution_u = s, K.font(), 1.0, 2
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
        pts = [Vector((x, cy - facing * (vs[i].x - mx) * k, cz + (vs[i].y - my) * k)) for i in poly]
        oface(pts, col, (facing, 0, 0))

# --- floor ---------------------------------------------------------------------------
def plank_floor():
    bw = (X1 - X0) / 72
    seg = (Y1 - Y0) / 25
    for i in range(72):
        x0 = X0 + i * bw
        xc = x0 + bw / 2
        base = jit(P["plank"], 0.16)
        if rng.random() < 0.18:
            base = jit(P["plank_dk"], 0.12)
        elif rng.random() < 0.15:
            base = jit(P["plank_lt"], 0.1)
        # foot traffic: the aisle and the bar front are worn lighter + greyer
        wear = max(0.0, 1 - abs(xc) / 3.2) * 0.45 + max(0.0, 1 - abs(xc + 8.0) / 1.4) * 0.3
        noise = [rng.uniform(-0.06, 0.06) for _ in range(26)]
        def colf(a, j, base=base, wear=wear, noise=noise):
            c = mix(base, P["worn"], wear * (0.7 + 0.3 * math.sin(j * 0.7 + i)))
            return scale(c, 1 + noise[j])
        grid((x0, Y0, 0.0), (bw, 0, 0), (0, Y1 - Y0, 0), 1, 25, colf)
        # seam between boards + staggered butt joints
        if i:
            face(((x0 - 0.008, Y0, 0.002), (x0 + 0.008, Y0, 0.002), (x0 + 0.008, Y1, 0.002),
                  (x0 - 0.008, Y1, 0.002)), P["gap"])
        y = Y0 + rng.uniform(0.5, 5.0)
        while y < Y1 - 0.5:
            face(((x0, y - 0.008, 0.002), (x0 + bw, y - 0.008, 0.002), (x0 + bw, y + 0.008, 0.002),
                  (x0, y + 0.008, 0.002)), P["gap"])
            y += rng.uniform(4.0, 7.5)
    # dark stains + a scatter of broken glass near the middle
    for _ in range(14):
        cx, cy = rng.uniform(X0 + 1, X1 - 1), rng.uniform(Y0 + 1, 44)
        r = rng.uniform(0.12, 0.4)
        pts = [(cx + math.cos(a) * r * rng.uniform(0.7, 1.1), cy + math.sin(a) * r * rng.uniform(0.6, 1.0), 0.003)
               for a in (2 * math.pi * k / 7 for k in range(7))]
        face(pts, jit(scale(P["plank"], 0.78), 0.06))
    for _ in range(26):
        cx, cy = rng.uniform(-2.2, 2.4), rng.uniform(6, 24)
        a = rng.uniform(0, 6.28)
        s = rng.uniform(0.03, 0.08)
        face(((cx, cy, 0.004), (cx + math.cos(a) * s, cy + math.sin(a) * s, 0.004),
              (cx + math.cos(a + 2.1) * s * 0.8, cy + math.sin(a + 2.1) * s * 0.8, 0.004)),
             jit(P["glass_sh"], 0.1))

# --- walls, ceiling, beams --------------------------------------------------------------
def paper(i, j, a, b):
    # aged paper: near-uniform, soft blotches (a hard check read as tiles)
    t = 0.5 + 0.5 * math.sin(i * 1.7 + j * 2.3) * math.sin(i * 0.6 - j * 1.1)
    return jit(mix(a, b, t), 0.015)

def pilasters_back(z0, z1, xs):
    for x in xs:
        box((x, Y0 + 0.04, (z0 + z1) / 2), (0.24, 0.07, z1 - z0), jit(P["wood_dk"], 0.04))
        box((x, Y0 + 0.06, z1 - 0.12), (0.34, 0.1, 0.12), P["wood"])

def pilasters_side(x, f, z0, z1, ys):
    for y in ys:
        box((x + f * 0.035, y, (z0 + z1) / 2), (0.07, 0.24, z1 - z0), jit(P["wood_dk"], 0.04),
            skip=("-z", "+x" if f < 0 else "-x"))

def walls():
    # BACK WALL: wainscot (0..1.1) + chair rail, wallpaper to the gallery, upper wall
    w = X1 - X0
    K.wall(X0, 0.0, w, 1.1, Y0, 22, 2, P["wood_dk"])
    for k in range(int(w / 1.2)):  # raised panels
        px = X0 + 0.6 + k * 1.2
        box((px, Y0 + 0.03, 0.55), (0.9, 0.04, 0.7), jit(P["wood"], 0.06), skip=("-z", "-y"))
    box(((X0 + X1) / 2, Y0 + 0.05, 1.13), (w, 0.08, 0.07), P["trim"], skip=("-y",))
    K.wall(X0, 1.1, w, ZG - 1.1, Y0, 28, 4, lambda i, j: paper(i, j, P["paper"], P["paper_b"]))
    K.wall(X0, ZG, w, ZC - ZG, Y0, 28, 7, lambda i, j: paper(i, j, P["paper_up"], P["paper_upb"]))
    box(((X0 + X1) / 2, Y0 + 0.08, ZC - 0.35), (w, 0.14, 0.7), P["frieze"], skip=("-y",))
    pilasters_back(ZG, ZC - 0.7, (-9.6, -7.4, -3.6, 3.6, 7.4, 9.0))
    pilasters_back(1.15, ZG - 0.4, (-4.6, 4.6))
    # FRONT WALL (behind the camera: closes the box, never framed)
    grid((X0, Y1, 0.0), (0, 0, ZC), (w, 0, 0), 1, 1, P["wood_dk"])
    grid((X0, Y1, 0.0), (w, 0, 0), (0, 0, ZC), 1, 1, P["wood_dk"])
    # SIDE WALLS: wainscot + paper under the galleries, paper above, frieze
    L = Y1 - Y0
    for x, f in ((X0, 1), (X1, -1)):
        wall_x(x, Y0, 0.0, L, 1.1, 40, 2, P["wood_dk"], facing=f)
        wall_x(x, Y0, 1.1, L, ZG - 1.1, 36, 3, lambda i, j: paper(i, j, P["paper"], P["paper_b"]), facing=f)
        wall_x(x, Y0, ZG, L, ZC - ZG, 36, 4, lambda i, j: paper(i, j, P["paper_up"], P["paper_upb"]), facing=f)
        box((x + f * 0.05, (Y0 + Y1) / 2, 1.13), (0.08, L, 0.07), P["trim"])
        box((x + f * 0.08, (Y0 + Y1) / 2, ZC - 0.35), (0.14, L, 0.7), P["frieze"])
        pilasters_side(x, f, ZG, ZC - 0.7, (-0.9, 5.6, 12.75, 20.0, 27.0, 34.0, 41.0))
        for k in range(int(L / 1.2)):
            py = Y0 + 0.6 + k * 1.2
            box((x + f * 0.03, py, 0.55), (0.04, 0.9, 0.7), jit(P["wood"], 0.06), skip=("-z", "+x" if f < 0 else "-x"))

def ceiling_and_beams():
    K.ceiling(X0, X1, Y0, Y1, ZC, 11, 25, lambda i, j: jit(P["ceil"], 0.08))
    # cross beams every 4m + knee braces on the gallery posts
    y = Y0 + 2.0
    while y < Y1:
        box(((X0 + X1) / 2, y, ZC - 0.3), (X1 - X0, 0.34, 0.6), jit(P["beam"], 0.06), skip=("+z",), cell=2.0)
        y += 4.0
    # longitudinal beams over the gallery fronts and the free pillars
    for x in (GL, GR, -4.5, 4.5):
        box((x, (Y0 + Y1) / 2, ZC - 0.75), (0.32, Y1 - Y0, 0.3), jit(P["beam"], 0.05), skip=("+z",), cell=3.0)
    for x in (-4.5, 4.5):
        for py in PILLAR_Y:
            for s in (-1, 1):
                beam((x, py + s * 0.25, ZC - 2.1), (x, py + s * 1.6, ZC - 0.85), 0.16, 0.2, P["beam"])

# --- galleries ----------------------------------------------------------------------------
def railing_run(a, b, z, skip):
    """Gallery railing a -> b (horizontal, along x or y) at floor height z."""
    a, b = Vector(a), Vector(b)
    L = (b - a).length
    d = (b - a).normalized()
    along_y = abs(d.y) > 0.5
    n = max(1, int(L / 0.34))
    for k in range(n + 1):
        p = a + d * (L * k / n)
        box((p.x, p.y, z + 0.5), (0.065, 0.065, 0.8), jit(P["wood_mid"], 0.05), skip=skip)
    for zz, hh in ((z + 0.08, 0.1), (z + 0.95, 0.12)):
        if along_y:
            box((a.x, (a.y + b.y) / 2, zz), (0.14, L, hh), P["wood"], cell=3.0)
        else:
            box(((a.x + b.x) / 2, a.y, zz), (L, 0.14, hh), P["wood"], cell=3.0)

def galleries():
    # side gallery slabs: top (walkway), fascia toward the room, underside
    for (xw, xf, f) in ((X0, GL, 1), (X1, GR, -1)):
        x0, x1 = min(xw, xf), max(xw, xf)
        K.floor(x0, x1, BG, Y1, ZG, 3, 24, lambda i, j: jit(P["plank"], 0.1))
        K.ceiling(x0, x1, BG, Y1, ZG - 0.4, 3, 24, lambda i, j: jit(P["ceil"], 0.08))
        wall_x(xf, BG, ZG - 0.4, Y1 - BG, 0.4, 24, 1, P["wood"], facing=f)
        # panel band (the ref's row of squares on the fascia)
        y = BG + 0.6
        while y < Y1 - 0.3:
            box((xf + f * 0.025, y, ZG - 0.2), (0.03, 0.42, 0.26), P["trim"], skip=("-z", "+x" if f < 0 else "-x"))
            y += 1.0
        # joists under the walkway
        y = BG + 1.0
        while y < Y1:
            box(((x0 + x1) / 2, y, ZG - 0.5), (x1 - x0, 0.14, 0.2), P["beam"], skip=("+z",))
            y += 1.5
    # back gallery slab
    K.floor(GL, GR, Y0, BG, ZG, 16, 2, lambda i, j: jit(P["plank"], 0.1))
    K.ceiling(X0, X1, Y0, BG, ZG - 0.4, 16, 2, lambda i, j: jit(P["ceil"], 0.08))
    K.wall(GL, ZG - 0.4, GR - GL, 0.4, BG, 16, 1, P["wood"])
    x = GL + 0.6
    while x < GR - 0.3:
        box((x, BG + 0.025, ZG - 0.2), (0.42, 0.03, 0.26), P["trim"], skip=("-z", "-y"))
        x += 0.75
    # railings (gap where each stair lands on its side gallery)
    railing_run((GL, 0.75, 0), (GL, Y1, 0), ZG, ("-z", "+z", "-x", "-y"))
    railing_run((GR, 0.75, 0), (GR, Y1, 0), ZG, ("-z", "+z", "+x", "-y"))
    railing_run((GL, BG, 0), (GR, BG, 0), ZG, ("-z", "+z", "-y"))
    # posts: floor -> ceiling, rising through the railing
    for py in POST_Y:
        for x in (GL, GR):
            turned(x, py, 0.0, ZC - 0.6, 0.15, jit(P["wood_mid"], 0.05))
            box((x, py, ZG + 1.05), (0.26, 0.26, 0.06), P["wood"])
            cyl((x, py, ZG + 1.08), 0.09, 0.14, 8, P["honey"], r2=0.03)  # finial
            for s in (-1, 1):  # knee braces under the gallery beam
                if BG < py + s * 1.0 < Y1:
                    beam((x, py + s * 0.15, ZG - 1.3), (x, py + s * 1.0, ZG - 0.5), 0.12, 0.14, P["beam"])
    # free-standing pillars (big, square based: the ref's foreground pillars)
    for py in PILLAR_Y:
        for x in (-4.5, 4.5):
            turned(x, py, 0.0, ZC - 0.9, 0.2, jit(P["wood_mid"], 0.04))

def stairs():
    """Two flights from the side galleries down to the middle of the back wall
    (x +-2.6): their stringers make a V around the foe's backdrop."""
    ya, yb = BG + 0.05, BG + 1.35
    for (xb, xt) in ((-2.6, GL), (2.6, GR)):
        s = 1 if xt > xb else -1
        n = 20
        run = abs(xt - xb) / n
        rise = ZG / n
        for k in range(n):
            x = xb + s * (k + 0.5) * run
            z = (k + 1) * rise
            box((x, (ya + yb) / 2, z - 0.025), (run + 0.04, yb - ya, 0.05), jit(P["honey"], 0.08), skip=())
            # riser faces the bottom of the flight (toward the middle)
            box((xb + s * k * run, (ya + yb) / 2, z - rise / 2), (0.03, yb - ya - 0.04, rise),
                jit(P["wood"], 0.06), skip=("-z", "+z"))
        for yy in (ya, yb):
            beam((xb - s * 0.1, yy, -0.1), (xt, yy, ZG - 0.05), 0.07, 0.3, P["wood_dk"])
        # handrail + balusters on the open (camera) side + newel post
        hy = yb + 0.02
        beam((xb, hy, 1.0), (xt, hy, ZG + 1.0), 0.08, 0.09, P["wood"])
        for k in range(n):
            x = xb + s * (k + 0.5) * run
            z = (k + 1) * rise
            box((x, hy, z + 0.5), (0.045, 0.045, 0.95), P["wood_mid"], skip=("-z", "+z", "-y"))
        box((xb, hy, 0.6), (0.2, 0.2, 1.2), P["wood_mid"], cell=0.6)
        cyl((xb, hy, 1.2), 0.11, 0.18, 8, P["honey"], r2=0.04)

# --- the bar (left wall, under the gallery) -----------------------------------------------
def bar():
    y0, y1 = 5.5, 24.0
    xf = -8.95   # counter front
    L = y1 - y0
    yc = (y0 + y1) / 2
    box((xf - 0.32, yc, 0.52), (0.64, L, 1.04), P["wood"], cell=1.0, skip=("-z", "-x"))
    for k in range(int(L / 1.1)):  # raised panels on the front
        py = y0 + 0.55 + k * 1.1
        box((xf + 0.02, py, 0.55), (0.04, 0.8, 0.62), jit(P["wood_mid"], 0.06), skip=("-z", "-x"))
    box((xf - 0.3, yc, 1.09), (0.78, L + 0.1, 0.1), P["wood_dk"], cell=1.5)  # top
    box((xf - 0.38, y1 + 0.05, 0.52), (0.64, 0.1, 1.04), P["wood_dk"])        # end cap
    box((xf + 0.18, yc, 0.16), (0.05, L, 0.05), P["brass"], skip=())          # foot rail
    for k in range(9):
        box((xf + 0.12, y0 + 1 + k * (L - 2) / 8, 0.1), (0.12, 0.03, 0.2), P["brass"])
    # back bar against the wall: cabinet, mirror, shelves of bottles
    xb = X0 + 0.32
    box((xb, yc, 0.5), (0.6, L, 1.0), P["wood_dk"], cell=1.2, skip=("-z", "-x"))
    box((X0 + 0.04, yc, 2.15), (0.06, 10.5, 1.7), P["wood_dk"], skip=("-x",))
    grid((X0 + 0.08, yc + 5.0, 1.42), (0, 0, 1.46), (0, -10.0, 0), 2, 6,
         lambda i, j: mix(P["mirror"], P["mirror_dk"], ((i + j) % 2) * 0.4))
    for zz in (1.35, 2.95):
        box((X0 + 0.2, yc, zz), (0.34, L, 0.06), P["wood"])
    for side in (y0 + 0.3, y1 - 0.3):
        box((X0 + 0.2, side, 2.0), (0.34, 0.1, 2.0), P["wood"])
    # shelves on both sides of the mirror, crowded with bottles
    for (sa, sb) in ((y0 + 0.4, yc - 5.4), (yc + 5.4, y1 - 0.4)):
        for zz in (1.7, 2.3):
            box((X0 + 0.22, (sa + sb) / 2, zz), (0.32, sb - sa, 0.04), P["wood"])
            y = sa + 0.12
            while y < sb - 0.1:
                bottle((X0 + 0.22 + rng.uniform(-0.06, 0.06), y, zz + 0.02), rng.uniform(0.85, 1.15), lo=True)
                y += rng.uniform(0.15, 0.26)
    for k in range(18):  # bottles on the back counter + on the bar top
        bottle((X0 + 0.35 + rng.uniform(-0.1, 0.1), y0 + 0.5 + k * (L - 1) / 17, 1.0), rng.uniform(0.9, 1.2), lo=True)
    for py in (8.4, 12.9, 17.1, 21.6):
        bottle((xf - 0.25, py, 1.14), 1.0)
        glass((xf - 0.15, py + 0.3, 1.14))
    # sign board on the wall above the shelves
    box((X0 + 0.06, yc, 3.45), (0.08, 6.0, 0.62), P["wood_dk"], skip=("-x",))
    text_x("WHISKEY  ·  CIGARS", X0 + 0.11, yc, 3.45, 0.32, P["gold"], facing=1, max_w=5.4)
    # longhorn skull over the sign
    lh_y = yc - 4.6
    box((X0 + 0.1, lh_y, 3.45), (0.1, 0.32, 0.4), P["bone"])
    for s in (-1, 1):
        beam((X0 + 0.14, lh_y + s * 0.12, 3.55), (X0 + 0.25, lh_y + s * 0.85, 3.75), 0.07, 0.07, P["horn"])
        beam((X0 + 0.25, lh_y + s * 0.85, 3.75), (X0 + 0.3, lh_y + s * 1.05, 4.0), 0.05, 0.05, P["horn"])
    # brass lanterns hanging under the gallery over the bar
    for py in (8.0, 14.0, 20.0):
        lantern((-9.6, py, 3.25))
        light((-9.4, py, 3.0), 0.75, 3.4)

def bottle(c, s=1.0, lo=False):
    x, y, z = c
    col = rng.choice((P["green_b"], P["amber"], P["clear"], P["red_b"], P["green_b"]))
    if lo:  # shelf bottles: seen small and side-on
        cyl((x, y, z), 0.035 * s, 0.2 * s, 5, col)
        cyl((x, y, z + 0.2 * s), 0.014 * s, 0.07 * s, 4, col)
        return
    cyl((x, y, z), 0.035 * s, 0.17 * s, 6, col)
    cyl((x, y, z + 0.17 * s), 0.035 * s, 0.05 * s, 6, col, r2=0.013 * s)
    cyl((x, y, z + 0.22 * s), 0.013 * s, 0.06 * s, 5, col)

def glass(c):
    cyl(c, 0.03, 0.08, 6, P["glass_sh"], r2=0.036)

def lantern(c):
    x, y, z = c
    box((x, y, z + 0.7), (0.02, 0.02, 0.9), P["iron"], skip=())
    box((x, y, z + 0.22), (0.2, 0.2, 0.04), P["iron"])
    box((x, y, z - 0.18), (0.2, 0.2, 0.04), P["iron"])
    with into(K.glow()):
        box((x, y, z + 0.02), (0.16, 0.16, 0.36), P["shade"], skip=())

def sconce(c, facing):
    """Wall sconce: plate + arm + glowing tulip shade. facing = outward normal."""
    x, y, z = c
    fx, fy = facing
    box((x, y, z), (0.12 if fy else 0.04, 0.04 if fy else 0.12, 0.26), P["brass"])
    tip = (x + fx * 0.22, y + fy * 0.22, z + 0.08)
    beam((x, y, z), tip, 0.03, 0.03, P["brass"])
    with into(K.glow()):
        cyl((tip[0], tip[1], tip[2]), 0.05, 0.18, 6, P["shade"], r2=0.11, caps=(True, True))
    light((x + fx * 0.35, y + fy * 0.35, z + 0.1), 0.55, 2.4)

# --- furniture ----------------------------------------------------------------------------
def chair(c, a, tipped=False):
    x, y, _ = c
    R = (0, 0, a)
    def rp(dx, dy):
        return (x + dx * math.cos(a) - dy * math.sin(a), y + dx * math.sin(a) + dy * math.cos(a))
    if tipped:  # lying on its back
        box((x, y, 0.22), (0.42, 0.05, 0.42), jit(P["wood_mid"], 0.08), rot=R)
        for dx in (-0.18, 0.18):
            px, py = rp(dx, -0.25)
            box((px, py, 0.03), (0.05, 0.9, 0.05), P["wood"], rot=R)
        return
    box((x, y, 0.46), (0.42, 0.42, 0.05), jit(P["wood_mid"], 0.08), rot=R)
    for dx, dy in ((-0.18, -0.18), (0.18, -0.18), (-0.18, 0.18), (0.18, 0.18)):
        px, py = rp(dx, dy)
        box((px, py, 0.22), (0.04, 0.04, 0.44), P["wood"], rot=R, skip=("-z", "+z"))
    for dx in (-0.18, 0.18):
        px, py = rp(dx, -0.19)
        box((px, py, 0.7), (0.04, 0.04, 0.48), P["wood"], rot=R, skip=("-z",))
    px, py = rp(0, -0.19)
    box((px, py, 0.9), (0.42, 0.04, 0.09), jit(P["wood_mid"], 0.06), rot=R)
    box((px, py, 0.68), (0.36, 0.03, 0.06), P["wood"], rot=R)

def table(c, cloth=None, n_chairs=4, a0=0.0, candle=True, stuff=2):
    x, y, _ = c
    r = 0.58
    if cloth:
        cyl((x, y, 0.74), r, 0.04, 14, P["wood"])
        # drape: a skirt with a ragged hem that hangs lower on two sides
        segs = 14
        for k in range(segs):
            a1, a2 = 2 * math.pi * k / segs, 2 * math.pi * (k + 1) / segs
            h1 = 0.42 + 0.22 * abs(math.sin(a1 * 1.0 + 0.6)) + rng.uniform(-0.04, 0.04)
            h2 = 0.42 + 0.22 * abs(math.sin(a2 * 1.0 + 0.6)) + rng.uniform(-0.04, 0.04)
            p1 = (x + math.cos(a1) * (r + 0.04), y + math.sin(a1) * (r + 0.04))
            p2 = (x + math.cos(a2) * (r + 0.04), y + math.sin(a2) * (r + 0.04))
            q1 = (x + math.cos(a1) * (r + 0.12), y + math.sin(a1) * (r + 0.12))
            q2 = (x + math.cos(a2) * (r + 0.12), y + math.sin(a2) * (r + 0.12))
            oface(((p1[0], p1[1], 0.79), (q1[0], q1[1], 0.79 - h1), (q2[0], q2[1], 0.79 - h2), (p2[0], p2[1], 0.79)),
                  jit(cloth, 0.06), (math.cos((a1 + a2) / 2), math.sin((a1 + a2) / 2), 0))
        cyl((x, y, 0.78), r + 0.04, 0.012, segs, cloth, caps=(False, True))
    else:
        cyl((x, y, 0.72), r, 0.05, 14, jit(P["honey"], 0.06), caps=(False, True))
        cyl((x, y, 0.66), r - 0.04, 0.06, 14, P["wood"], caps=(True, False))
        cyl((x, y, 0.0), 0.06, 0.66, 6, P["wood_dk"])
        for k in range(4):
            a = a0 + k * math.pi / 2 + 0.4
            beam((x, y, 0.08), (x + math.cos(a) * 0.38, y + math.sin(a) * 0.38, 0.02), 0.06, 0.05, P["wood_dk"])
    top = 0.81 if cloth else 0.77
    for k in range(n_chairs):
        a = a0 + k * 2 * math.pi / n_chairs
        cx, cy = x + math.cos(a) * 0.95, y + math.sin(a) * 0.95
        if abs(cx) < 2.9:
            continue
        chair((cx, cy, 0), a - math.pi / 2)
    for k in range(stuff):
        a = rng.uniform(0, 6.28)
        rr = rng.uniform(0.1, 0.35)
        if rng.random() < 0.6:
            bottle((x + math.cos(a) * rr, y + math.sin(a) * rr, top), rng.uniform(0.95, 1.2))
        else:
            glass((x + math.cos(a) * rr, y + math.sin(a) * rr, top))
    if candle:
        cx, cy = x + 0.12, y - 0.1
        cyl((cx, cy, top), 0.045, 0.02, 6, P["brass"], r2=0.05)
        cyl((cx, cy, top + 0.02), 0.022, 0.1, 6, P["wax"])
        with into(K.glow()):
            cone((cx, cy, top + 0.12), 0.02, 0.07, 4, P["flame"], tip_col=P["flame_hot"])
        light((cx, cy, top + 0.25), 0.4, 1.3)

def furniture():
    # (x, y, cloth?) — every chair keeps |x| > 2.9
    tables = [(-5.6, 9.0, None), (-4.6, 14.5, P["cloth"]), (-6.3, 21.0, None), (-5.0, 26.0, None),
              (-6.0, 33.0, P["wine"]), (-5.2, 38.5, None),
              (5.3, 5.2, P["cloth"]), (4.8, 11.0, None), (6.0, 18.0, P["cloth_dk"]), (4.7, 23.5, None),
              (5.8, 31.5, None), (4.9, 36.5, None)]
    for (x, y, cl) in tables:
        table((x, y, 0), cloth=cl, n_chairs=rng.choice((3, 4, 4)), a0=rng.uniform(0, 1.5),
              candle=rng.random() < 0.75, stuff=rng.randint(1, 3))
    chair((3.4, 15.2, 0), 0.4, tipped=True)
    chair((-3.3, 30.0, 0), 2.6, tipped=True)
    # coat draped over a chair back + a hat on a table (ref)
    box((-5.6, 8.0, 0.75), (0.5, 0.06, 0.7), jit(lin(0x4a4a3a), 0.05), rot=(0, 0, 0.2))
    cyl((4.8, 11.2, 0.77), 0.2, 0.02, 10, lin(0x2a2018))
    cyl((4.8, 11.2, 0.79), 0.11, 0.12, 8, lin(0x2a2018))
    # upright piano on the right wall + stool
    px, py = X1 - 0.35, 14.0
    box((px, py, 0.65), (0.6, 1.5, 1.3), P["piano"], skip=("-z", "+x"))
    box((px - 0.42, py, 0.72), (0.28, 1.4, 0.06), P["piano"])
    box((px - 0.5, py, 0.76), (0.12, 1.3, 0.02), P["key_w"])
    for k in range(14):
        box((px - 0.47, py - 0.6 + k * 0.09, 0.785), (0.07, 0.03, 0.02), P["key_b"])
    box((px - 0.2, py, 1.35), (0.25, 1.5, 0.1), P["piano"])
    cyl((px - 1.0, py, 0.0), 0.05, 0.45, 6, P["wood_dk"])
    cyl((px - 1.0, py, 0.45), 0.18, 0.06, 10, P["wine"])
    for k in range(3):
        bottle((px - 0.1, py - 0.5 + k * 0.4, 1.4), 1.0)
    # barrels + crates in the back corners, a card table felt, spittoons
    for (bx, by) in ((-10.6, 1.0), (-10.0, 2.0), (9.6, 26.0), (9.8, 27.0), (-6.4, -2.2), (5.2, -2.3)):
        barrel((bx, by, 0))
    for (bx, by, s) in ((9.7, 2.0, 0.6), (9.7, 2.0 + 0.62, 0.55), (9.8, 2.1, 0.0)):
        if s:
            box((bx, by, s / 2), (s, s, s), jit(P["wood"], 0.1), rot=(0, 0, rng.uniform(-0.2, 0.2)))
    for (sx, sy) in ((-8.6, 9.0), (-8.6, 18.5), (-3.3, 20.0), (3.3, 33.0)):
        cyl((sx, sy, 0.0), 0.12, 0.16, 8, P["brass"], r2=0.1)

def barrel(c):
    x, y, _ = c
    cyl((x, y, 0.0), 0.3, 0.45, 10, jit(P["barrel"], 0.08), r2=0.34, caps=(False, False))
    cyl((x, y, 0.45), 0.34, 0.45, 10, jit(P["barrel"], 0.08), r2=0.3, caps=(False, True))
    for zz in (0.12, 0.45, 0.78):
        cyl((x, y, zz), 0.335 if zz == 0.45 else 0.32, 0.04, 10, P["hoop"], caps=(False, False))

# --- chandeliers, sconces, windows --------------------------------------------------------
def chandelier(c, R=1.15):
    x, y, z = c
    segs = 16
    for k in range(segs):  # wagon-wheel rim
        a1, a2 = 2 * math.pi * k / segs, 2 * math.pi * (k + 1) / segs
        beam((x + math.cos(a1) * R, y + math.sin(a1) * R, z), (x + math.cos(a2) * R, y + math.sin(a2) * R, z),
             0.1, 0.12, P["wood"])
    for k in range(8):
        a = 2 * math.pi * k / 8 + 0.2
        beam((x, y, z), (x + math.cos(a) * R, y + math.sin(a) * R, z), 0.05, 0.06, P["wood_dk"])
    cyl((x, y, z - 0.12), 0.16, 0.24, 8, P["wood_dk"], caps=(True, True))
    for k in range(4):  # chains up to the ceiling ring
        a = 2 * math.pi * k / 4 + 0.6
        beam((x + math.cos(a) * R * 0.95, y + math.sin(a) * R * 0.95, z), (x, y, ZC - 0.62), 0.025, 0.025, P["iron"])
    beam((x, y, z), (x, y, ZC - 0.62), 0.03, 0.03, P["iron"])
    for k in range(12):
        a = 2 * math.pi * k / 12
        cx, cy = x + math.cos(a) * R, y + math.sin(a) * R
        cyl((cx, cy, z + 0.06), 0.03, 0.14, 6, P["wax"])
        with into(K.glow()):
            cone((cx, cy, z + 0.2), 0.026, 0.09, 4, P["flame"], tip_col=P["flame_hot"])
    light((x, y, z - 0.35), 1.25, 6.5)

def lights_fixtures():
    chandelier((0.0, 3.2, 6.5))
    chandelier((0.0, 17.5, 6.7))
    chandelier((0.0, 31.5, 6.7))
    # back wall: a pair under the gallery (clear of the foe's backdrop), a pair above
    for x in (-3.4, 3.4):
        sconce((x, Y0 + 0.06, 2.75), (0, 1))
        sconce((x * 1.5, Y0 + 0.06, 6.7), (0, 1))
    # side walls under the galleries + on the aisle face of the free pillars
    for y in (5.0, 29.0, 37.0):
        sconce((X0 + 0.06, y, 2.6), (1, 0))
    for y in (8.0, 22.0, 32.0, 40.0):
        sconce((X1 - 0.06, y, 2.6), (-1, 0))
    for py in PILLAR_Y[:2]:
        for x, f in ((-4.5, 1), (4.5, -1)):
            sconce((x + f * 0.2, py, 3.0), (f, 0))
    # upper walls
    for y in (6.0, 20.0, 34.0):
        sconce((X0 + 0.06, y, 6.8), (1, 0))
        sconce((X1 - 0.06, y, 6.8), (-1, 0))

# Daylight through the right windows: low and raking toward the camera, so
# each pane lays a long diagonal stripe from the wall toward the aisle (ref).
SUN_TRAVEL = Vector((-0.62, 0.62, -0.3)).normalized()

def window_x(x, yc, z0, w, h, f, arch=False, shaft=False):
    """Window in the side wall plane x (f = +1 left wall facing +x, -1 right).
    Frame + muntins in S_Paint, pane in S_Sky; optional floor light (S_Shaft)."""
    with into(K.sky()):
        pts = [(x + f * 0.012, yc - w / 2, z0), (x + f * 0.012, yc + w / 2, z0),
               (x + f * 0.012, yc + w / 2, z0 + h), (x + f * 0.012, yc - w / 2, z0 + h)]
        if arch:
            top = [(x + f * 0.012, yc + w / 2 * math.cos(math.pi * k / 8), z0 + h + w / 2 * math.sin(math.pi * k / 8))
                   for k in range(9)]
            pts = pts[:2] + top
        oface(pts, (1, 1, 1, 1), (f, 0, 0))
    fw = 0.09
    ff = "+x" if f < 0 else "-x"
    box((x + f * 0.04, yc - w / 2 - fw / 2, z0 + h / 2), (0.08, fw, h), P["wood_dk"], skip=(ff,))
    box((x + f * 0.04, yc + w / 2 + fw / 2, z0 + h / 2), (0.08, fw, h), P["wood_dk"], skip=(ff,))
    box((x + f * 0.07, yc, z0 - 0.06), (0.16, w + 0.3, 0.1), P["trim"])            # sill
    box((x + f * 0.04, yc, z0 + h / 2), (0.05, 0.04, h), P["wood_dk"], skip=(ff,))  # muntins
    for zz in (z0 + h * 0.5,) if not arch else (z0 + h * 0.45, z0 + h):
        box((x + f * 0.04, yc, zz), (0.05, w, 0.04), P["wood_dk"], skip=(ff,))
    if not arch:
        box((x + f * 0.04, yc, z0 + h + 0.06), (0.08, w + 0.2, 0.12), P["wood_dk"], skip=(ff,))
    if shaft:
        light_stripes(x, yc, z0, w, h)

def light_stripes(x, yc, z0, w, h):
    """Floor patches of the four panes + dusty beams (S_Shaft)."""
    L = SUN_TRAVEL
    def hit(p):
        t = p.z / -L.z
        return Vector((p.x + L.x * t, p.y + L.y * t, 0.006))
    warm = lin(0x8a6c44)
    beam_c = lin(0x2c2216)
    g = 0.05
    with into(K.shaft()):
        for (ya, yb) in ((yc - w / 2 + g, yc - g / 2), (yc + g / 2, yc + w / 2 - g)):
            for (za, zb) in ((z0 + g, z0 + h / 2 - g / 2), (z0 + h / 2 + g / 2, z0 + h - g)):
                corners = [Vector((x, ya, za)), Vector((x, yb, za)), Vector((x, yb, zb)), Vector((x, ya, zb))]
                fl = [hit(c) for c in corners]
                oface(fl, warm, (0, 0, 1))
        # beams: top + both side sheets of the whole window's light prism
        wc = [Vector((x, yc - w / 2, z0)), Vector((x, yc + w / 2, z0)),
              Vector((x, yc + w / 2, z0 + h)), Vector((x, yc - w / 2, z0 + h))]
        fl = [hit(c) for c in wc]
        for (a, b) in ((3, 2), (0, 3), (1, 2)):
            q = [wc[a], wc[b], fl[b], fl[a]]
            face(q, beam_c)
            face(list(reversed(q)), beam_c)

def windows():
    # right wall, under the gallery: the sunny side (light stripes on the floor)
    # (the two nearest the long-duel camera throw no stripe: it flared in the
    # bottom-right corner of the frame)
    for y in (3.0, 10.5, 19.5, 26.5, 34.0, 41.0):
        window_x(X1, y, 0.8, 1.5, 2.75, -1, shaft=y < 30)
    # left wall, under the gallery, past the bar
    for y in (1.8, 28.5, 35.5, 42.0):
        window_x(X0, y, 0.95, 1.3, 2.25, 1)
    # upper arched windows on both side walls
    for y in (2.0, 9.0, 16.5, 23.5, 30.5, 37.5):
        window_x(X0, y, 5.3, 1.2, 1.7, 1, arch=True)
        window_x(X1, y, 5.3, 1.2, 1.7, -1, arch=True)

# --- pictures + back-wall dressing ------------------------------------------------------------
def picture(c, w, h, n, kind):
    """Framed painting centred at c on a wall with outward normal n ('+y','+x','-x')."""
    x, y, z = c
    nv = {"+y": Vector((0, 1, 0)), "+x": Vector((1, 0, 0)), "-x": Vector((-1, 0, 0))}[n]
    c0 = Vector(c) + nv * 0.03
    fr = 0.08
    # frame: 4 bars
    U = Vector((0, 0, 1)).cross(nv)
    for (du, dv, sw, sh) in ((0, h / 2 + fr / 2, w + 2 * fr, fr), (0, -h / 2 - fr / 2, w + 2 * fr, fr),
                             (w / 2 + fr / 2, 0, fr, h), (-w / 2 - fr / 2, 0, fr, h)):
        p = c0 + U * du + Vector((0, 0, dv))
        size = (sw, 0.06, sh) if n == "+y" else (0.06, sw, sh)
        box(tuple(p), size, P["gold"])
    # canvas: banded landscape (sky / far hills / ground), a few dark riders
    bands = {"dusk": [(0.0, P["canvas_grass"]), (0.32, P["canvas_hill"]), (0.55, P["canvas_dusk"]), (1.0, None)],
             "day": [(0.0, P["canvas_grass"]), (0.28, P["canvas_hill"]), (0.5, P["canvas_sky"]), (1.0, None)],
             "dark": [(0.0, P["canvas_dark"]), (0.4, scale(P["canvas_hill"], 0.6)), (0.65, scale(P["canvas_dusk"], 0.7)), (1.0, None)]}[kind]
    cc = c0 + nv * 0.035
    for k in range(len(bands) - 1):
        v0, col = bands[k]
        v1 = bands[k + 1][0]
        zc = z - h / 2 + h * (v0 + v1) / 2
        rect(tuple(cc + Vector((0, 0, zc - z))), n, w / 2, h * (v1 - v0) / 2, col)
    for k in range(3):
        du = (k - 1) * w * 0.18 + rng.uniform(-0.05, 0.05)
        p = cc + nv * 0.004 + U * du + Vector((0, 0, -h * 0.22))
        rect(tuple(p), n, w * 0.04, h * 0.09, P["canvas_dark"])

def back_dressing():
    picture((0.0, Y0, 6.6), 3.2, 1.6, "+y", "dusk")       # over the back gallery
    picture((-5.6, Y0, 6.5), 1.2, 0.9, "+y", "day")
    picture((5.6, Y0, 6.5), 1.2, 0.9, "+y", "dark")
    picture((-6.8, Y0, 2.45), 0.9, 0.7, "+y", "day")      # under the gallery, past the stairs
    picture((6.6, Y0, 2.45), 0.9, 0.7, "+y", "dark")
    for (y, kind) in ((12.5, "day"), (26.0, "dusk")):
        picture((X1, y, 6.6), 1.4, 0.9, "-x", kind)
    picture((X0, 13.0, 6.6), 1.4, 0.9, "+x", "dark")
    picture((X0, 27.0, 6.6), 1.6, 1.0, "+x", "day")
    # doors in the back corners (to the back rooms), double, with panels
    for (dx, w) in ((-10.0, 1.4), (9.0, 1.4)):
        box((dx, Y0 + 0.04, 1.2), (w + 0.2, 0.06, 2.45), P["wood_dk"], skip=("-y",))
        for s in (-1, 1):
            box((dx + s * w / 4, Y0 + 0.08, 1.15), (w / 2 - 0.06, 0.04, 2.25), jit(P["wood_mid"], 0.05), skip=("-y",))
            box((dx + s * w / 4, Y0 + 0.11, 1.65), (w / 2 - 0.3, 0.02, 0.6), P["wood"], skip=("-y",))
            box((dx + s * w / 4, Y0 + 0.11, 0.65), (w / 2 - 0.3, 0.02, 0.6), P["wood"], skip=("-y",))
    # wanted posters on the free pillars' plinths (aisle faces)
    for py in PILLAR_Y:
        for x, f in ((-4.5, 1), (4.5, -1)):
            rect((x + f * 0.31, py, 0.55), "+x" if f > 0 else "-x", 0.17, 0.22, jit(P["paper_w"], 0.05))
            rect((x + f * 0.312, py, 0.62), "+x" if f > 0 else "-x", 0.1, 0.04, P["ink"])

# --- baked lamp light ---------------------------------------------------------------------------
def bake_lamps(b, amb=0.62, cap=2.1):
    """Ray-cast point lights into the S_Paint corner colours: warm pools under
    every lamp, shadowed by the geometry (tables, rails, the bar)."""
    bm = b.bm
    bm.normal_update()
    bm.verts.ensure_lookup_table()
    tree = BVHTree.FromBMesh(bm)
    lights = [(Vector((-p.x, p.y, p.z)), i, r, t) for (p, i, r, t) in LIGHTS]   # -> Blender coords
    for f in bm.faces:
        n = f.normal
        ctr = f.calc_center_median()
        for l in f.loops:
            p = l.vert.co.lerp(ctr, 0.05) + n * 0.01
            acc = [amb, amb, amb * 1.04]
            for (lp, li, lr, tint) in lights:
                d = lp - p
                dist = d.length
                if dist > lr * 4.5:
                    continue
                dn = d / max(1e-6, dist)
                ndl = n.dot(dn)
                if ndl <= 0.0:
                    continue
                w = li / (1 + (dist / lr) ** 2) * (0.25 + 0.75 * ndl)
                if w < 0.02:
                    continue
                hit = tree.ray_cast(p, dn, dist - 0.2)
                if hit[0] is not None:
                    continue
                for k in range(3):
                    acc[k] += w * tint[k]
            c = l[b.col]
            l[b.col] = (c[0] * min(cap, acc[0]), c[1] * min(cap, acc[1]), c[2] * min(cap, acc[2]), 1.0)

# --- build ---------------------------------------------------------------------------------------
def build():
    LIGHTS.clear()
    stats = []
    def tri_count():
        return sum(sum(len(f.verts) - 2 for f in b.bm.faces) for b in K.BUCKETS.values())
    for fn in (plank_floor, walls, ceiling_and_beams, galleries, stairs, bar, furniture,
               lights_fixtures, windows, back_dressing):
        t0 = tri_count()
        fn()
        stats.append((fn.__name__, tri_count() - t0))
    print("SALOON tris by section:", stats)
    bake_lamps(K.paint())

K.run("SALOON", build, "Saloon", "saloon.glb",
      bake_kw=dict(sun=False, ground=False, ao_distance=2.5, k_ao=0.6, samples=48), sky=(1, 0, 1))
