"""Deterministic town-street set: code -> public/models/town.glb.

    blender -b --factory-startup --python scripts/blender/build_town.py

Never opens or saves a .blend: the GLB is reproducible from this file alone
(seeded rng; two runs are byte-identical).

THE PLACE (user 2026-10-12, ref: an overcast Red Dead street): the duel runs
straight down a muddy street between two rows of weathered wooden buildings
(two-storey fronts with porches and balconies, false fronts, an adobe jail,
an outside stair), a few lit windows, tall telegraph poles with crossarms on
both kerbs, wires sagging pole to pole and a couple crossing the street high
overhead, street lamps, hitching rails, a trough, a wagon. A two-storey hotel
closes the far end, with an alley beside it; a windmill, a water tower and a
church steeple stand over the rooftops and low hills line the horizon.

COORDS: set_kit SCREEN space (sx right, y toward the camera, z up). Foe at
(0, 9.5, 0), player at y 18.0 .. 35.2, camera at (1.25, player_y + 3.1, 2.05).
The left row's facades sit on x = XL (-8.5, facing +x), the right row's on
x = XR (+8.5, facing -x), both running y -16 .. 46; the hotel's front is the
plane y = YE (-16, facing +y). Facades are authored in a per-row Frame
(u = along the facade, left-to-right as seen from the street; n = out of the
wall; v = up). |x| < 2.5 stays clear (ankle height) for y 8..42, and the end
wall straight behind the foe (x -4.5 .. 0.5, z < 3) is plain mid-tone siding.
Wires all hang at z >= 6, so from the camera (z 2.05) they always project
above the duelists.

OUTPUT NODES: S_Paint (static), S_Glow (lit windows, lanterns, street lamps),
S_Water (puddles), S_Foliage (dry tufts), A_SwingSignL / A_SwingSignR (blade
signs hanging under porch roofs; swing about their hook, Blender X = the
axis across the street). Colour = palette x baked AO x soft (overcast) sun
shadow, in COLOR_0.

Env: TOWN_OUT=<glb path>, TOWN_BAKE=0 (skip the Cycles bake for fast layout
passes), TOWN_EXPORT=0 (build only), TOWN_PREVIEW=<png prefix> (Workbench
renders from the game camera at d 6 / 15 / 25 + a hell-tinted one).
"""
import bpy, bmesh, math, os, sys
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
sys.path.insert(0, HERE)
import set_kit as K  # noqa: E402
from set_kit import lin, jit, mix, scale, box, cyl, face, into, bucket  # noqa: E402

rng = K.rng

P = {k: lin(v) for k, v in dict(
    ground=0x7e705e, street=0x8a7b66, rut=0x5c5043, wet=0x645849, walk_shade=0x6a5d4d,
    w1=0x6f6050, w2=0x7c6a57, w3=0x5d4f42, w4=0x8a7966, w5=0x4e4238,
    red=0x7d4434, green=0x55634f, cream=0xb3a68b, bluegrey=0x5f6a72, ochre=0x9a7a4a,
    end_wall=0x8f7f6a, adobe=0xa58a68, adobe_dk=0x8a7254,
    trim=0x342a22, trim_lt=0xa89a80, post=0x4a3c30, plank=0x6e5c48, plank_dk=0x5a4a3a,
    glass=0x2a3036, glass_lit=0x3b342c, curtain=0x7a3a30, curtain_b=0x6a6248, interior=0x231a14,
    lamp=0xcdbb94,
    iron=0x2a2a2c, pole=0x4f4236, insulator=0x6f9a8a, cable=0x1d1b1a,
    sign_bd=0x3a2e24, sign_txt=0xd8caa6, sign_lt=0xc9b994, sign_ink=0x3a2a1c, gold=0xc79a40,
    barrel=0x6a4c30, hoop=0x2e2a28, crate=0x8a7252, sack=0xb8a47c, water=0x5d646b, trough=0x4f4031,
    tuft=0x8a8150, tuft_g=0x6f6a40, stone=0x6e665c,
    hill_n=0x6e6656, hill_n2=0x7a7060, hill_n3=0x625b4d, hill_f=0x8c8e8e, hill_f2=0x9a9c9a,
    roof=0x4a3f37, roof_lt=0x5c5046, tin=0x7a7f84,
).items()}

XL, XR, YE = -8.5, 8.5, -16.0
DEPTH = 8.0          # building depth behind the facade (side walls, roofs)
WALK = 2.3           # boardwalk depth in front of the facades
WALK_TOP = 0.32

# --- facade frames -------------------------------------------------------------------
class Frame:
    """u = along the facade (viewer's right), n = out of the wall, v = up."""
    def __init__(self, origin, U, N, theta):
        self.o, self.U, self.N, self.theta = Vector(origin), Vector(U), Vector(N), theta

    def p(self, u, n, v):
        return self.o + self.U * u + self.N * n + Vector((0, 0, v))

LEFT = Frame((XL, 0, 0), (0, -1, 0), (1, 0, 0), -math.pi / 2)
RIGHT = Frame((XR, 0, 0), (0, 1, 0), (-1, 0, 0), math.pi / 2)
END = Frame((0, YE, 0), (1, 0, 0), (0, 1, 0), 0.0)

def urange(F, ya, yb):
    """Screen y range of a row building -> its u range (u0 < u1)."""
    if F is LEFT:
        return -yb, -ya
    return ya, yb

def quad(a, b, c, d, col, out):
    """Quad facing `out` whatever order the corners come in."""
    a, b, c, d = Vector(a), Vector(b), Vector(c), Vector(d)
    if (b - a).cross(c - a).dot(Vector(out)) < 0:
        a, b, c, d = d, c, b, a
    face((a, b, c, d), col)

def tri(a, b, c, col, out):
    a, b, c = Vector(a), Vector(b), Vector(c)
    if (b - a).cross(c - a).dot(Vector(out)) < 0:
        a, c = c, a
    face((a, b, c), col)

def fquad(F, u0, u1, v0, v1, n, col):
    quad(F.p(u0, n, v0), F.p(u1, n, v0), F.p(u1, n, v1), F.p(u0, n, v1), col, F.N)

def fbox(F, u, n, v, w, d, h, col, skip=("-z", "-y")):
    """Box centred at frame (u, n, v); w along u, d along n (local -y = into
    the wall), h up."""
    box(F.p(u, n, v), (w, d, h), col, rot=(0, 0, F.theta), skip=skip)

def fsiding(F, u0, u1, v0, v1, col, n=0.0, board=0.3, colw=1.3, amt=0.07):
    """Clapboard: board rows with a thin dark lap-shadow strip under each."""
    rows = max(1, int(round((v1 - v0) / board)))
    bh = (v1 - v0) / rows
    nu = max(1, int(math.ceil((u1 - u0) / colw)))
    lap = min(0.035, bh * 0.2)
    for r in range(rows):
        c = jit(col, amt)
        sh = scale(c, 0.58)
        vb = v0 + r * bh
        for i in range(nu):
            ua, ub = u0 + (u1 - u0) * i / nu, u0 + (u1 - u0) * (i + 1) / nu
            fquad(F, ua, ub, vb, vb + lap, n, sh)
            fquad(F, ua, ub, vb + lap, vb + bh, n, c)

