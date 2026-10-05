"""Deterministic hell-set build: code -> public/models/hell.glb.

    npm run build:hell   # = blender -b --factory-startup --python this

Like build_street.py: never opens or saves a .blend, everything is generated
here, so the GLB is reproducible from this file alone (seeded rng).

THE PLACE (user 2026-10-05: a hell map with no relation to the street): a
black basalt causeway runs down the duel line over a lava sea; hexagonal
basalt columns rise from the lava on both sides; past the foe the causeway
ends at a round dais under two curved obsidian horns holding a molten ring;
volcanoes with glowing craters line the horizon. The lava sea, sky dome,
eclipse and the rune hexes under the duelists stay runtime shaders in
render/hell.ts (they animate / depend on the round's distance).

COORDS (Blender): origin = the FOE's feet, +Y = down the duel line away from
the player (behind the foe), +X = across, Z up. Anchored on the foe so the
gate always stands the same few metres behind it whatever the round's
distance (duels are 6-25m: the player stands at y ~ -8.5 .. -25.7, the
camera ~3m further back). The causeway top is EXACTLY z=0 (the game's
ground, ragdoll and hit-capsule plane); keep |x| < 3.6 between camera and
foe clear of props.

OUTPUT NODES: `X_Paint` (static vertex-coloured rock, Lambert in game) and
`X_Glow` (fissures, ring, craters, lava rivulets: unlit + fog-free in game).
Colour = palette * baked AO, in COLOR_0.

Env: HELL_OUT=<glb path>, HELL_BAKE=0 (skip the Cycles AO bake),
HELL_EXPORT=0 (build only).
"""
import bpy, bmesh, math, os, random, sys
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
sys.path.insert(0, HERE)
from glb_util import lin, jit, material, reset_collection, export, slim_glb  # noqa: E402

BAKE = os.environ.get("HELL_BAKE", "1") != "0"
EXPORT = os.environ.get("HELL_EXPORT", "1") != "0"
OUT = os.environ.get("HELL_OUT") or os.path.normpath(
    os.path.join(HERE, "..", "..", "public", "models", "hell.glb"))
rng = random.Random(666)

P = {k: lin(v) for k, v in dict(
    basalt=0x3a2826, basalt_dk=0x231816, basalt_lt=0x54403a, edge=0x2a1a17,
    hot=0x7a2a14, ember=0xb8401a, obsidian=0x17100f, obsidian_lt=0x2c1d1b,
    column=0x2e201d, column_top=0x4a3631, ash=0x5a4a46,
    volcano=0x1c0e0c, volcano_hot=0x5a1a0c,
    glow=0xff6a1c, glow_hot=0xffb04a, glow_dk=0xd2400e,
).items()}

# --- buckets ------------------------------------------------------------------
class Bucket:
    def __init__(self, name, mat):
        self.name, self.mat = name, mat
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new("Col")

PAINT = Bucket("X_Paint", "M_Paint")
GLOW = Bucket("X_Glow", "M_Glow")

def face(b, pts, cols):
    """pts CCW seen from outside. cols: one colour or one per point."""
    vs = [b.bm.verts.new(Vector(p)) for p in pts]
    f = b.bm.faces.new(vs)
    for i, l in enumerate(f.loops):
        l[b.col] = cols[i] if isinstance(cols, list) else cols
    return f

def mix(a, c, t):
    return tuple(a[i] + (c[i] - a[i]) * t for i in range(3)) + (1.0,)

# --- primitives ---------------------------------------------------------------
def prism(b, c, r, z0, z1, segs, side_col, top_col, rot=0.0, bot_col=None, r_top=None):
    """Vertical n-gon prism (top cap, no bottom). bot_col tints the base ring."""
    r_top = r if r_top is None else r_top
    ring = [(math.cos(rot + 2 * math.pi * i / segs), math.sin(rot + 2 * math.pi * i / segs)) for i in range(segs)]
    bot = [(c[0] + x * r, c[1] + y * r, z0) for x, y in ring]
    top = [(c[0] + x * r_top, c[1] + y * r_top, z1) for x, y in ring]
    bc = bot_col or side_col
    for i in range(segs):
        j = (i + 1) % segs
        face(b, [bot[i], bot[j], top[j], top[i]], [bc, bc, side_col, side_col])
    face(b, top, top_col)

