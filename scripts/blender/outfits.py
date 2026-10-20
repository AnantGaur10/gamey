"""Enemy outfits for the outlaw rig (user 2026-10-12): "create purple enemy
cowboy model in purple, white, green that can be enemies and have different
clothing for them too".

    GLB_OUTFIT=<name> blender -b blender/cowboys.blend --python build_glbs.py
    npm run build:enemies   # all three

build_glbs.py calls apply() after the standing pose, holster and idle clip are
solved and BEFORE the palette x AO merge, so everything here is authored in
WORLD space on the standing outlaw (centre x 3.2, front +Y, feet z 0, pelvis
0.78-1.13, torso 1.10-1.70, head 1.73-2.07, brim z 2.02-2.10, crown to 2.37).
New meshes are parented under a KEEP node (Torso / Head / Top) so the merge
folds them into that node's mesh; colours go through materials (the merge
bakes material colour x AO into COLOR_0). The rig, node names, clips, holster
and the game's hit capsules are untouched; only clothing and palette change.

Each outfit mixes purple, white and green with different clothing:
  bandido  green poncho (white zig-zag, purple hem, thrown up over the gun
           hip so the holster stays clear), straw sombrero, crossed bandoliers
  ghost    long white duster (knee-length tails + open front panels), wide
           flat white hat, green bandana mask, purple scarf, green vest
  dandy    purple frock coat with long tails, green vest, white shirt front +
           cravat, tall top hat with a green band, white gloves, watch chain

Level ladder foes (user 2026-10-19: "10 levels ... different enemy npc ...
they must look different ... can add female enemy npcs"), one per level not
covered above (render/foes.ts, game/levels.ts):
  greenhorn  blue denim overalls + bib, mustard shirt, flat straw hat, red
             neckerchief, a wheat stalk, no moustache (level 1)
  prospector big white beard + sideburns, battered brown slouch hat, faded
             blue shirt, suspenders, pickaxe slung across the back (level 3)
  kate       (F) fringed buckskin jacket, cream shirt, teal neckerchief,
             auburn hair + braid over the shoulder, flat-crown hat (level 5)
  ruby       (F) crimson bodice + split riding skirt with a black hem, black
             corset, dark hair, small wine hat with a white plume (level 7)
  marshal    navy long coat, grey waistcoat + gold star, grey handlebar
             moustache, tall pale-grey hat (level 9)
  widow      (F) all black riding dress + long tails, crimson corset, silver
             hair, wide black hat with a rose, dark veil over the eyes (level 10)
Hair / beards / veils go on a `Hair` mesh under Head, props + hair below the
chin on a `Gear` mesh under Torso, skirt halves on `Skirt_L/R` under the
thighs: KEEP nodes in build_glbs.py that the ragdoll leaves out of its head /
torso / thigh boxes (ragdoll.ts BODY_MESH_SKIP), so long hair, a pickaxe or
a flared skirt never resizes the physics.
"""
import bpy, bmesh, math
from mathutils import Vector, Matrix

CX, CY = 3.2, 0.0   # the outlaw's centre in the .blend


def lin(h):
    def c(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255), 1.0)


def mat(name, hexcol, metallic=0.0):
    m = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    m.use_nodes = True
    bs = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bs.inputs["Base Color"].default_value = lin(hexcol)
    bs.inputs["Metallic"].default_value = metallic
    return m


def recolor(name, hexcol):
    m = bpy.data.materials[name]
    bs = next(n for n in m.node_tree.nodes if n.type == "BSDF_PRINCIPLED")
    bs.inputs["Base Color"].default_value = lin(hexcol)


def O(n):
    return bpy.data.objects[n]


def set_mat(o, m):
    if o.data.users > 1:
        o.data = o.data.copy()
    o.data.materials.clear()
    o.data.materials.append(m)
    for p in o.data.polygons:
        p.material_index = 0


def kill(*names):
    for n in names:
        o = bpy.data.objects.get(n)
        if o:
            bpy.data.objects.remove(o, do_unlink=True)


def edit_world(o, fn):
    """Per-vertex edit in world space (mesh data, not object scale, so bevel
    widths stay sane)."""
    if o.data.users > 1:
        o.data = o.data.copy()
    mw = o.matrix_world
    mwi = mw.inverted()
    for v in o.data.vertices:
        v.co = mwi @ fn(mw @ v.co)
    o.data.update()


def bbox(o):
    pts = [o.matrix_world @ Vector(c) for c in o.bound_box]
    return (Vector((min(p.x for p in pts), min(p.y for p in pts), min(p.z for p in pts))),
            Vector((max(p.x for p in pts), max(p.y for p in pts), max(p.z for p in pts))))