def fplain(F, u0, u1, v0, v1, col, n=0.0, cell=1.4, amt=0.05):
    """Plain plastered / adobe wall with soft tonal patches."""
    nu = max(1, int(math.ceil((u1 - u0) / cell)))
    nv = max(1, int(math.ceil((v1 - v0) / cell)))
    for i in range(nu):
        for j in range(nv):
            ua, ub = u0 + (u1 - u0) * i / nu, u0 + (u1 - u0) * (i + 1) / nu
            va, vb = v0 + (v1 - v0) * j / nv, v0 + (v1 - v0) * (j + 1) / nv
            fquad(F, ua, ub, va, vb, n, jit(col, amt))

def fwindow(F, u, v0, w, h, frame, lit=False, panes=(2, 2), curtain=None, shutters=None, bars=False):
    """Framed sash window proud of the wall. Lit glass goes to S_Glow."""
    fquad(F, u - w / 2 - 0.1, u + w / 2 + 0.1, v0 - 0.1, v0 + h + 0.1, 0.02, frame)
    # lit glass is dark by day too: the runtime emissive makes it glow at dusk/night
    glass = P["glass_lit"] if lit else P["glass"]
    if lit:
        with into(K.glow()):
            fquad(F, u - w / 2, u + w / 2, v0, v0 + h, 0.035, jit(glass, 0.05))
    else:
        fquad(F, u - w / 2, u + w / 2, v0, v0 + h, 0.035, jit(glass, 0.08))
    if curtain:
        cw = w * 0.28
        for s in (-1, 1):
            fquad(F, u + s * (w / 2 - cw / 2) - cw / 2, u + s * (w / 2 - cw / 2) + cw / 2, v0, v0 + h,
                  0.04, jit(curtain, 0.06))
    px, pz = panes
    for i in range(1, px):  # muntins
        uu = u - w / 2 + w * i / px
        fquad(F, uu - 0.025, uu + 0.025, v0, v0 + h, 0.045, frame)
    for j in range(1, pz):
        vv = v0 + h * j / pz
        fquad(F, u - w / 2, u + w / 2, vv - 0.025, vv + 0.025, 0.045, frame)
    if bars:
        for i in range(5):
            uu = u - w / 2 + w * (i + 0.5) / 5
            fquad(F, uu - 0.02, uu + 0.02, v0, v0 + h, 0.055, P["iron"])
    fbox(F, u, 0.07, v0 - 0.13, w + 0.3, 0.14, 0.07, frame, skip=("-y",))  # sill
    fbox(F, u, 0.05, v0 + h + 0.15, w + 0.3, 0.1, 0.1, frame, skip=("-y",))  # head
    if shutters:
        for s in (-1, 1):
            fquad(F, u + s * (w / 2 + 0.12), u + s * (w / 2 + 0.12 + w * 0.48), v0 - 0.05, v0 + h + 0.05,
                  0.03, jit(shutters, 0.05))
            for k in range(4):
                vv = v0 + h * (k + 0.5) / 4
                us = u + s * (w / 2 + 0.12 + w * 0.24)
                fquad(F, us - w * 0.2, us + w * 0.2, vv - 0.015, vv + 0.015, 0.04, scale(shutters, 0.6))

def fdoor(F, u, v0, w, h, frame, panel, open_=False, lamp=False):
    fquad(F, u - w / 2 - 0.12, u + w / 2 + 0.12, v0, v0 + h + 0.12, 0.02, frame)
    if open_:
        fquad(F, u - w / 2, u + w / 2, v0, v0 + h, 0.03, P["interior"])
        # half-open leaf
        a = F.p(u - w / 2, 0.03, v0)
        b = F.p(u - w / 2 + 0.25, 0.03 + w * 0.42, v0)
        quad(a, b, b + Vector((0, 0, h)), a + Vector((0, 0, h)), jit(panel, 0.06), F.U + F.N)
    else:
        fquad(F, u - w / 2, u + w / 2, v0, v0 + h, 0.03, jit(panel, 0.05))
        for (va, vb) in ((0.2, 0.45), (0.55, 0.9)):
            for s in (-1, 1):
                uc = u + s * w * 0.22
                fquad(F, uc - w * 0.17, uc + w * 0.17, v0 + h * va, v0 + h * vb, 0.04, scale(panel, 0.8))
        fbox(F, u + w * 0.36, 0.06, v0 + h * 0.48, 0.05, 0.05, 0.05, P["gold"], skip=("-y",))
    if lamp:
        with into(K.glow()):
            fbox(F, u + w / 2 + 0.38, 0.14, v0 + 2.3, 0.15, 0.15, 0.22, P["lamp"], skip=("-y",))
        fbox(F, u + w / 2 + 0.38, 0.14, v0 + 2.46, 0.2, 0.2, 0.08, P["iron"], skip=("-y",))
        fbox(F, u + w / 2 + 0.38, 0.07, v0 + 2.18, 0.05, 0.14, 0.04, P["iron"], skip=("-y",))

def fboardwalk(F, u0, u1, depth=WALK, top=WALK_TOP, steps=True):
    """Plank walk in front of the facade: planks run out from the wall."""
    n = max(1, int(round((u1 - u0) / 0.32)))
    w = (u1 - u0) / n
    for i in range(n):
        c = jit(P["plank"], 0.12)
        ua, ub = u0 + i * w, u0 + (i + 1) * w
        quad(F.p(ua, 0, top), F.p(ub, 0, top), F.p(ub, depth, top), F.p(ua, depth, top), c, (0, 0, 1))
    m = max(1, int(math.ceil((u1 - u0) / 1.5)))
    for i in range(m):  # front edge board + dark gap under it
        ua, ub = u0 + (u1 - u0) * i / m, u0 + (u1 - u0) * (i + 1) / m
        fquad(F, ua, ub, top - 0.12, top, depth, jit(P["plank_dk"], 0.06))
        fquad(F, ua, ub, 0.0, top - 0.12, depth - 0.04, scale(P["plank_dk"], 0.45))
    if steps:
        for uu in (u0, u1):  # end steps where the walk meets the mud
            s = 1 if uu == u1 else -1
            fbox(F, uu + s * 0.25, depth / 2, 0.08, 0.5, depth - 0.1, 0.16, jit(P["plank_dk"], 0.08), skip=("-z",))

def fporch(F, u0, u1, v_roof, depth=WALK, post_col=None, roof_col=None, balcony=False, rail_col=None,
           post_us=None):
    post_col = post_col or P["post"]
    roof_col = roof_col or P["roof"]
    L = u1 - u0
    um = (u0 + u1) / 2
    # roof slab (seen from below: keep its underside)
    fbox(F, um, depth / 2, v_roof, L, depth, 0.12, jit(roof_col, 0.05), skip=("-y",))
    fbox(F, um, depth - 0.02, v_roof - 0.08, L, 0.06, 0.3, jit(scale(post_col, 0.9), 0.05), skip=("-y",))  # fascia
    if post_us is None:
        k = max(1, int(round(L / 2.9)))
        post_us = [u0 + 0.15 + (L - 0.3) * i / k for i in range(k + 1)]
    for uu in post_us:
        fbox(F, uu, depth - 0.18, (v_roof + WALK_TOP) / 2, 0.16, 0.16, v_roof - WALK_TOP, jit(post_col, 0.08),
             skip=("-z",))
        for s in (-1, 1):  # corner braces (flat strips facing the street)
            if (s < 0 and uu - 0.5 < u0) or (s > 0 and uu + 0.5 > u1):
                continue
            a = F.p(uu, depth - 0.1, v_roof - 0.55)
            b = F.p(uu + s * 0.5, depth - 0.1, v_roof - 0.06)
            quad(a, b, b + Vector((0, 0, 0.09)), a + Vector((0, 0, 0.09)), post_col, F.N)
    if balcony:
        rc = rail_col or post_col
        vr = v_roof + 0.06
        fbox(F, um, depth - 0.12, vr + 1.0, L, 0.08, 0.08, jit(rc, 0.05), skip=())
        fbox(F, um, depth - 0.12, vr + 0.18, L, 0.06, 0.06, jit(rc, 0.05), skip=())
        n = max(2, int(round(L / 0.34)))
        for i in range(n + 1):
            fbox(F, u0 + 0.1 + (L - 0.2) * i / n, depth - 0.12, vr + 0.6, 0.05, 0.05, 0.8, rc, skip=("-z", "+z"))
        for uu in post_us:  # balcony posts carry on up to a top rail / roof edge
            fbox(F, uu, depth - 0.18, vr + 0.6, 0.12, 0.12, 1.2, jit(post_col, 0.08), skip=("-z",))