def rock(b, c, s, col, segs=6):
    """Low-poly lump sitting on z=c[2]."""
    pts = []
    for i in range(segs):
        a = 2 * math.pi * i / segs + rng.random() * 0.5
        rr = s * (0.75 + rng.random() * 0.5)
        pts.append((c[0] + math.cos(a) * rr, c[1] + math.sin(a) * rr, c[2] + s * (0.2 + rng.random() * 0.25)))
    base = [(c[0] + (p[0] - c[0]) * 1.15, c[1] + (p[1] - c[1]) * 1.15, c[2] - 0.05) for p in pts]
    top = (c[0] + rng.uniform(-0.2, 0.2) * s, c[1] + rng.uniform(-0.2, 0.2) * s, c[2] + s * (0.55 + rng.random() * 0.4))
    for i in range(segs):
        j = (i + 1) % segs
        face(b, [pts[i], pts[j], top], jit(col, 0.12, rng))
        face(b, [base[i], base[j], pts[j], pts[i]], jit(col, 0.1, rng))

def spike(b, c, r, h, lean, col, tip_col, segs=4):
    """Leaning shard: base ring at c, apex offset by lean (dx, dy)."""
    rot = rng.random() * math.pi
    ring = [(c[0] + math.cos(rot + 2 * math.pi * i / segs) * r, c[1] + math.sin(rot + 2 * math.pi * i / segs) * r, c[2])
            for i in range(segs)]
    apex = (c[0] + lean[0], c[1] + lean[1], c[2] + h)
    for i in range(segs):
        j = (i + 1) % segs
        face(b, [ring[i], ring[j], apex], [col, col, tip_col])

def tube(b, path, radii, segs, cols, close_tip=True):
    """Swept n-gon along a polyline (horns). radii/cols per path point."""
    rings = []
    for k, p in enumerate(path):
        p = Vector(p)
        t = (Vector(path[min(k + 1, len(path) - 1)]) - Vector(path[max(k - 1, 0)])).normalized()
        u = t.orthogonal().normalized()
        v = t.cross(u)
        rings.append([p + (u * math.cos(2 * math.pi * i / segs) + v * math.sin(2 * math.pi * i / segs)) * radii[k]
                      for i in range(segs)])
    for k in range(len(rings) - 1):
        for i in range(segs):
            j = (i + 1) % segs
            face(b, [rings[k][i], rings[k][j], rings[k + 1][j], rings[k + 1][i]], [cols[k], cols[k], cols[k + 1], cols[k + 1]])
    if close_tip:
        face(b, rings[-1], cols[-1])

def torus_xz(b, c, R, r, nu, nv, col):
    """Ring standing in the XZ plane (faces the camera down -Y)."""
    def pt(i, j):
        a = 2 * math.pi * i / nu
        q = 2 * math.pi * j / nv
        rr = R + r * math.cos(q)
        return (c[0] + rr * math.cos(a), c[1] + r * math.sin(q), c[2] + rr * math.sin(a))
    for i in range(nu):
        for j in range(nv):
            i2, j2 = (i + 1) % nu, (j + 1) % nv
            face(b, [pt(i, j), pt(i2, j), pt(i2, j2), pt(i, j2)], col)

def strip(b, a, c, w, z, col):
    """Flat glowing strip on the plane z from a to c (xy)."""
    d = Vector((c[0] - a[0], c[1] - a[1], 0))
    n = Vector((-d.y, d.x, 0)).normalized() * (w / 2)
    face(b, [(a[0] - n.x, a[1] - n.y, z), (c[0] - n.x, c[1] - n.y, z), (c[0] + n.x, c[1] + n.y, z), (a[0] + n.x, a[1] + n.y, z)], col)

# --- the set ------------------------------------------------------------------
CW = 3.75          # causeway half-width
Y0, Y1 = -62.0, 6.0     # from well behind the farthest camera to just past the foe
DAIS_Y, DAIS_R = 12.0, 7.0
GATE_Y = 14.0

