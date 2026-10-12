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


OUTFITS = {"bandido": bandido, "ghost": ghost, "dandy": dandy}


def apply(name, pre, coll):
    if name not in OUTFITS:
        raise SystemExit(f"unknown outfit {name!r}: {sorted(OUTFITS)}")
    bpy.context.view_layer.update()
    OUTFITS[name](pre)
    bpy.context.view_layer.update()
    print("OUTFIT", name, "applied")