def fcornice(F, u0, u1, v, col, d=0.35, h=0.28):
    fbox(F, (u0 + u1) / 2, d / 2, v + h / 2, u1 - u0 + 0.3, d, h, jit(col, 0.04), skip=("-y",))
    fbox(F, (u0 + u1) / 2, d / 2 + 0.04, v - 0.08, u1 - u0 + 0.1, d - 0.08, 0.12, scale(col, 0.75), skip=("-y",))

# --- text on a frame ---------------------------------------------------------------------
def glyphs(s, height, max_w=None, res=2, spacing=1.0):
    cu = bpy.data.curves.new("tmp_txt", "FONT")
    cu.body, cu.font, cu.size, cu.resolution_u = s, K.font(), 1.0, res
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
        return []
    minx, maxx = min(v.x for v in vs), max(v.x for v in vs)
    miny, maxy = min(v.y for v in vs), max(v.y for v in vs)
    k = height / max(1e-6, (maxy - miny))
    if max_w and (maxx - minx) * k > max_w:
        k = max_w / (maxx - minx)
    mx, my = (minx + maxx) / 2, (miny + maxy) / 2
    return [[((vs[i].x - mx) * k, (vs[i].y - my) * k) for i in poly] for poly in polys]

def ftext(F, s, u, n, v, height, col, max_w=None, res=2):
    for poly in glyphs(s, height, max_w, res):
        pts = [F.p(u + gx, n, v + gy) for gx, gy in poly]
        if len(pts) >= 3:
            face(list(reversed(pts)), col)

def fsign(F, u, v, w, h, text, bd=None, txt=None, n=0.0, th=None, res=2):
    """Fascia sign board on the facade with raised lettering."""
    bd = bd or P["sign_bd"]
    txt = txt or P["sign_txt"]
    fbox(F, u, n + 0.06, v, w, 0.12, h, jit(bd, 0.04), skip=("-y",))
    fquad(F, u - w / 2 + 0.06, u + w / 2 - 0.06, v - h / 2 + 0.06, v + h / 2 - 0.06, n + 0.125, scale(bd, 0.8))
    ftext(F, text, u, n + 0.13, v, th or h * 0.52, txt, max_w=w - 0.35, res=res)

# --- side walls (alley-facing +y sides of the row buildings) ---------------------------
def side_wall(F, ya, yb, h, col, roof=None):
    """The +y-facing side of a row building ending at screen y = yb."""
    if F is END:
        return
    x0, x1 = (XL - DEPTH, XL) if F is LEFT else (XR, XR + DEPTH)
    rows = max(1, int(round(h / 0.45)))
    for r in range(rows):
        z0, z1 = h * r / rows, h * (r + 1) / rows
        c = jit(col, 0.06)
        for i in range(4):
            xa, xb = x0 + (x1 - x0) * i / 4, x0 + (x1 - x0) * (i + 1) / 4
            quad((xa, yb, z0), (xb, yb, z0), (xb, yb, z1), (xa, yb, z1), c, (0, 1, 0))

# --- buildings ------------------------------------------------------------------------------
def storefront(F, u0, u1, wall, trim, lit_ground=False, door_lamp=False, open_door=False, curtains=None,
               v_top=3.25, goods_windows=2):
    """Ground storey: big display windows either side of a centred door."""
    um = (u0 + u1) / 2
    fdoor(F, um, WALK_TOP, 1.15, 2.35, trim, scale(wall, 0.7), open_=open_door, lamp=door_lamp)
    span = (u1 - u0) / 2 - 0.9
    for s in (-1, 1):
        for k in range(goods_windows):
            cu = um + s * (0.9 + span * (k + 0.5) / goods_windows)
            fwindow(F, cu, 0.85, min(1.5, span / goods_windows - 0.45), 1.75, trim, lit=lit_ground and k == 0,
                    panes=(2, 3), curtain=curtains)