def causeway():
    nu, nv = 8, int(Y1 - Y0)
    # Jagged edge: each row's outer x wanders, shared by the top and the sides.
    edge = [(CW + rng.uniform(-0.15, 0.35), CW + rng.uniform(-0.15, 0.35)) for _ in range(nv + 1)]
    def top_pt(i, j):
        y = Y0 + (Y1 - Y0) * j / nv
        l, r = edge[j]
        x = -l + (l + r) * i / nu
        return (x, y, 0.0)
    def top_col(x):
        k = abs(x) / CW
        base = jit(P["basalt"], 0.18, rng)
        return mix(base, P["edge"], max(0.0, k - 0.6) * 1.6)
    for j in range(nv):
        for i in range(nu):
            pts = [top_pt(i, j), top_pt(i + 1, j), top_pt(i + 1, j + 1), top_pt(i, j + 1)]
            face(PAINT, pts, [top_col(p[0]) for p in pts])
    # Sides: slant out into the lava, glowing hot near the waterline.
    for s in (-1, 1):
        for j in range(nv):
            ya, yb = Y0 + (Y1 - Y0) * j / nv, Y0 + (Y1 - Y0) * (j + 1) / nv
            xa = s * (edge[j][1] if s > 0 else edge[j][0])
            xb = s * (edge[j + 1][1] if s > 0 else edge[j + 1][0])
            top = [(xa, ya, 0.0), (xb, yb, 0.0)]
            mid = [(xa + s * 0.35, ya, -0.9), (xb + s * 0.35, yb, -0.9)]
            low = [(xa + s * 0.8, ya, -3.0), (xb + s * 0.8, yb, -3.0)]
            c_top, c_mid, c_low = jit(P["basalt_dk"], 0.15, rng), jit(P["basalt_dk"], 0.1, rng), P["hot"]
            quad1 = [top[0], mid[0], mid[1], top[1]]
            quad2 = [mid[0], low[0], low[1], mid[1]]
            if s < 0:
                quad1.reverse(); quad2.reverse()
                face(PAINT, quad1, [c_top, c_mid, c_mid, c_top][::-1])
                face(PAINT, quad2, [c_mid, c_low, c_low, c_mid][::-1])
            else:
                face(PAINT, quad1, [c_top, c_mid, c_mid, c_top])
                face(PAINT, quad2, [c_mid, c_low, c_low, c_mid])
    # Near end cap (far behind the camera, never seen) skipped; far end meets the dais.

def dais():
    prism(PAINT, (0, DAIS_Y), DAIS_R, -3.0, 0.06, 9, P["basalt_dk"], P["basalt_lt"], rot=0.17, bot_col=P["hot"])
    # Inlaid glowing rune ring (a 9-gon band just above the top).
    for i in range(9):
        a0, a1 = 0.17 + 2 * math.pi * i / 9, 0.17 + 2 * math.pi * (i + 1) / 9
        r0, r1 = 4.4, 4.7
        p = lambda a, r: (math.cos(a) * r, DAIS_Y + math.sin(a) * r, 0.065)
        face(GLOW, [p(a0, r0), p(a1, r0), p(a1, r1), p(a0, r1)], P["glow_dk"])

def horns():
    for s in (-1, 1):
        n = 12
        path, radii, cols = [], [], []
        for k in range(n + 1):
            t = k / n
            # Rise, bow outward, then hook back in over the ring.
            x = s * (5.6 + 1.4 * math.sin(t * math.pi * 0.9) - 4.4 * t * t)
            z = 14.0 * t
            y = GATE_Y + 0.6 * math.sin(t * math.pi)
            path.append((x, y, z))
            radii.append(1.35 * (1 - t) ** 1.1 + 0.04)
            cols.append(mix(P["obsidian"], P["obsidian_lt"], t * 0.8) if t > 0.08 else P["hot"])
        tube(PAINT, path, radii, 6, cols)
        # Rubble at the horn base.
        for _ in range(5):
            rock(PAINT, (s * (5.6 + rng.uniform(-1.4, 1.4)), GATE_Y + rng.uniform(-1.5, 1.5), 0.06), rng.uniform(0.35, 0.7), P["basalt_dk"])
    torus_xz(GLOW, (0, GATE_Y, 7.2), 3.3, 0.22, 40, 8, P["glow"])
    # Molten drips hanging under the ring.
    for i in range(7):
        a = math.pi * (1.25 + 0.5 * i / 6)
        x, z = 3.3 * math.cos(a), 7.2 + 3.3 * math.sin(a)
        L = rng.uniform(0.4, 1.1)
        face(GLOW, [(x - 0.05, GATE_Y - 0.01, z), (x + 0.05, GATE_Y - 0.01, z), (x, GATE_Y - 0.01, z - L)], P["glow_hot"])