class Mesh:
    """World-space mesh builder with per-face material slots."""

    def __init__(self):
        self.bm = bmesh.new()
        self.mats = []

    def slot(self, m):
        if m not in self.mats:
            self.mats.append(m)
        return self.mats.index(m)

    def face(self, pts, m):
        f = self.bm.faces.new([self.bm.verts.new(Vector(p)) for p in pts])
        f.material_index = self.slot(m)
        return f

    def box(self, c, size, m, rot=None):
        R = (Matrix.Rotation(rot[0], 3, "X") @ Matrix.Rotation(rot[1], 3, "Y") @ Matrix.Rotation(rot[2], 3, "Z")) if rot else Matrix.Identity(3)
        c = Vector(c)
        hx, hy, hz = (s / 2 for s in size)
        P = [c + R @ Vector((sx * hx, sy * hy, sz * hz)) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
        # index = (sx>0)*4 + (sy>0)*2 + (sz>0)
        for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
            self.face([P[i] for i in q], m)

    def done(self, name, parent):
        # Winding is explicit (CCW outward): the game renders FrontSide only,
        # and recalc_face_normals guesses wrong on open shells like the poncho.
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(m)
        o = bpy.data.objects.new(name, me)
        bpy.data.collections["Outlaw"].objects.link(o)   # rig nodes also sit in "Collection"
        o.parent = parent
        o.matrix_parent_inverse = parent.matrix_world.inverted()
        return o


def rings_mesh(m, rings, segs, colf, close_top=False):
    """Stack of elliptical rings (list of fn(theta) -> (x, y, z)), faces
    between consecutive rings; colf(ring_i, seg_i, tri) -> material."""
    pts = [[Vector(r(2 * math.pi * s / segs)) for s in range(segs)] for r in rings]
    for i in range(len(rings) - 1):
        for s in range(segs):
            t = (s + 1) % segs
            a, b, c, d = pts[i][s], pts[i][t], pts[i + 1][t], pts[i + 1][s]
            m.face((a, d, c), colf(i, s, 0))
            m.face((a, c, b), colf(i, s, 1))
    if close_top:
        ctr = sum(pts[0], Vector()) / segs
        for s in range(segs):
            m.face((pts[0][(s + 1) % segs], pts[0][s], ctr), colf(0, s, 0))


# --- outfits ---------------------------------------------------------------------
def bandido(pre):
    green, white, purple = mat("Fit_PonchoGreen", 0x2e7d46), mat("Fit_White", 0xf2ede0), mat("Fit_Purple", 0x6a2c8a)
    leather, dark = mat("Fit_Leather", 0x6b4426), mat("Fit_Strap", 0x3e2614)
    recolor("Out_Coat", 0xe6dfcc)      # cotton shirt sleeves
    recolor("Out_Pants", 0x3b2546)     # dark purple trousers
    recolor("Out_Hat", 0xe8dcbc)       # straw sombrero
    recolor("Out_Accent", 0x6a2c8a)    # purple hat band / cuff
    recolor("Out_Boot", 0x3a2414)
    recolor("Out_Skin", 0xb57a52)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Chaps_{s}"), leather)
    kill(f"{pre}CoatTail_L", f"{pre}CoatTail_R", f"{pre}Dent")
    # Poncho: neck yoke -> shoulders -> hem; the hem rises over the gun hip
    # (+x) so the holster, grip and gun hand stay visible for the quick-draw.
    torso = O(pre + "Torso")
    segs = 24
    def hem(th):
        return 1.02 + 0.34 * max(0.0, math.cos(th))
    def ring(rx, ry, zf):
        return lambda th: (CX + rx * math.cos(th), CY + ry * math.sin(th), zf(th))
    sh = 1.69
    fr = (0.0, 0.42, 0.52, 0.68, 0.84, 0.9, 1.0)          # shoulder .. hem
    widths = (0.47, 0.475, 0.48, 0.485, 0.488, 0.49, 0.49)
    depths = (0.25, 0.265, 0.27, 0.275, 0.278, 0.28, 0.28)
    rings = [ring(0.15, 0.15, lambda th: 1.75)]
    for f, w, d in zip(fr, widths, depths):
        rings.append(ring(w, d, (lambda f: lambda th: sh + (hem(th) - sh) * f)(f)))
    def colf(i, s, tri):
        if i == 3:                       # zig-zag band
            return white if (s + tri) % 2 == 0 else green
        if i == 5:
            return white                 # stripe over the hem trim
        if i == 6:
            return purple                # hem trim
        return green
    m = Mesh()
    rings_mesh(m, rings, segs, colf)
    # Crossed bandoliers over the front, brass rounds along each; segments
    # follow the poncho's elliptical front so nothing floats off it.
    brass = bpy.data.materials["Out_Brass"]
    def on_front(x, z, off):
        u = min(0.95, abs(x - CX) / 0.48)
        return Vector((x, CY + 0.275 * math.sqrt(1 - u * u) + off, z))
    for sgn in (-1, 1):
        x0, z0 = CX - 0.30 * sgn, 1.62
        x1, z1 = CX + 0.27 * sgn, (1.16 if sgn < 0 else 1.30)
        ang = math.atan2(z1 - z0, x1 - x0)
        n = 6
        for k in range(n):
            t0, t1 = k / n, (k + 1) / n
            a = on_front(x0 + (x1 - x0) * t0, z0 + (z1 - z0) * t0, 0.012)
            b = on_front(x0 + (x1 - x0) * t1, z0 + (z1 - z0) * t1, 0.012)
            m.box((a + b) / 2, ((b - a).length + 0.01, 0.025, 0.075), dark, rot=(0, -ang, 0))
            p = on_front(x0 + (x1 - x0) * (t0 + t1) / 2, z0 + (z1 - z0) * (t0 + t1) / 2, 0.032)
            m.box(p, (0.022, 0.02, 0.06), brass, rot=(0, -ang + math.pi / 2, 0))
    m.done(pre + "Poncho", torso)
    # Sombrero: brim x1.5 with an upturned rim, crown taller and tapered.
    brim, top = O(pre + "Brim"), O(pre + "Top")
    blo, bhi = bbox(brim)
    bc = (blo + bhi) / 2
    edit_world(brim, lambda p: Vector((bc.x + (p.x - bc.x) * 1.5, bc.y + (p.y - bc.y) * 1.5, p.z)))
    tlo, thi = bbox(top)
    tc = (tlo + thi) / 2
    def crown(p):
        u = (p.z - tlo.z) / max(1e-6, thi.z - tlo.z)
        k = 1.0 - 0.35 * u
        return Vector((tc.x + (p.x - tc.x) * k, tc.y + (p.y - tc.y) * k, tlo.z + (p.z - tlo.z) * 1.55))
    edit_world(top, crown)
    R0, R1 = (bhi.x - blo.x) / 2 * 1.5, (bhi.x - blo.x) / 2 * 1.5 + 0.06
    lo_r = lambda th: (bc.x + R0 * math.cos(th), bc.y + R0 * math.sin(th), bhi.z - 0.01)
    up_r = lambda th: (bc.x + R1 * math.cos(th), bc.y + R1 * math.sin(th), bhi.z + 0.08)
    straw = bpy.data.materials["Out_Hat"]
    m = Mesh()
    # Upturned rim, both sides (seen from outside at range, inside from above).
    rings_mesh(m, [up_r, lo_r], 16, lambda i, s, t: straw)
    rings_mesh(m, [lo_r, up_r], 16, lambda i, s, t: straw)
    m.done(pre + "HatRim", top)


def ghost(pre):
    white, green, purple = mat("Fit_Duster", 0xe9e5da), mat("Fit_Mask", 0x2f7a4a), mat("Fit_Purple", 0x5e2a7e)
    leather = mat("Fit_Leather", 0x4a3020)
    recolor("Out_Coat", 0xe9e5da)      # bone-white duster
    recolor("Out_Hat", 0xefebe0)
    recolor("Out_Accent", 0x5e2a7e)    # purple scarf, band, cuff
    recolor("Out_Pants", 0x34343c)
    recolor("Out_Boot", 0x1c1612)
    recolor("Out_Skin", 0xe8b896)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Chaps_{s}"), leather)
        set_mat(O(f"{pre}Vest_{s}"), green)
    kill(f"{pre}Moustache", f"{pre}Mouth_L", f"{pre}Mouth_R")
    # Knee-length tails (hinge at their top, so the sway pivot is unchanged).
    for s in ("L", "R"):
        t = O(f"{pre}CoatTail_{s}")
        lo, hi = bbox(t)
        cx = (lo.x + hi.x) / 2
        edit_world(t, lambda p, hi=hi, cx=cx: Vector((cx + (p.x - cx) * 1.3, p.y, hi.z - (hi.z - p.z) * 2.1)))
    torso = O(pre + "Torso")
    m = Mesh()
    # Open front panels down to the thighs; the right one stays clear of the holster.
    for (x0, x1) in ((2.93, 3.10), (3.29, 3.42)):
        m.box(((x0 + x1) / 2, 0.135, 0.92), (x1 - x0, 0.04, 0.46), white)
    m.done(pre + "DusterFront", torso)
    # Green bandana mask over nose + mouth, point under the chin.
    head = O(pre + "Head")
    m = Mesh()
    m.box((CX, 0.175, 1.82), (0.31, 0.085, 0.11), green)
    m.face(((CX + 0.14, 0.214, 1.766), (CX, 0.22, 1.66), (CX - 0.14, 0.214, 1.766)), green)
    m.done(pre + "Mask", head)
    # Wide flat hat: brim x1.22, crown lowered.
    brim, top, dent = O(pre + "Brim"), O(pre + "Top"), O(pre + "Dent")
    blo, bhi = bbox(brim)
    bc = (blo + bhi) / 2
    edit_world(brim, lambda p: Vector((bc.x + (p.x - bc.x) * 1.22, bc.y + (p.y - bc.y) * 1.22, p.z)))
    tlo, thi = bbox(top)
    drop = (thi.z - tlo.z) * 0.25
    edit_world(top, lambda p: Vector((p.x, p.y, tlo.z + (p.z - tlo.z) * 0.75)))
    edit_world(dent, lambda p: Vector((p.x, p.y, p.z - drop)))


def dandy(pre):
    green, white = mat("Fit_Vest", 0x2f7a52), mat("Fit_White", 0xf4f1ea)
    brass = bpy.data.materials["Out_Brass"]
    recolor("Out_Coat", 0x5b2a86)      # purple frock coat
    recolor("Out_Pants", 0x77708a)     # lavender-grey trousers
    recolor("Out_Hat", 0x2a1838)       # aubergine top hat
    recolor("Out_Accent", 0x2f8a52)    # green hat band / cuff
    recolor("Out_Boot", 0x141018)
    recolor("Out_Skin", 0xe2a882)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Vest_{s}"), green)
    for n in ("Hand_L", "Hand_R", "Finger_L0", "Finger_L1", "Finger_L2"):
        set_mat(O(pre + n), white)     # white gloves
    # The chaps bridge thigh -> pelvis (the rig has a gap there): keep them
    # as trouser legs.
    for s in ("L", "R"):
        set_mat(O(f"{pre}Chaps_{s}"), bpy.data.materials["Out_Pants"])
    kill(f"{pre}Bandana", f"{pre}BandanaKnot", f"{pre}Dent")
    for s in ("L", "R"):
        t = O(f"{pre}CoatTail_{s}")
        lo, hi = bbox(t)
        cx = (lo.x + hi.x) / 2
        edit_world(t, lambda p, hi=hi, cx=cx: Vector((cx + (p.x - cx) * 0.9, p.y, hi.z - (hi.z - p.z) * 1.75)))
    torso = O(pre + "Torso")
    m = Mesh()
    m.box((CX, 0.17, 1.545), (0.09, 0.04, 0.29), white)                 # shirt front
    m.box((CX, 0.2, 1.69), (0.13, 0.05, 0.06), white)                   # cravat knot
    m.face(((CX + 0.055, 0.215, 1.67), (CX, 0.225, 1.55), (CX - 0.055, 0.215, 1.67)), white)
    m.box((CX - 0.065, 0.2, 1.30), (0.13, 0.012, 0.012), brass, rot=(0, 0.25, 0))  # watch chain
    m.done(pre + "Shirt", torso)
    # Top hat: tall straight crown, narrow brim.
    brim, top = O(pre + "Brim"), O(pre + "Top")
    blo, bhi = bbox(brim)
    bc = (blo + bhi) / 2
    edit_world(brim, lambda p: Vector((bc.x + (p.x - bc.x) * 0.74, bc.y + (p.y - bc.y) * 0.74, p.z)))
    tlo, thi = bbox(top)
    tc = (tlo + thi) / 2
    edit_world(top, lambda p: Vector((tc.x + (p.x - tc.x) * 0.9, tc.y + (p.y - tc.y) * 0.9,
                                      tlo.z + (p.z - tlo.z) * 2.0)))


# --- ladder helpers (2026-10-19) -----------------------------------------------------
def oriented(m, pts, mt, normal):
    """Face with its winding picked so it faces `normal` (FrontSide only)."""
    pts = [Vector(p) for p in pts]
    if (pts[1] - pts[0]).cross(pts[2] - pts[0]).dot(Vector(normal)) < 0:
        pts = pts[::-1]
    return m.face(pts, mt)


def panel(m, x0, x1, z0, z1, y, mt, both=False):
    """Quad in the XZ plane at depth y, facing the camera (+Y)."""
    q = [(x0, y, z0), (x1, y, z0), (x1, y, z1), (x0, y, z1)]
    oriented(m, q, mt, (0, 1, 0))
    if both:
        oriented(m, q, mt, (0, -1, 0))


def fringe(m, x0, x1, ztop, zcut, ztip, y, n, mt, both=False):
    """Leather fringe: a band with n teeth hanging below it (+Y facing)."""
    panel(m, x0, x1, zcut, ztop, y, mt, both)
    w = (x1 - x0) / n
    for i in range(n):
        a, b = x0 + i * w, x0 + (i + 1) * w
        tri = [(a, y, zcut), (b, y, zcut), ((a + b) / 2, y, ztip)]
        oriented(m, tri, mt, (0, 1, 0))
        if both:
            oriented(m, tri, mt, (0, -1, 0))


def side_fringe(m, xin, xout, z0, z1, y, n, mt, both=False):
    """Fringe down the outer edge of a sleeve: teeth point from xin to xout."""
    edge = xin + (xout - xin) * 0.25
    panel(m, min(xin, edge), max(xin, edge), z0, z1, y, mt, both)
    h = (z1 - z0) / n
    for i in range(n):
        a, b = z0 + i * h, z0 + (i + 1) * h
        tri = [(edge, y, a), (edge, y, b), (xout, y, a + 0.2 * h)]
        oriented(m, tri, mt, (0, 1, 0))
        if both:
            oriented(m, tri, mt, (0, -1, 0))


def star(m, c, r_out, r_in, mt):
    """Five-point star facing +Y (badge)."""
    c = Vector(c)
    pts = []
    for k in range(10):
        a = math.pi / 2 + k * math.pi / 5
        r = r_out if k % 2 == 0 else r_in
        pts.append(c + Vector((r * math.cos(a), 0, r * math.sin(a))))
    for k in range(10):
        oriented(m, [c, pts[k], pts[(k + 1) % 10]], mt, (0, 1, 0))


def seg_box(m, a, b, w, d, mt):
    """Box from a to b: depth d toward the camera (+Y side), width w across."""
    a, b = Vector(a), Vector(b)
    u = (b - a).normalized()
    ref = Vector((0, 1, 0)) if abs(u.y) < 0.95 else Vector((1, 0, 0))
    v = (ref - u * ref.dot(u)).normalized()
    n = u.cross(v)
    c = (a + b) / 2
    hl, hd, hw = ((b - a).length + 0.004) / 2, d / 2, w / 2
    # Same corner order + winding as Mesh.box (right-handed frame u, v, n).
    P = [c + u * (sx * hl) + v * (sy * hd) + n * (sz * hw) for sx in (-1, 1) for sy in (-1, 1) for sz in (-1, 1)]
    for q in ((0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)):
        m.face([P[i] for i in q], mt)


def hat(pre, brim_k=1.0, crown_h=1.0, taper=0.0, droop=0.0, dent=True):
    """Reshape the outlaw hat: brim scale, crown height / top taper, a
    drooping (bowl) brim, and the crown dent kept on top or removed."""
    brim, top = O(pre + "Brim"), O(pre + "Top")
    blo, bhi = bbox(brim)
    bc = (blo + bhi) / 2
    r0 = (bbox(top)[1].x - bbox(top)[0].x) / 2   # crown radius: the brim droops outside it
    def b(p):
        q = Vector((bc.x + (p.x - bc.x) * brim_k, bc.y + (p.y - bc.y) * brim_k, p.z))
        r = math.hypot(q.x - bc.x, q.y - bc.y)
        q.z -= droop * max(0.0, r - r0) / max(1e-6, (bhi.x - blo.x) / 2 * brim_k - r0)
        return q
    edit_world(brim, b)
    tlo, thi = bbox(top)
    tc = (tlo + thi) / 2
    def cr(p):
        u = (p.z - tlo.z) / max(1e-6, thi.z - tlo.z)
        k = 1.0 - taper * u
        return Vector((tc.x + (p.x - tc.x) * k, tc.y + (p.y - tc.y) * k, tlo.z + (p.z - tlo.z) * crown_h))
    edit_world(top, cr)
    d = bpy.data.objects.get(pre + "Dent")
    if d and not dent:
        kill(pre + "Dent")
    elif d:
        lift = (thi.z - tlo.z) * (crown_h - 1.0)
        edit_world(d, lambda p: Vector((tc.x + (p.x - tc.x) * (1 - taper), tc.y + (p.y - tc.y) * (1 - taper), p.z + lift)))
    return bhi.z, (bhi.x - blo.x) / 2 * brim_k


def feminine(pre, lips, brows):
    """Face: no moustache, coloured lips, thin brows."""
    kill(pre + "Moustache")
    lip = mat("Fit_Lips", lips)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Mouth_{s}"), lip)
        b = O(f"{pre}Brow_{s}")
        lo, hi = bbox(b)
        c = (lo + hi) / 2
        set_mat(b, mat("Fit_Brow", brows))
        edit_world(b, lambda p, c=c: Vector((c.x + (p.x - c.x) * 0.9, p.y, c.z + (p.z - c.z) * 0.5)))


def long_hair(pre, hm, back_to=1.42, fronts=True, curls=False):
    """Hair under the hat brim (Hair, under Head) + the length below the chin
    (Gear, under Torso): back slab, side curtains over the ears, and locks over
    the front of both shoulders."""
    m = Mesh()
    m.box((CX, -0.178, 1.875), (0.37, 0.05, 0.31), hm)                 # back of the head
    for x in (3.02, 3.38):
        m.box((x, 0.0075, 1.865), (0.07, 0.335, 0.33), hm)           # side curtains framing the face
    m.box((CX, 0.03, 2.035), (0.35, 0.33, 0.03), hm)                  # crown under the brim
    hair = m.done(pre + "Hair", O(pre + "Head"))
    g = Mesh()
    g.box((CX, -0.19, (1.73 + back_to) / 2), (0.36, 0.05, 1.73 - back_to), hm)
    if fronts:
        for x in (3.03, 3.37):
            if curls:
                for k, z in enumerate((1.66, 1.56, 1.47)):
                    g.box((x + (0.012 if k % 2 else -0.012), 0.14, z), (0.075, 0.15, 0.1), hm)
            else:
                g.box((x, 0.1375, 1.585), (0.065, 0.155, 0.29), hm)   # in front of the vest (y 0.198)
    return hair, g


def split_skirt(pre, body, hem, rings_spec, segs=16):
    """Split riding skirt: a flared half on each thigh (its own Skirt_L/R
    KEEP node under Leg, so it bends with the leg in a crouch and the ragdoll
    sizes the thigh without it), pulled in on the outer side so the gun
    holster hangs clear of it, and widened on the inner side so the halves
    overlap into one skirt from the front (no trouser notch). rings_spec:
    (rx, ry, z) top -> hem; the last band is the hem trim."""
    for s, cx, side in (("L", CX - 0.15, -1), ("R", CX + 0.15, 1)):
        rings = []
        for rx, ry, z in rings_spec:
            def r(th, rx=rx, ry=ry, z=z):
                c = side * math.cos(th)
                k = 1.0 - 0.3 * c if c > 0 else 1.0 - 0.45 * c
                return (cx + rx * k * math.cos(th), 0.01 + ry * math.sin(th), z)
            rings.append(r)
        m = Mesh()
        rings_mesh(m, rings, segs, lambda i, sg, t: hem if i == len(rings) - 2 else body)
        m.done(f"{pre}Skirt_{s}", O(f"{pre}Leg_{s}"))
    set_mat(O(pre + "Pelvis"), body)          # the dress over the hips
    for s in ("L", "R"):
        set_mat(O(f"{pre}Chaps_{s}"), body)


def suspenders(m, strap, x_pairs, z0=1.12, y=0.168):
    for xb, xt in x_pairs:
        seg_box(m, (xb, y, z0), (xt, y, 1.705), 0.035, 0.012, strap)
        m.box((xt, 0.0, 1.708), (0.035, 0.33, 0.012), strap)          # over the shoulder


# --- ladder foes (2026-10-19) ----------------------------------------------------------
def greenhorn(pre):
    denim, denim_dk = mat("Fit_Denim", 0x41618f), mat("Fit_DenimDark", 0x2f4a70)
    straw = mat("Fit_Straw", 0xe2c06a)
    recolor("Out_Coat", 0xd39c3a)      # mustard shirt
    recolor("Out_Pants", 0x41618f)     # denim legs
    recolor("Out_Hat", 0xd8b45e)       # straw hat
    recolor("Out_Accent", 0xb8352b)    # red neckerchief, band, cuff
    recolor("Out_Boot", 0x5a3a22)
    recolor("Out_Skin", 0xe9b48c)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Chaps_{s}"), bpy.data.materials["Out_Pants"])
    kill(f"{pre}CoatTail_L", f"{pre}CoatTail_R", f"{pre}Vest_L", f"{pre}Vest_R", f"{pre}Moustache")
    torso = O(pre + "Torso")
    m = Mesh()
    m.box((CX, 0.168, 1.29), (0.27, 0.022, 0.38), denim)                # overall bib
    m.box((CX, 0.182, 1.36), (0.11, 0.008, 0.09), denim_dk)            # bib pocket
    suspenders(m, denim, ((3.085, 3.06), (3.315, 3.34)), z0=1.44, y=0.17)
    brass = bpy.data.materials["Out_Brass"]
    for x in (3.085, 3.315):
        m.box((x, 0.183, 1.455), (0.03, 0.01, 0.03), brass)
    m.done(pre + "Bib", torso)
    hat(pre, brim_k=1.12, crown_h=0.62, dent=False)
    # Blond fringe peeking under the brim + a wheat stalk in the mouth corner.
    h = Mesh()
    for x in (3.035, 3.365):
        h.box((x, 0.0, 1.97), (0.03, 0.2, 0.09), straw)
    seg_box(h, (3.25, 0.2, 1.80), (3.40, 0.27, 1.86), 0.012, 0.012, straw)
    h.done(pre + "Hair", O(pre + "Head"))


def prospector(pre):
    beard = mat("Fit_Beard", 0xdcd8cf)
    strap, steel, wood = mat("Fit_Strap", 0x3e2a1a), bpy.data.materials["Out_Steel"], mat("Fit_Wood", 0x8a6238)
    recolor("Out_Coat", 0x7b8999)      # faded blue flannel
    recolor("Out_Pants", 0x7a5c3e)     # tan work trousers
    recolor("Out_Hat", 0x6e5236)       # battered brown felt
    recolor("Out_Accent", 0x3a2a1c)    # dark band / cuff
    recolor("Out_Boot", 0x3e2a1a)
    recolor("Out_Skin", 0xc58c62)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Chaps_{s}"), bpy.data.materials["Out_Pants"])
        set_mat(O(f"{pre}Brow_{s}"), beard)
    set_mat(O(pre + "Moustache"), beard)
    kill(f"{pre}CoatTail_L", f"{pre}CoatTail_R", f"{pre}Vest_L", f"{pre}Vest_R",
         f"{pre}Bandana", f"{pre}BandanaKnot")
    torso = O(pre + "Torso")
    m = Mesh()
    suspenders(m, strap, ((3.09, 3.06), (3.31, 3.34)))
    m.done(pre + "Straps", torso)
    hat(pre, brim_k=1.06, crown_h=0.86, taper=0.14, droop=0.07)
    # Big beard (chin to chest) + sideburns, on the Hair node.
    h = Mesh()
    h.box((CX, 0.17, 1.735), (0.25, 0.09, 0.2), beard)
    oriented(h, [(CX - 0.125, 0.215, 1.64), (CX + 0.125, 0.215, 1.64), (CX, 0.2, 1.55)], beard, (0, 1, 0))
    oriented(h, [(CX - 0.125, 0.125, 1.64), (CX + 0.125, 0.125, 1.64), (CX, 0.2, 1.55)], beard, (0, -1, 0))
    for x in (3.03, 3.37):
        h.box((x, 0.05, 1.82), (0.03, 0.16, 0.2), beard)          # sideburns
    h.done(pre + "Hair", O(pre + "Head"))
    # Pickaxe slung across the back, head over the right shoulder.
    g = Mesh()
    seg_box(g, (2.96, -0.205, 1.08), (3.47, -0.205, 1.93), 0.035, 0.035, wood)
    ang = math.atan2(1.93 - 1.08, 3.47 - 2.96)
    ux, uz = -math.sin(ang), math.cos(ang)
    tip = Vector((3.47, -0.205, 1.93))
    for sgn in (-1, 1):                 # pick head: two blades, curving back down the handle
        b = tip + Vector((ux * 0.2 * sgn - math.cos(ang) * 0.05, 0, uz * 0.2 * sgn - math.sin(ang) * 0.05))
        seg_box(g, tip, b, 0.04, 0.04, steel)
    g.done(pre + "Gear", torso)


def kate(pre):
    buck, buck_dk = mat("Fit_Buckskin", 0xc49464), mat("Fit_BuckDark", 0x9c6c40)
    shirt, hair = mat("Fit_Shirt", 0xefe4cc), mat("Fit_Hair", 0x8c3c1c)
    leather = mat("Fit_Leather", 0x6a4428)
    recolor("Out_Coat", 0xc49464)      # buckskin jacket
    recolor("Out_Pants", 0x4a3226)     # dark trousers
    recolor("Out_Hat", 0x5e4028)       # dark brown flat-crown hat
    recolor("Out_Accent", 0x2e8c84)    # teal neckerchief / band / cuff
    recolor("Out_Boot", 0x3a2416)
    recolor("Out_Skin", 0xe6a87e)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Chaps_{s}"), leather)
        set_mat(O(f"{pre}Vest_{s}"), buck_dk)
    feminine(pre, 0xb4524a, 0x7a3418)
    torso = O(pre + "Torso")
    m = Mesh()
    m.box((CX, 0.175, 1.40), (0.09, 0.03, 0.5), shirt)                 # shirt between the jacket fronts
    fringe(m, 2.96, 3.44, 1.605, 1.59, 1.525, 0.205, 12, buck)         # chest yoke fringe
    side_fringe(m, 2.766, 2.71, 1.26, 1.62, 0.0, 7, buck, both=True)   # left sleeve
    m.done(pre + "Fringe", torso)
    r = Mesh()
    side_fringe(r, 3.634, 3.69, 1.30, 1.66, 0.04, 7, buck, both=True)  # gun-arm sleeve
    r.done(pre + "FringeR", O(pre + "Sleeve_R"))
    hat(pre, brim_k=1.08, crown_h=0.66, dent=False)
    h, g = long_hair(pre, hair, back_to=1.48, fronts=False)
    # Braid over the left shoulder (from the side hair, over the shoulder
    # top, down the jacket front), tied off with the neckerchief teal.
    g.box((3.025, 0.13, 1.72), (0.06, 0.15, 0.06), hair)
    for k in range(4):
        z = 1.67 - k * 0.075
        g.box((3.025 + 0.006 * k, 0.207, z), (0.06 - 0.004 * k, 0.05, 0.072), hair)
    g.box((3.045, 0.207, 1.37), (0.05, 0.05, 0.03), bpy.data.materials["Out_Accent"])
    g.done(pre + "Gear", torso)


def ruby(pre):
    crimson, black = mat("Fit_Crimson", 0xa3182c), mat("Fit_Corset", 0x1c1418)
    lace, hair = mat("Fit_Lace", 0xf3e6d0), mat("Fit_Hair", 0x2b1712)
    plume = mat("Fit_Plume", 0xf6f1e8)
    recolor("Out_Coat", 0xa3182c)      # crimson bodice + sleeves
    recolor("Out_Pants", 0x221a1e)     # black stockings
    recolor("Out_Hat", 0x3a0d18)       # small wine hat
    recolor("Out_Accent", 0xf0e2c8)    # cream band / cuff
    recolor("Out_Boot", 0x1a1214)
    recolor("Out_Skin", 0xf0c2a0)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Vest_{s}"), black)
    kill(f"{pre}CoatTail_L", f"{pre}CoatTail_R", f"{pre}Bandana", f"{pre}BandanaKnot")
    feminine(pre, 0xc0283a, 0x2b1712)
    for s in ("L", "R"):                # puffed sleeves
        pad = O(f"{pre}Pad_{s}")
        lo, hi = bbox(pad)
        c = (lo + hi) / 2
        edit_world(pad, lambda p, c=c: c + (p - c) * 1.18)
    torso = O(pre + "Torso")
    m = Mesh()
    m.box((CX, 0.2, 1.635), (0.44, 0.02, 0.03), lace)                  # lace neckline
    for z in (1.25, 1.33, 1.41, 1.49):                                 # corset lacing
        m.box((CX, 0.203, z), (0.08, 0.008, 0.012), lace, rot=(0, 0.5, 0))
        m.box((CX, 0.203, z), (0.08, 0.008, 0.012), lace, rot=(0, -0.5, 0))
    m.done(pre + "Lace", torso)
    split_skirt(pre, crimson, black, ((0.118, 0.128, 0.80), (0.132, 0.142, 0.62), (0.152, 0.16, 0.42),
                                       (0.17, 0.175, 0.27), (0.174, 0.179, 0.215)))
    top_z, _ = hat(pre, brim_k=0.86, crown_h=0.55, dent=False)
    p = Mesh()                                                         # white plume, swept back
    seg_box(p, (3.06, -0.04, 2.17), (3.0, -0.12, 2.32), 0.05, 0.03, plume)
    seg_box(p, (3.0, -0.12, 2.32), (2.97, -0.22, 2.42), 0.04, 0.025, plume)
    p.done(pre + "Plume", O(pre + "Top"))
    h, g = long_hair(pre, hair, back_to=1.45, fronts=True, curls=True)
    g.done(pre + "Gear", torso)


def marshal(pre):
    navy, grey = mat("Fit_Navy", 0x2b3956), mat("Fit_Waistcoat", 0x6d6a66)
    stache = mat("Fit_Stache", 0xa8a49c)
    brass = bpy.data.materials["Out_Brass"]
    recolor("Out_Coat", 0x2b3956)      # navy long coat
    recolor("Out_Pants", 0x55555c)     # grey trousers
    recolor("Out_Hat", 0xbdb6a8)       # pale grey cattleman
    recolor("Out_Accent", 0x1c1c1c)    # black band / string tie / cuff
    recolor("Out_Boot", 0x141012)
    recolor("Out_Skin", 0xd09a74)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Chaps_{s}"), bpy.data.materials["Out_Pants"])
        set_mat(O(f"{pre}Vest_{s}"), grey)
        set_mat(O(f"{pre}Brow_{s}"), stache)
        t = O(f"{pre}CoatTail_{s}")
        lo, hi = bbox(t)
        cx = (lo.x + hi.x) / 2
        edit_world(t, lambda p, hi=hi, cx=cx: Vector((cx + (p.x - cx) * 1.2, p.y, hi.z - (hi.z - p.z) * 1.7)))
    # Handlebar moustache: wider, grey, tips curled up.
    mo = O(pre + "Moustache")
    set_mat(mo, stache)
    lo, hi = bbox(mo)
    edit_world(mo, lambda p: Vector((CX + (p.x - CX) * 1.65, p.y, p.z)))
    torso = O(pre + "Torso")
    m = Mesh()
    star(m, (3.065, 0.206, 1.53), 0.055, 0.024, brass)                # marshal's star
    for z in (1.22, 1.32, 1.42):
        for x in (3.17, 3.23):
            m.box((x, 0.2, z), (0.02, 0.01, 0.02), brass)
    for x0, x1 in ((2.93, 3.08), (3.32, 3.43)):                       # coat fronts to the knee
        m.box(((x0 + x1) / 2, 0.135, 0.93), (x1 - x0, 0.04, 0.42), navy)
    m.done(pre + "Badge", torso)
    h = Mesh()
    for sgn in (-1, 1):
        h.box((CX + sgn * 0.135, 0.18, 1.85), (0.03, 0.03, 0.06), stache)
    h.done(pre + "Hair", O(pre + "Head"))
    hat(pre, brim_k=1.08, crown_h=1.15)


def widow(pre):
    black, corset = mat("Fit_Black", 0x18141a), mat("Fit_Corset", 0x8e1424)
    hem, hair = mat("Fit_Hem", 0x8e1424), mat("Fit_Hair", 0xdcd8d2)
    veil, rose, leaf = mat("Fit_Veil", 0x2a252c), mat("Fit_Rose", 0xb0182a), mat("Fit_Leaf", 0x2f5a34)
    recolor("Out_Coat", 0x18141a)      # black riding habit
    recolor("Out_Pants", 0x141014)     # black stockings
    recolor("Out_Hat", 0x16121a)       # wide black hat
    recolor("Out_Accent", 0x9a1628)    # crimson band / cuff
    recolor("Out_Boot", 0x120e10)
    recolor("Out_Skin", 0xf2d6c4)
    for s in ("L", "R"):
        set_mat(O(f"{pre}Vest_{s}"), corset)
        t = O(f"{pre}CoatTail_{s}")
        lo, hi = bbox(t)
        cx = (lo.x + hi.x) / 2
        edit_world(t, lambda p, hi=hi, cx=cx: Vector((cx + (p.x - cx) * 1.15, p.y, hi.z - (hi.z - p.z) * 1.8)))
    for n in ("Hand_L", "Hand_R", "Finger_L0", "Finger_L1", "Finger_L2"):
        set_mat(O(pre + n), black)     # black gloves
    kill(f"{pre}Bandana", f"{pre}BandanaKnot")
    feminine(pre, 0x8a1424, 0xb8b4ae)
    split_skirt(pre, black, hem, ((0.118, 0.128, 0.80), (0.134, 0.144, 0.6), (0.156, 0.164, 0.4),
                                   (0.174, 0.18, 0.25), (0.178, 0.184, 0.195)))
    hat(pre, brim_k=1.32, crown_h=0.8)
    r = Mesh()                                                          # rose on the band
    for dx, dz in ((0, 0), (0.035, 0.02), (-0.02, 0.03)):
        r.box((3.345 + dx, 0.09, 2.13 + dz), (0.045, 0.045, 0.045), rose)
    r.box((3.37, 0.04, 2.115), (0.06, 0.03, 0.02), leaf)
    r.done(pre + "Rose", O(pre + "Top"))
    h, g = long_hair(pre, hair, back_to=1.38, fronts=True)
    v = Mesh()
    panel(v, 3.05, 3.35, 1.875, 2.02, 0.222, veil)                      # veil over the eyes
    v.done(pre + "Veil", O(pre + "Hair"))
    g.done(pre + "Gear", O(pre + "Torso"))


OUTFITS = {"bandido": bandido, "ghost": ghost, "dandy": dandy,
           "greenhorn": greenhorn, "prospector": prospector, "kate": kate,
           "ruby": ruby, "marshal": marshal, "widow": widow}


def apply(name, pre, coll):
    if name not in OUTFITS:
        raise SystemExit(f"unknown outfit {name!r}: {sorted(OUTFITS)}")
    bpy.context.view_layer.update()
    OUTFITS[name](pre)
    bpy.context.view_layer.update()
    print("OUTFIT", name, "applied")