def b_balcony(F, ya, yb, wall, trim, name, sign_col=None, lit=(False, True), height=7.0, top="flat",
              open_door=False, lamp=True, sign_y=None, post_us=None, porch=None):
    u0, u1 = urange(F, ya, yb)
    um = (u0 + u1) / 2
    fsiding(F, u0, u1, 0.0, height, wall)
    porch = porch or (u0, u1)
    storefront(F, u0, u1, wall, trim, lit_ground=lit[0], door_lamp=lamp, open_door=open_door,
               curtains=P["curtain_b"])
    fporch(F, porch[0], porch[1], 3.25, balcony=True, rail_col=trim, post_us=post_us)
    # upper floor: windows + a balcony door
    n = max(2, int((u1 - u0) // 2.4))
    for i in range(n):
        cu = u0 + (u1 - u0) * (i + 0.5) / n
        if i == n // 2:
            fdoor(F, cu, 3.4, 0.95, 2.2, trim, scale(wall, 0.6))
        else:
            fwindow(F, cu, 4.25, 0.9, 1.35, trim, lit=lit[1] and i % 2 == 0, panes=(2, 2),
                    curtain=P["curtain"] if i % 3 == 1 else None)
    fcornice(F, u0, u1, height, trim)
    if top == "flat":
        fsiding(F, u0, u1, height + 0.28, height + 1.3, wall, board=0.32)
        fbox(F, um, 0.12, height + 1.38, u1 - u0 + 0.2, 0.24, 0.16, trim, skip=("-y",))
        fsign(F, um, height + 0.8, min(u1 - u0 - 1.0, 6.5), 0.75, name, bd=sign_col)
    elif top == "pitch":
        pitched_roof(F, u0, u1, height + 0.28, 2.2)
        fsign(F, um, 3.95 if False else height - 0.45, min(u1 - u0 - 1.2, 6.0), 0.6, name, bd=sign_col, res=1)
    side_wall(F, ya, yb, height + (1.3 if top == "flat" else 0.3), wall)

def pitched_roof(F, u0, u1, v_eave, rise, back=4.5):
    """Roof slope rising away from the street (visible from the low camera)."""
    for i in range(int(math.ceil((u1 - u0) / 1.2))):
        ua = u0 + (u1 - u0) * i / math.ceil((u1 - u0) / 1.2)
        ub = u0 + (u1 - u0) * (i + 1) / math.ceil((u1 - u0) / 1.2)
        c = jit(P["roof"], 0.1)
        a, b = F.p(ua - 0.2 * (i == 0), 0.45, v_eave), F.p(ub + 0.2 * (ub >= u1 - 1e-6), 0.45, v_eave)
        c2, d = F.p(ub + 0.2 * (ub >= u1 - 1e-6), -back, v_eave + rise), F.p(ua - 0.2 * (i == 0), -back, v_eave + rise)
        quad(a, b, c2, d, c, F.N + Vector((0, 0, 1.5)))
    # eave board
    fbox(F, (u0 + u1) / 2, 0.42, v_eave - 0.04, u1 - u0 + 0.4, 0.08, 0.18, P["trim"], skip=())

def b_false(F, ya, yb, wall, trim, name, h=4.1, ff=5.9, sign_col=None, lit=False, step=True, open_door=False,
            lamp=False, porch=True, post_us=None):
    u0, u1 = urange(F, ya, yb)
    um = (u0 + u1) / 2
    fsiding(F, u0, u1, 0.0, h, wall)
    # false front: flat or stepped top
    if step:
        fsiding(F, u0, u1, h, ff - 0.5, wall, board=0.32)
        fsiding(F, u0 + 0.9, u1 - 0.9, ff - 0.5, ff, wall, board=0.32)
        fbox(F, um, 0.1, ff + 0.06, u1 - u0 - 1.6, 0.2, 0.12, trim, skip=("-y",))
        for s in (-1, 1):
            fbox(F, um + s * ((u1 - u0) / 2 - 0.45), 0.1, ff - 0.44, 0.95, 0.2, 0.12, trim, skip=("-y",))
    else:
        fsiding(F, u0, u1, h, ff, wall, board=0.32)
        fbox(F, um, 0.1, ff + 0.06, u1 - u0 + 0.1, 0.2, 0.12, trim, skip=("-y",))
    fsign(F, um, h + 0.75, min(u1 - u0 - 0.9, 6.4), 0.85, name, bd=sign_col)
    fdoor(F, um - (u1 - u0) * 0.18, WALK_TOP, 1.05, 2.3, trim, scale(wall, 0.65), open_=open_door, lamp=lamp)
    fwindow(F, um + (u1 - u0) * 0.2, 0.9, min(1.6, (u1 - u0) * 0.3), 1.6, trim, lit=lit, panes=(2, 2),
            curtain=P["curtain"] if lit else None)
    if (u1 - u0) > 6.5:
        fwindow(F, u0 + 0.9, 1.0, 0.8, 1.4, trim, panes=(1, 2), shutters=scale(wall, 0.75))
    if porch:
        fporch(F, u0, u1, 3.0, roof_col=P["roof_lt"], post_us=post_us)
    side_wall(F, ya, yb, ff, wall)

def b_plain2(F, ya, yb, wall, trim, name=None, height=6.6, lit=(False, True), stair=True, gable=True,
             awning=True):
    u0, u1 = urange(F, ya, yb)
    um = (u0 + u1) / 2
    fsiding(F, u0, u1, 0.0, height, wall)
    if gable:  # triangular gable end facing the street
        apex = height + 2.3
        n = 8
        for r in range(n):
            va, vb = height + (apex - height) * r / n, height + (apex - height) * (r + 1) / n
            wa = (u1 - u0) / 2 * (1 - r / n)
            wb = (u1 - u0) / 2 * (1 - (r + 1) / n)
            c = jit(wall, 0.06)
            quad(F.p(um - wa, 0, va), F.p(um + wa, 0, va), F.p(um + wb, 0, vb), F.p(um - wb, 0, vb), c, F.N)
        for s in (-1, 1):  # barge boards along the gable edges
            a, b = F.p(um + s * ((u1 - u0) / 2 + 0.25), 0.1, height - 0.12), F.p(um, 0.1, apex + 0.12)
            quad(a, b, b + Vector((0, 0, 0.24)), a + Vector((0, 0, 0.24)), trim, F.N)
        fwindow(F, um, height + 0.35, 0.7, 0.9, trim, lit=False, panes=(1, 1))
    else:
        fcornice(F, u0, u1, height, trim)
    fdoor(F, u0 + 1.1, WALK_TOP, 1.0, 2.3, trim, scale(wall, 0.65))
    fwindow(F, um + 0.6, 0.95, 1.2, 1.5, trim, panes=(2, 2), shutters=scale(wall, 0.7))
    if u1 - u0 > 7:
        fwindow(F, u1 - 1.2, 0.95, 1.0, 1.5, trim, panes=(2, 2))
    for i, cu in enumerate((u0 + (u1 - u0) * 0.42, u0 + (u1 - u0) * 0.75)):
        fwindow(F, cu, 4.0, 0.85, 1.3, trim, lit=lit[1] and i == 0, panes=(2, 2),
                curtain=P["curtain"] if i == 0 else None)
    if name:
        fsign(F, um, 3.2, min(u1 - u0 - 1.6, 5.2), 0.55, name, res=1)
    if awning:
        fbox(F, u0 + 1.1, 0.6, 2.95, 1.8, 1.2, 0.08, P["roof_lt"], skip=())
    if stair:  # outside stair climbing the facade to an upper door
        sa, sb = um - 0.2, u1 - 0.5
        steps = 12
        for k in range(steps):
            t0 = k / steps
            uu = sa + (sb - sa) * (k + 0.5) / steps
            vv = WALK_TOP + (3.3 - WALK_TOP) * (k + 1) / steps
            fbox(F, uu, 1.55, vv - 0.04, (sb - sa) / steps + 0.03, 0.9, 0.06, jit(P["plank"], 0.1), skip=())
        fbox(F, u1 - 0.5, 1.55, 3.28, 1.0, 1.0, 0.1, P["plank_dk"], skip=())  # landing
        fbox(F, u1 - 0.12, 1.95, 1.8, 0.12, 0.12, 3.5, P["post"], skip=("-z",))
        fbox(F, u1 - 0.12, 1.1, 1.8, 0.12, 0.12, 3.5, P["post"], skip=("-z",))
        # stringer + hand rail as tilted quads
        for (nn, dv, th) in ((2.02, 0.0, 0.22), (2.02, 0.95, 0.06)):
            a0, a1 = F.p(sa, nn, WALK_TOP + dv), F.p(sb, nn, 3.3 + dv)
            quad(a0, a1, a1 + Vector((0, 0, th)), a0 + Vector((0, 0, th)), P["trim"], F.N)
        for k in range(0, steps + 1, 3):
            uu = sa + (sb - sa) * k / steps
            vv = WALK_TOP + (3.3 - WALK_TOP) * k / steps
            fbox(F, uu, 2.02, vv + 0.5, 0.05, 0.05, 0.95, P["trim"], skip=("-z", "+z"))
        fdoor(F, u1 - 0.55, 3.38, 0.85, 2.0, trim, scale(wall, 0.6))
    side_wall(F, ya, yb, height + 0.3, wall)

def b_adobe(F, ya, yb, name, lit=True):
    u0, u1 = urange(F, ya, yb)
    um = (u0 + u1) / 2
    h = 4.6
    fplain(F, u0, u1, 0.0, h, P["adobe"])
    fplain(F, u0, u1, 0.0, 0.45, P["adobe_dk"], n=0.01)
    # stepped parapet
    fplain(F, u0 + 0.6, u1 - 0.6, h, h + 0.7, P["adobe"])
    fplain(F, um - 1.2, um + 1.2, h + 0.7, h + 1.15, P["adobe"])
    for k in range(int((u1 - u0) / 1.1)):  # viga ends under the roof line
        uu = u0 + 0.6 + k * 1.1
        if uu > u1 - 0.4:
            break
        fbox(F, uu, 0.25, h - 0.45, 0.16, 0.5, 0.16, P["post"], skip=("-y",))
    fdoor(F, um, WALK_TOP, 1.1, 2.35, P["trim"], lin(0x4a3424), lamp=True)
    for s in (-1, 1):
        fwindow(F, um + s * (u1 - u0) * 0.3, 1.2, 0.85, 1.0, P["trim"], lit=lit and s < 0, panes=(1, 1), bars=True)
    fsign(F, um, 3.35, 3.4, 0.62, name, bd=P["sign_lt"], txt=P["sign_ink"], res=1)
    # star badge over the door
    side_wall(F, ya, yb, h + 0.7, P["adobe"])

# --- the street furniture ----------------------------------------------------------------------
def barrel(c, r=0.3, h=0.86):
    x, y, z = c
    cyl((x, y, z), r * 0.92, h, 9, jit(P["barrel"], 0.1), r2=r * 0.92, top_col=scale(P["barrel"], 0.7))
    for zz in (0.12, h - 0.16):
        cyl((x, y, z + zz), r * 0.95, 0.05, 9, P["hoop"], caps=(False, False))

def crate(c, s, rot=0.0):
    x, y, z = c
    box((x, y, z + s / 2), (s, s, s), jit(P["crate"], 0.1), rot=(0, 0, rot), cell=None)
    box((x, y, z + s / 2), (s + 0.02, s * 0.2, s + 0.02), scale(P["crate"], 0.75), rot=(0, 0, rot))

def sack(c, s=0.34):
    x, y, z = c
    box((x, y, z + s * 0.45), (s, s * 0.8, s * 0.9), jit(P["sack"], 0.08), rot=(0, rng.uniform(-0.15, 0.15), 0))
    box((x, y, z + s * 0.98), (s * 0.45, s * 0.4, s * 0.2), jit(P["sack"], 0.12))

def hitch_rail(x, ya, yb):
    for yy in (ya, yb):
        box((x, yy, 0.5), (0.12, 0.12, 1.0), jit(P["post"], 0.08), skip=("-z",))
    box((x, (ya + yb) / 2, 0.92), (0.1, abs(yb - ya) + 0.2, 0.1), jit(P["post"], 0.06), skip=())

def trough(x, y, length=2.0):
    box((x, y, 0.32), (0.62, length, 0.6), jit(P["trough"], 0.06), skip=("-z",))
    box((x, y, 0.6), (0.48, length - 0.14, 0.02), P["water"], skip=("-z",))
    for s in (-1, 1):
        box((x, y + s * (length / 2 - 0.1), 0.15), (0.7, 0.1, 0.3), P["trim"], skip=("-z",))

def tuft(c, s=0.35):
    x, y, z = c
    col = P["tuft"] if rng.random() < 0.6 else P["tuft_g"]
    with into(K.foliage()):
        for k in range(5):
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

def wheel(c, r, axis_x=True, col=None):
    """Wagon wheel: rim disc faces +-x (axle across the street)."""
    col = col or P["post"]
    x, y, z = c
    rot = (0, math.pi / 2, 0) if axis_x else (math.pi / 2, 0, 0)
    cyl((x - 0.04, y, z), r, 0.08, 14, jit(col, 0.06), rot=rot, caps=(True, True))
    cyl((x - 0.07, y, z), r * 0.18, 0.14, 8, P["hoop"], rot=rot, caps=(True, True))

def wagon(cx, cy):
    bed = P["crate"]
    box((cx, cy, 1.0), (1.5, 3.4, 0.12), jit(bed, 0.06), skip=())
    for s in (-1, 1):
        box((cx + s * 0.72, cy, 1.3), (0.06, 3.4, 0.5), jit(bed, 0.08), skip=())
    box((cx, cy - 1.67, 1.3), (1.5, 0.06, 0.5), jit(bed, 0.08), skip=())
    box((cx, cy + 1.67, 1.3), (1.5, 0.06, 0.5), jit(bed, 0.08), skip=())
    for s in (-1, 1):
        for (yy, r) in ((cy - 1.15, 0.62), (cy + 1.15, 0.78)):
            wheel((cx + s * 0.86, yy, r), r)
    box((cx, cy - 2.6, 0.62), (0.08, 2.2, 0.08), P["post"], rot=(0.25, 0, 0), skip=())  # tongue
    sack((cx - 0.3, cy + 0.6, 1.06))
    sack((cx + 0.25, cy + 0.2, 1.06))
    crate((cx + 0.2, cy - 0.9, 1.06), 0.55, 0.2)
    # canvas bow + sheet over the front half
    for k in range(3):
        yy = cy - 1.0 + k * 0.5
        box((cx, yy, 2.15), (1.55, 0.05, 0.05), P["trim"], skip=())
    with into(K.paint()):
        cs = lin(0xc8bba0)
        for s in (-1, 1):
            quad((cx + s * 0.75, cy - 1.15, 1.55), (cx + s * 0.75, cy + 0.15, 1.55),
                 (cx + s * 0.55, cy + 0.15, 2.18), (cx + s * 0.55, cy - 1.15, 2.18), jit(cs, 0.05), (s, 0, 0.4))
        quad((cx - 0.55, cy - 1.15, 2.18), (cx + 0.55, cy - 1.15, 2.18), (cx + 0.55, cy + 0.15, 2.18),
             (cx - 0.55, cy + 0.15, 2.18), jit(cs, 0.05), (0, 0, 1))

# --- poles + wires ----------------------------------------------------------------------------
LEFT_POLES = [(-6.75, y) for y in (-13.0, -2.0, 9.0, 20.0, 31.0, 42.0)]
RIGHT_POLES = [(6.75, y) for y in (-8.0, 3.0, 14.0, 25.0, 36.0, 47.0)]
ARM1, ARM2 = 8.05, 7.45
INS1 = (-0.8, -0.3, 0.3, 0.8)
INS2 = (-0.55, 0.55)

def pole(x, y, h=8.6, second=False):
    lean = (rng.uniform(-0.02, 0.02), rng.uniform(-0.02, 0.02))
    cyl((x, y, 0.0), 0.15, h, 7, jit(P["pole"], 0.06), r2=0.11, rot=(lean[0], lean[1], 0))
    top = lambda z: Vector((x + lean[1] * z, y - lean[0] * z, z))  # noqa: E731
    pts = []
    for (z, ins, L) in ((ARM1, INS1, 1.95), (ARM2, INS2, 1.4)) if second else ((ARM1, INS1, 1.95),):
        c = top(z)
        box(c, (L, 0.12, 0.13), jit(P["pole"], 0.05), skip=())
        for s in (-1, 1):  # diagonal braces
            box(c + Vector((s * 0.32, 0, -0.3)), (0.05, 0.05, 0.62), P["iron"], rot=(0, s * 0.75, 0), skip=())
        for dx in ins:
            p = c + Vector((dx, 0, 0.065))
            cyl(p, 0.045, 0.13, 6, P["insulator"], r2=0.03)
            pts.append(p + Vector((0, 0, 0.12)))
    # step pegs
    for k in range(5):
        zz = 2.4 + k * 0.85
        box(top(zz) + Vector((0.15 * (1 if k % 2 else -1), 0, 0)), (0.28, 0.04, 0.04), P["iron"], skip=())
    return pts

def wires():
    lp = [pole(x, y, second=(i % 2 == 0)) for i, (x, y) in enumerate(LEFT_POLES)]
    rp = [pole(x, y, h=8.9, second=(i % 2 == 1)) for i, (x, y) in enumerate(RIGHT_POLES)]
    for row in (lp, rp):
        for a, b in zip(row, row[1:]):
            for i in range(min(len(a), len(b))):
                sag = 0.42 + 0.06 * i + rng.uniform(0, 0.12)
                K.wire(a[i], b[i], sag, 0.04, P["cable"], segs=9)
    # crossings (high: the lowest point stays above z 6)
    K.wire(lp[1][0], rp[1][3], 0.75, 0.04, P["cable"], segs=10)     # y -2 -> 3, beyond the foe
    K.wire(lp[3][1], rp[2][2], 0.8, 0.04, P["cable"], segs=10)      # y 20 -> 14
    K.wire(lp[4][3], rp[4][0], 0.7, 0.04, P["cable"], segs=10)      # y 31 -> 36
    # house drops onto the facades
    K.wire(rp[0][0], (2.2, YE + 0.25, 6.7), 0.35, 0.035, P["cable"], segs=8)
    box((2.2, YE + 0.18, 6.7), (0.08, 0.3, 0.08), P["iron"], skip=())
    K.wire(lp[2][3], (XL + 0.2, 4.0, 6.6), 0.3, 0.035, P["cable"], segs=6)
    box((XL + 0.12, 4.0, 6.6), (0.25, 0.08, 0.08), P["iron"], skip=())
    K.wire(rp[3][3], (XR - 0.2, 21.0, 6.5), 0.3, 0.035, P["cable"], segs=6)
    box((XR - 0.12, 21.0, 6.5), (0.25, 0.08, 0.08), P["iron"], skip=())

def street_lamp(x, y):
    cyl((x, y, 0.0), 0.07, 3.3, 6, P["iron"], r2=0.05)
    cyl((x, y, 0.0), 0.16, 0.25, 6, P["iron"], r2=0.1)
    box((x, y, 3.32), (0.3, 0.3, 0.06), P["iron"], skip=())
    with into(K.glow()):
        box((x, y, 3.52), (0.26, 0.26, 0.34), P["lamp"], skip=("-z", "+z"))
    cyl((x, y, 3.69), 0.22, 0.18, 4, P["iron"], r2=0.03, rot=(0, 0, math.pi / 4), caps=(True, False))

# --- ground ----------------------------------------------------------------------------------------
RUTS = (-2.65, -1.15, 1.35, 2.85)

def ground():
    xs = set()
    for x in range(-40, -11, 4):
        xs.add(float(x))
    for x in (-12.0, -10.5, -9.5):
        xs.add(x)
    x = -9.0
    while x <= 9.0 + 1e-6:
        xs.add(round(x, 3))
        x += 0.5
    for x in (9.5, 10.5, 12.0):
        xs.add(x)
    for x in range(16, 41, 4):
        xs.add(float(x))
    for c in RUTS:
        for d in (-0.2, 0.0, 0.2):
            xs.add(round(c + d, 3))
    xs = sorted(xs)
    ys = []
    y = -28.0
    while y <= 48.0 + 1e-6:
        ys.append(round(y, 3))
        y += 1.4
    x0, x1, y0, y1 = xs[0], xs[-1], ys[0], ys[-1]
    G, S = P["ground"], P["street"]

    def col(x, y):
        # wet / trodden mottling
        n = (math.sin(x * 0.61 + y * 0.23) * 0.5 + math.sin(x * 0.17 - y * 0.41 + 1.7) * 0.5
             + 0.6 * math.sin(x * 1.3 + y * 0.9) * math.sin(y * 0.31 - x * 0.2))
        c = S
        if n > 0.55:
            c = mix(S, P["wet"], min(1.0, (n - 0.55) * 2.2))
        elif n < -0.6:
            c = mix(S, lin(0x958670), min(1.0, (-n - 0.6) * 2.0))
        for r in RUTS:
            d = abs(x - r)
            if d < 0.2 + 1e-6:
                c = mix(c, P["rut"], 0.85 * (1 - d / 0.2) + 0.15)
        if abs(x) > 6.0:  # darker, damper mud along the walks
            c = mix(c, P["walk_shade"], min(1.0, (abs(x) - 6.0) / 2.0) * 0.6)
        # edges melt exactly into the arena plane colour
        e = min((x - x0) / 10.0, (x1 - x) / 10.0, (y - y0) / 6.0, (y1 - y) / 4.0)
        w = max(0.0, min(1.0, e))
        return mix(G, c, w)

    b = K.CUR[0]
    vs = [[b.bm.verts.new(K.to_b((x, y, 0.004), b)) for y in ys] for x in xs]
    for i in range(len(xs) - 1):
        for j in range(len(ys) - 1):
            f = b.bm.faces.new((vs[i][j], vs[i][j + 1], vs[i + 1][j + 1], vs[i + 1][j]))
            # mirror flips the winding: this order faces +z in Blender
            for l in f.loops:
                co = l.vert.co
                l[b.col] = col(-co.x + b.pivot[0], co.y + b.pivot[1])
    # puddles
    with into(K.water()):
        for (px, py, r) in ((1.9, 2.0, 0.9), (-3.6, -6.0, 1.3), (3.4, 19.0, 0.8), (-1.6, 29.0, 0.7),
                            (4.6, -11.0, 1.1), (-4.6, 12.0, 0.6)):
            n = 11
            pts = []
            for k in range(n):
                a = 2 * math.pi * k / n
                rr = r * (0.75 + rng.random() * 0.45)
                pts.append(Vector((px + math.cos(a) * rr * 1.3, py + math.sin(a) * rr * 0.8, 0.012)))
            ctr = Vector((px, py, 0.012))
            for k in range(n):
                tri(ctr, pts[k], pts[(k + 1) % n], jit(P["water"], 0.05), (0, 0, 1))

# --- skyline -----------------------------------------------------------------------------------------
def ridge(y, x0, x1, n, hf, cols, rows=4):
    xs = [x0 + (x1 - x0) * i / n for i in range(n + 1)]
    hs = [hf(x) for x in xs]
    for i in range(n):
        xa, xb, ha, hb = xs[i], xs[i + 1], hs[i], hs[i + 1]
        if ha <= 0.05 and hb <= 0.05:
            continue
        for r in range(rows):
            za0, za1 = -1 + (ha + 1) * r / rows, -1 + (ha + 1) * (r + 1) / rows
            zb0, zb1 = -1 + (hb + 1) * r / rows, -1 + (hb + 1) * (r + 1) / rows
            quad((xa, y, za0), (xb, y, zb0), (xb, y, zb1), (xa, y, za1), cols[r % len(cols)], (0, 1, 0))

def hills():
    r = K.random.Random(77)
    bumps_n = [(r.uniform(-230, 230), r.uniform(25, 60), r.uniform(8, 20)) for _ in range(14)]
    bumps_f = [(r.uniform(-300, 300), r.uniform(50, 110), r.uniform(18, 34)) for _ in range(10)]

    def prof(bumps, base):
        def hf(x):
            h = base
            for (cx, w, hh) in bumps:
                d = (x - cx) / w
                if abs(d) < 1:
                    h = max(h, hh * (1 - d * d) ** 1.4)
            return h + 0.8 * math.sin(x * 0.11) + 0.5 * math.sin(x * 0.37 + 1.0)
        return hf
    ridge(-200.0, -340, 340, 90, prof(bumps_f, 10.0), [P["hill_f"], P["hill_f2"], P["hill_f"]], rows=3)
    ridge(-115.0, -260, 260, 120, prof(bumps_n, 5.0), [P["hill_n3"], P["hill_n"], P["hill_n2"], P["hill_n"]],
          rows=5)

def windmill(x, y, top=13.0):
    for s in (-1, 1):
        for t in (-1, 1):
            box((x + s * 0.9, y + t * 0.9, top / 2 - 0.5), (0.14, 0.14, top - 1.0), P["post"],
                rot=(t * -0.07, s * 0.07, 0), skip=())
    for zz in (2.5, 6.0, 9.5):
        box((x, y + 0.9, zz), (1.9 - zz * 0.09, 0.08, 0.08), P["post"], skip=())
    box((x, y, top), (0.5, 0.5, 0.5), P["trim"], skip=())
    for k in range(14):
        a = 2 * math.pi * k / 14
        box((x + math.cos(a) * 1.1, y + 0.35, top + math.sin(a) * 1.1), (0.2, 0.04, 1.7), P["tin"],
            rot=(0, a + math.pi / 2, 0), skip=())
    box((x + 1.8, y + 0.2, top), (1.8, 0.04, 0.6), P["tin"], skip=())

def water_tower(x, y):
    for s in (-1, 1):
        for t in (-1, 1):
            box((x + s * 1.2, y + t * 1.2, 4.0), (0.18, 0.18, 8.0), P["post"], rot=(t * -0.04, s * 0.04, 0), skip=())
    for zz in (2.5, 5.5):
        box((x, y + 1.25, zz), (2.6, 0.08, 0.1), P["post"], skip=())
    cyl((x, y, 8.0), 1.9, 2.8, 12, jit(P["w2"], 0.05), caps=(True, False))
    for zz in (8.5, 9.6, 10.5):
        cyl((x, y, zz), 1.93, 0.08, 12, P["hoop"], caps=(False, False))
    cyl((x, y, 10.8), 2.05, 1.0, 12, P["roof"], r2=0.12)

def steeple(x, y):
    box((x, y, 4.5), (5.0, 5.0, 9.0), lin(0xc9c0ae), skip=("-z",), cell=2.5)
    box((x, y, 11.0), (2.0, 2.0, 4.0), lin(0xd2c9b6), skip=("-z",))
    box((x, y + 1.01, 11.4), (0.8, 0.02, 1.3), P["interior"], skip=("-y",))
    cyl((x, y, 13.0), 1.5, 3.4, 4, P["roof"], r2=0.03, rot=(0, 0, math.pi / 4))
    box((x, y, 17.0), (0.12, 0.12, 1.2), P["iron"], skip=())
    box((x, y, 17.2), (0.6, 0.12, 0.12), P["iron"], skip=())

# --- swinging blade signs ------------------------------------------------------------------------------
def blade_sign(name, hook, out_x, text_s):
    """Sign board hanging under a porch roof, its faces toward the camera
    (+y). hook = screen point it swings from; out_x = +1 / -1 street side."""
    hx, hy, hz = hook
    box((hx, hy, hz + 0.04), (1.2, 0.07, 0.07), P["iron"], skip=())  # bracket (static)
    with into(bucket(name, "M_Paint", pivot=hook)):
        for s in (-1, 1):
            box((hx + s * 0.38, hy, hz - 0.12), (0.03, 0.03, 0.24), P["iron"], skip=())
        box((hx, hy, hz - 0.52), (1.05, 0.06, 0.56), jit(P["sign_lt"], 0.04), skip=())
        box((hx, hy, hz - 0.52), (1.13, 0.05, 0.64), P["sign_bd"], skip=())
        K.text(text_s, hx, hy + 0.035, hz - 0.52, 0.24, P["sign_ink"], max_w=0.85, res=1)

# --- build ---------------------------------------------------------------------------------------------------
def chimney(x, y, z, r=0.14, h=1.2):
    cyl((x, y, z), r, h, 7, P["iron"], caps=(False, True))
    cyl((x, y, z + h), r * 1.6, 0.1, 7, P["iron"], r2=r * 1.6, caps=(True, True))

def build():
    K.seed(1887)
    ground()

    # ===== LEFT ROW (facades x = XL, facing +x) ================================
    F = LEFT
    b_balcony(F, -16.0, -2.4, P["w2"], P["trim"], "BOARDING HOUSE", sign_col=lin(0x5a3428), lit=(True, True),
              height=7.1, lamp=True)
    fboardwalk(F, *urange(F, -16.0, -2.4))
    b_false(F, 0.0, 8.0, P["green"], P["trim_lt"], "GUNSMITH", sign_col=P["sign_bd"], lit=False, lamp=True,
            step=True)
    fboardwalk(F, *urange(F, 0.0, 8.0))
    b_plain2(F, 8.0, 17.0, P["w4"], P["trim"], name="ASSAY", height=6.6, stair=True)
    fboardwalk(F, *urange(F, 8.0, 17.0))
    b_balcony(F, 19.2, 28.2, P["red"], P["trim_lt"], "SALOON", sign_col=P["sign_bd"], lit=(True, True),
              height=7.3, open_door=True)
    fboardwalk(F, *urange(F, 19.2, 28.2))
    b_false(F, 28.2, 35.0, P["w1"], P["trim"], "BARBER", sign_col=lin(0x2e4a3a), lit=True, step=False)
    fboardwalk(F, *urange(F, 28.2, 35.0))
    b_plain2(F, 36.6, 46.0, P["w3"], P["trim"], height=6.2, stair=False, gable=True, awning=True)
    fboardwalk(F, *urange(F, 36.6, 46.0))

    # ===== RIGHT ROW (facades x = XR, facing -x) ===============================
    F = RIGHT
    b_false(F, -16.0, -7.0, P["bluegrey"], P["trim_lt"], "TELEGRAPH", sign_col=P["sign_bd"], lit=True,
            lamp=True, step=True)
    fboardwalk(F, *urange(F, -16.0, -7.0))
    b_balcony(F, -7.0, 5.0, P["w4"], P["trim"], "HOTEL ROOMS", sign_col=lin(0x3a3f4a), lit=(False, True),
              height=7.4, top="flat", lamp=False)
    fboardwalk(F, *urange(F, -7.0, 5.0))
    b_adobe(F, 7.4, 15.4, "SHERIFF")
    fboardwalk(F, *urange(F, 7.4, 15.4))
    b_balcony(F, 15.4, 25.0, P["cream"], P["trim"], "GENERAL STORE", sign_col=lin(0x5a3a26), lit=(True, False),
              height=7.0, top="pitch", lamp=True)
    fboardwalk(F, *urange(F, 15.4, 25.0))
    b_false(F, 27.0, 35.5, P["w5"], P["trim_lt"], "UNDERTAKER", sign_col=lin(0x221c18), lit=False, step=True)
    fboardwalk(F, *urange(F, 27.0, 35.5))
    b_plain2(F, 35.5, 46.0, P["ochre"], P["trim"], height=6.4, stair=False, gable=False, awning=True)
    fboardwalk(F, *urange(F, 35.5, 46.0))

    # ===== FAR END: two-storey hotel + livery, alley between ==================
    F = END
    u0, u1 = -16.0, 2.6
    fsiding(F, u0, u1, 0.0, 7.6, P["end_wall"])
    # porch + balcony only left of the duel line; the wall behind the foe stays plain
    fporch(F, -16.0, -5.4, 3.25, balcony=True, rail_col=P["trim"], post_us=[-15.8, -12.4, -9.0, -5.6])
    fdoor(F, -10.7, WALK_TOP, 1.2, 2.4, P["trim"], lin(0x4a3a2c), lamp=True)
    fwindow(F, -13.9, 0.95, 1.4, 1.7, P["trim"], lit=True, panes=(2, 3), curtain=P["curtain"])
    fwindow(F, -7.3, 0.95, 1.4, 1.7, P["trim"], panes=(2, 3))
    fwindow(F, 1.5, 1.0, 0.9, 1.5, P["trim"], panes=(2, 2), shutters=lin(0x4f5a48))
    for i, cu in enumerate((-14.3, -11.6, -8.9, -6.2, -3.0, -0.2)):
        fwindow(F, cu, 4.3, 0.9, 1.4, P["trim"], lit=(i in (1, 4)), panes=(2, 2),
                curtain=P["curtain"] if i in (1, 3) else None)
    fcornice(F, u0, u1, 7.6, P["trim"])
    fsiding(F, -12.0, -1.4, 7.88, 9.1, P["end_wall"], board=0.32)
    fbox(F, -6.7, 0.12, 9.18, 10.8, 0.24, 0.16, P["trim"], skip=("-y",))
    fsign(F, -6.7, 8.5, 7.0, 0.95, "GRAND HOTEL", bd=lin(0x5a2a22), txt=P["sign_txt"])
    fboardwalk(F, u0, u1, depth=2.0, steps=True)
    # livery (red barn front) right of the alley
    u0, u1 = 5.6, 16.0
    fsiding(F, u0, u1, 0.0, 5.0, lin(0x7a3a2e), board=0.34)
    for i in range(9):  # stepped gable top
        w = (u1 - u0) * (1 - i / 9)
        fbox(F, (u0 + u1) / 2, 0.05, 5.0 + i * 0.2 + 0.1, w, 0.1, 0.2, jit(lin(0x7a3a2e), 0.05), skip=("-y", "-z"))
    for s in (-1, 1):
        cu = 10.4 + s * 0.85
        fquad(F, cu - 0.8, cu + 0.8, 0.0, 3.0, 0.04, jit(lin(0x6e3328), 0.05))
        for vv in (0.4, 1.5, 2.6):
            fquad(F, cu - 0.8, cu + 0.8, vv - 0.06, vv + 0.06, 0.06, lin(0xd8ccb4))
    fquad(F, 9.55, 11.25, 3.3, 4.2, 0.04, P["trim"])
    ftext(F, "LIVERY", 10.4, 0.07, 3.75, 0.36, P["sign_txt"], max_w=1.5)
    # side of the livery facing the alley (x = 5.6, faces -x)
    K.wall_x(5.6, YE - DEPTH, 0.0, DEPTH, 5.0, 4, 6, jit(lin(0x6e3328), 0.05), facing=-1)
    fboardwalk(F, u0, u1, depth=1.6)
    # alley: fence + gate partway back, crates
    for k in range(10):
        box((2.75 + k * 0.29, YE - 5.0, 0.95), (0.24, 0.05, 1.9 + rng.uniform(-0.15, 0.1)),
            jit(P["w4"], 0.12), skip=("-z",))
    box((4.1, YE - 4.95, 1.4), (3.0, 0.05, 0.1), P["post"], skip=())
    crate((4.6, YE - 1.2, 0.0), 0.6, 0.3)
    crate((4.5, YE - 1.3, 0.6), 0.45, 0.1)
    barrel((3.4, YE - 0.8, 0.0))

    # stovepipes over the rooftops (silhouettes against the overcast)
    # (behind a facade 3m deep the pipe top must clear ~facade + 2m to show)
    for (x, y, z, h) in ((-11.5, -8.0, 8.0, 3.0), (-11.0, 12.0, 6.4, 3.4), (-11.0, 24.0, 8.2, 3.0),
                         (11.2, -1.0, 8.3, 3.2), (-6.0, -19.0, 8.8, 1.6), (11.0, -19.5, 5.6, 1.8)):
        chimney(x, y, z, h=h)

    # ===== skyline landmarks ==================================================
    windmill(-11.5, -26.0, top=13.5)
    water_tower(11.0, -25.0)
    steeple(-4.5, -46.0)
    hills()

    # ===== poles, wires, lamps ==================================================
    wires()
    for (x, y) in ((-6.3, -6.0), (-6.3, 15.4), (6.3, 6.6), (6.3, 31.0)):
        street_lamp(x, y)

    # ===== street furniture (|x| < 2.5 stays clear for y 8..42) =================
    hitch_rail(-5.7, 2.2, 5.2)
    hitch_rail(5.7, -4.5, -1.5)
    hitch_rail(5.7, 17.0, 20.0)
    hitch_rail(-5.7, 21.0, 24.0)
    trough(-5.4, 11.8)
    trough(5.3, 26.0, 1.6)
    wagon(4.6, -10.5)
    for (x, y) in ((-7.4, -4.0), (-7.0, -3.4), (7.3, 9.0), (-7.4, 30.5), (7.4, 22.5), (-7.6, 18.2)):
        barrel((x, y, WALK_TOP))
    for (x, y, s, r) in ((7.4, 12.6, 0.55, 0.2), (7.5, 13.2, 0.45, -0.3), (-7.5, 26.2, 0.6, 0.1),
                         (7.3, -12.0, 0.5, 0.4)):
        crate((x, y, WALK_TOP), s, r)
    crate((7.4, 12.8, WALK_TOP + 0.55), 0.4, 0.5)
    for (x, y) in ((-7.3, 8.6), (-7.0, 8.9), (7.2, 34.0)):
        sack((x, y, WALK_TOP))
    # benches on the walks
    for (x, y, F) in ((-7.6, -9.5, LEFT), (7.6, 1.0, RIGHT), (-7.6, 32.0, LEFT)):
        box((x, y, 0.75), (0.45, 1.6, 0.06), jit(P["plank"], 0.08), skip=())
        for s in (-1, 1):
            box((x, y + s * 0.7, 0.53), (0.4, 0.06, 0.42), P["trim"], skip=())
    # stones + dry tufts at the kerbs and in the alleys (never on the duel line)
    for k in range(40):
        side = -1 if rng.random() < 0.5 else 1
        x = side * rng.uniform(5.6, 6.4)
        y = rng.uniform(-15.0, 45.0)
        tuft((x, y, 0.0), rng.uniform(0.22, 0.42))
    for (x, y) in ((-8.2, 18.2), (-8.0, 35.8), (8.3, 6.3), (8.2, 26.0), (-8.3, -1.2), (3.8, YE - 2.5)):
        for k in range(3):
            tuft((x + rng.uniform(-0.4, 0.4), y + rng.uniform(-0.4, 0.4), 0.0), rng.uniform(0.3, 0.5))
    for k in range(14):
        x = rng.choice((rng.uniform(-5.8, -3.2), rng.uniform(3.2, 5.8)))
        y = rng.uniform(-14.0, 44.0)
        K.rock((x, y, 0.0), rng.uniform(0.06, 0.14), P["stone"], segs=5)

    # ===== swinging blade signs (A_*) ===============================================
    blade_sign("A_SwingSignL", (XL + 1.55, 4.0, 2.94), 1, "GUNS")
    blade_sign("A_SwingSignR", (XR - 1.75, 3.6, 3.19), -1, "ROOMS")

K.run("TOWN", build, "Town", "town.glb", bake_kw=dict(k_sh=0.25), sky=(0.55, 0.58, 0.62))