def columns():
    for i in range(70):
        s = -1 if i % 2 == 0 else 1
        x = s * (CW + 1.6 + rng.random() ** 1.4 * 34)
        y = Y0 + 14 + rng.random() * (Y1 - Y0 + 50)
        r = 0.6 + rng.random() * 1.3
        top = -0.6 + rng.random() ** 1.6 * 9 * min(1.0, abs(x) / 9)
        c = jit(P["column"], 0.2, rng)
        prism(PAINT, (x, y), r, -1.6, top, 6, c, jit(P["column_top"], 0.15, rng), rot=rng.random() * math.pi, bot_col=P["hot"])
        # Some columns cluster: a short neighbour.
        if rng.random() < 0.35:
            a = rng.random() * math.tau
            prism(PAINT, (x + math.cos(a) * r * 1.7, y + math.sin(a) * r * 1.7), r * 0.6, -1.6, top * rng.uniform(0.4, 0.8), 6,
                  c, jit(P["column_top"], 0.15, rng), rot=rng.random() * math.pi, bot_col=P["hot"])

def edges():
    # Rubble + obsidian shards along both causeway edges, ahead of the camera
    # (|x| >= 3.2, never inside the duel strip).
    for _ in range(60):
        s = rng.choice((-1, 1))
        rock(PAINT, (s * rng.uniform(3.2, 4.1), rng.uniform(-30, 5.5), 0.0), rng.uniform(0.15, 0.45), P["basalt_dk"])
    for _ in range(22):
        s = rng.choice((-1, 1))
        y = rng.uniform(-28, 5)
        spike(PAINT, (s * rng.uniform(3.7, 4.3), y, -0.2), rng.uniform(0.18, 0.35), rng.uniform(0.9, 2.6),
              (s * rng.uniform(0.2, 0.8), rng.uniform(-0.3, 0.3)), P["obsidian"], P["obsidian_lt"])

def fissures():
    for _ in range(40):
        x = rng.uniform(-3.0, 3.0)
        y = rng.uniform(-40, 5)
        a = rng.uniform(-0.7, 0.7) + math.pi / 2
        L = rng.uniform(0.6, 2.4)
        # Zig-zag crack in 3 segments, slightly tapered.
        pts = [(x, y)]
        for k in range(3):
            aa = a + rng.uniform(-0.6, 0.6)
            px, py = pts[-1]
            pts.append((px + math.cos(aa) * L / 3, py + math.sin(aa) * L / 3))
        for k in range(3):
            strip(GLOW, pts[k], pts[k + 1], 0.09 - 0.02 * k, 0.004, P["glow"] if k == 0 else P["glow_dk"])

def volcanoes():
    for i in range(7):
        a = -1.15 + (i / 6) * 2.3 + rng.uniform(-0.08, 0.08)
        d = 150 + rng.random() * 70
        R = 28 + rng.random() * 26
        H = 22 + rng.random() * 26
        cx, cy = math.sin(a) * d, math.cos(a) * d
        segs = 14
        crater = R * 0.12
        rings = [(R, -1.3), (R * 0.55, H * 0.55), (crater, H)]
        prev = None
        for (rr, z) in rings:
            ring = [(cx + math.cos(2 * math.pi * k / segs) * rr * rng.uniform(0.9, 1.1),
                     cy + math.sin(2 * math.pi * k / segs) * rr * rng.uniform(0.9, 1.1),
                     z + (rng.uniform(-1.5, 1.5) if z > 0 else 0)) for k in range(segs)]
            if prev:
                for k in range(segs):
                    j = (k + 1) % segs
                    hot = z >= H
                    c1 = P["volcano"]
                    c2 = P["volcano_hot"] if hot else P["volcano"]
                    face(PAINT, [prev[k], prev[j], ring[j], ring[k]], [c1, c1, c2, c2])
            prev = ring
        face(GLOW, prev, P["glow_hot"])  # crater mouth
        # Lava rivulets down the camera-facing flank.
        for _ in range(3):
            k = rng.randrange(segs)
            ang = math.atan2(-cy, -cx) + rng.uniform(-0.5, 0.5)
            top = Vector((cx + math.cos(ang) * crater, cy + math.sin(ang) * crater, H - 0.5))
            bot = Vector((cx + math.cos(ang) * R * 0.6, cy + math.sin(ang) * R * 0.6, H * 0.4))
            n = Vector((-math.sin(ang), math.cos(ang), 0)) * 0.9
            off = (bot - top).normalized().cross(n).normalized() * 0.6  # lift off the slope toward the viewer
            face(GLOW, [top - n * 0.5 + off, top + n * 0.5 + off, bot + n + off, bot - n + off], P["glow_dk"])

def build():
    causeway()
    dais()
    horns()
    columns()
    edges()
    fissures()
    volcanoes()

# --- assemble + bake ------------------------------------------------------------
def assemble(coll):
    objs = []
    for b in (PAINT, GLOW):
        bmesh.ops.remove_doubles(b.bm, verts=b.bm.verts, dist=1e-5)
        bmesh.ops.recalc_face_normals(b.bm, faces=b.bm.faces)
        me = bpy.data.meshes.new(b.name)
        b.bm.to_mesh(me)
        b.bm.free()
        me.materials.append(material(b.mat))
        ca = me.color_attributes.get("Col")
        me.color_attributes.active_color = ca
        me.color_attributes.render_color_index = me.color_attributes.find("Col")
        ob = bpy.data.objects.new(b.name, me)
        coll.objects.link(ob)
        objs.append(ob)
    return objs

def bake_ao(paint):
    """Cycles AO into a temp attribute, multiplied into Col (paint only)."""
    sc = bpy.context.scene
    sc.render.engine = "CYCLES"
    sc.cycles.device = "CPU"
    sc.cycles.samples = 32
    sc.render.bake.target = "VERTEX_COLORS"
    sc.render.bake.margin = 0
    if not sc.world:
        sc.world = bpy.data.worlds.new("World")
    sc.world.light_settings.distance = 2.0
    me = paint.data
    me.color_attributes.new("AO", "FLOAT_COLOR", "CORNER")
    me.color_attributes.active_color = me.color_attributes["AO"]
    bpy.ops.object.select_all(action="DESELECT")
    paint.select_set(True)
    bpy.context.view_layer.objects.active = paint
    bpy.ops.object.bake(type="AO")
    col, ao = me.color_attributes["Col"].data, me.color_attributes["AO"].data
    for i in range(len(col)):
        a = min(1.0, max(0.0, ao[i].color[0]))
        m = 1 - 0.65 * (1 - a)
        c = col[i].color
        col[i].color = (min(1.0, c[0] * m), min(1.0, c[1] * m), min(1.0, c[2] * m), 1.0)
    me.color_attributes.remove(me.color_attributes["AO"])
    me.color_attributes.active_color = me.color_attributes["Col"]

def main():
    coll = reset_collection("Hell")
    build()
    objs = assemble(coll)
    tris = sum(sum(len(p.vertices) - 2 for p in o.data.polygons) for o in objs)
    print("hell objects:", [o.name for o in objs], "tris:", tris)
    if BAKE:
        bake_ao(objs[0])
    if EXPORT:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        export(coll, OUT)
        slim_glb(OUT)
        print("EXPORTED", OUT, os.path.getsize(OUT) // 1024, "KB")

main()
