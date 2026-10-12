"""Deterministic falls-set build: code -> public/models/falls.glb.

    blender -b --factory-startup --python scripts/blender/build_falls.py

Never opens or saves a .blend: everything is generated here from a seeded rng
(byte-identical GLB per run). Shared primitives, bake and export live in
set_kit.py (its docstring holds the screen-space coords and the node
contract); helpers only this set needs (tensor terrain, waterfall sheets,
river strip, ferns, grass, camera-facing tree cards) live below.

THE PLACE (user 2026-10-12, ref: an RDR2 meadow duel): a sunlit grassy
clearing with a worn dirt path down the duel line, ferns, tall grass, bushes
and boulders along both sides, broadleaf trees and pines climbing the valley
walls left and right, and a big pale rock outcrop on the right. Far behind
the foe a pale cliff closes the valley: a two-tier waterfall drops from a
notch into a plunge pool whose river runs off to the left into the trees.
Wooded hills and blue mountains cover the horizon at wide views.

WHY IT LOOKS LIKE THIS: the camera rides 3.1m behind the player at 2.05m and
looks at (-1.5, 9.5, 1.0) with a 40 deg vertical FOV (see set_kit.py), so the
ray through the foe meets the cliff (y ~ -80) at x ~ -4 .. -9: the falls are
centred at x = -6, their lip (z 24) stays inside the top of the frame even at
the shortest duel (the camera then pitches down ~5 deg). The valley floor is
exactly z = 0 for |x| < 8 in the clearing (game ground: ragdoll, hit capsules,
dust); only low grass (< 0.25m) grows within |x| < 2.5. The walls rise to
~7.5m at x = +-45, so the arena's flat ground plane behind them never shows.

COORDS: set_kit SCREEN space (sx right, y toward the camera, z up). Foe at
(0, 9.5, 0), player at y 18.0 .. 35.2, camera at (1.25, player_y + 3.1, 2.05).

OUTPUT NODES (src/render/setGlb.ts):
  S_Paint    terrain, rocks, cliff, trunks, every elevated / far tree, hills
  S_Foliage  near ground-standing leaves, bushes, ferns, grass (z 0 .. ~11):
             the runtime wind sway grows with height above z = 0
  S_Water    falls sheets (vertical: flow down), pool + river (flat: ripple),
             spray mounds at the base. Lava in hell.
Colour = palette x Cycles AO x ray-cast sun shadow in COLOR_0. The terrain's
outer ring is EXACTLY P["edge"] (0x7d9a45): the runtime paints the arena
ground plane that colour.

Env: FALLS_OUT=<glb path>, FALLS_BAKE=0 (skip the bake), FALLS_EXPORT=0,
FALLS_PREVIEW=<png prefix> (Workbench renders from the game camera).
"""
import bpy, math, os, random, sys  # noqa: F401
from mathutils import Vector

HERE = os.path.dirname(os.path.abspath(__file__)) if "__file__" in globals() else os.getcwd()
sys.path.insert(0, HERE)
import set_kit as K  # noqa: E402

lin = K.lin
R = random.Random(1859)

P = {k: lin(v) for k, v in dict(
    edge=0x7d9a45,                       # band edge = arena ground plane colour
    grass=0x92ad4e, grass_lt=0xb0c260, grass_dk=0x67843a, grass_dry=0xaead62, clover=0x71963f,
    path=0xa08a64, path_dk=0x83704f, soil=0x6f5b41, bank=0x7a6c52,
    slope=0x6f8a3e, slope_dk=0x55702f,
    tuft=0x8fae4e, tuft_lt=0xb8c86a, tuft_dry=0xc2b874,
    fern=0x5e9a3a, fern_lt=0x8cc054,
    bush=0x46733a, bush_lt=0x74a44c,
    leaf=0x4f7f34, leaf_lt=0x86ae4c, leaf_dk=0x3a5e2a,
    pine=0x2f5534, pine_dk=0x22402a, pine_lt=0x4a7643,
    bark=0x5c4634, bark_dk=0x3f2f23, birch=0xd6d0c2,
    rock=0xb4ad9c, rock_lt=0xd2cab6, rock_dk=0x8a8476, moss=0x6f8a3c, wet=0x4f4b44,
    cliff=0xbcb19a, cliff_lt=0xd4cab2, cliff_dk=0x9a8f7a, crack=0x6a6254, cliff_moss=0x7a8a48,
    falls_w=0xeaf6f7, falls_m=0xb8dce3, falls_e=0x8cbcc8, foam=0xf6fbfb,
    pool_deep=0x3d7c86, pool_sh=0x6daab0, river=0x5c989f, river_lt=0x8ec2c6,
    hill=0x3b5a36, hill_dk=0x2d4a2e, hill_far=0x55704c,
    mtn=0x7d92a2, mtn_lt=0x9cadb9, mtn_dk=0x687e8e,
).items()}

# --- small math ---------------------------------------------------------------------
def smooth(a, b, x):
    t = min(1.0, max(0.0, (x - a) / (b - a)))
    return t * t * (3 - 2 * t)

def noise(x, y):
    """Cheap deterministic value in ~[-1, 1] (sum of detuned sines)."""
    return (math.sin(x * 0.173 + y * 0.311 + 1.3) * 0.45 + math.sin(x * 0.531 - y * 0.247 + 0.4) * 0.3
            + math.sin(x * 1.13 + y * 0.97 + 2.1) * 0.25)

# --- terrain --------------------------------------------------------------------------
X0, X1, Y0, Y1 = -45.0, 45.0, -82.0, 48.0
TERRACE_Z = 5.0                    # the falls land on a raised terrace: their white
POOL_C, POOL_R = (-7.0, -71.0), (11.5, 6.5)   # water starts above the foe's head
POOL_Z = 4.75
OUTLET = [(-14.0, -67.0), (-18.0, -64.6), (-19.8, -62.6)]
CASCADE_X = (-22.6, -17.0)         # outlet drop at the terrace lip, LEFT of the foe ray
LPOOL_C, LPOOL_R, LPOOL_Z = (-20.0, -57.4), (4.4, 2.3), 0.72
STREAM = [(-23.0, -57.2), (-28.0, -55.4), (-33.5, -54.0), (-39.0, -52.5)]
STREAM_Z = [0.70, 0.62, 0.55, 0.5]

def side_floor(y):
    """|x| where the valley wall starts rising: wide floor near the pool."""
    return 13.0 + 17.0 * smooth(-20.0, -45.0, y)

def poly_info(pts, zs, x, y):
    """(distance to the polyline, interpolated z there)."""
    best = (1e9, zs[-1])
    for k in range(len(pts) - 1):
        ax, ay = pts[k]
        bx, by = pts[k + 1]
        dx, dy = bx - ax, by - ay
        t = max(0.0, min(1.0, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)))
        d = math.hypot(x - (ax + dx * t), y - (ay + dy * t))
        if d < best[0]:
            best = (d, zs[k] + (zs[k + 1] - zs[k]) * t)
    return best

def river_info(x, y):
    return poly_info(STREAM, STREAM_Z, x, y)

def pool_d(x, y, c=POOL_C, r=POOL_R):
    """Normalised ellipse distance (1 = the shore)."""
    return math.hypot((x - c[0]) / r[0], (y - c[1]) / r[1])

def terrain_h(x, y):
    a = abs(x)
    if y > -16.0 and a < 8.0:
        return 0.0                                   # the duel floor
    h = 7.5 * smooth(side_floor(y), 47.0, a)          # valley walls
    if y < -16.0:
        h += 0.6 * smooth(-16.0, -55.0, y) + (TERRACE_Z - 0.6) * smooth(-59.0, -63.5, y)
    h += 0.35 * noise(x, y) * smooth(8.0, 14.0, a) + 0.25 * noise(x * 0.7 + 9, y * 0.6) * smooth(-14.0, -30.0, y)
    pd = pool_d(x, y)
    if pd < 1.35:
        h = min(h, POOL_Z - 0.55 + 0.8 * smooth(0.7, 1.3, pd))
    d, _ = poly_info(OUTLET, [POOL_Z] * 3, x, y)
    if d < 2.8:
        h = min(h, POOL_Z - 0.4 + 0.6 * smooth(1.3, 2.8, d))
    lp = pool_d(x, y, LPOOL_C, LPOOL_R)
    if lp < 1.4:
        h = min(h, LPOOL_Z - 0.45 + 0.75 * smooth(0.7, 1.35, lp))
    d, wz = river_info(x, y)
    if d < 3.4 and -60.0 < y < -48.0:
        h = min(h, wz - 0.4 + 0.75 * smooth(1.5, 3.4, d))
    return max(0.0, h)

def surf(nu, nv, posf, colf, b=None):
    """Quad grid with shared verts; posf(i, j) -> screen point, colf(i, j) per
    face. Outward = (d/di) x (d/dj), like set_kit.grid."""
    b = b or K.CUR[0]
    vs = [[b.bm.verts.new(K.to_b(posf(i, j), b)) for j in range(nv + 1)] for i in range(nu + 1)]
    for i in range(nu):
        for j in range(nv):
            f = b.bm.faces.new((vs[i][j], vs[i][j + 1], vs[i + 1][j + 1], vs[i + 1][j]))
            c = colf(i, j)
            for l in f.loops:
                l[b.col] = c

def steps(a, b, step):
    n = max(1, int(round((b - a) / step)))
    return [a + (b - a) * k / n for k in range(n)]

def ground():
    xs = steps(-45.0, -14.0, 3.1) + steps(-14.0, -4.0, 1.0) + steps(-4.0, 4.0, 0.5) + steps(4.0, 14.0, 1.0) \
        + steps(14.0, 45.0, 3.1) + [45.0]
    ys = steps(Y0, -16.0, 3.0) + steps(-16.0, 48.0, 1.25) + [48.0]
    nu, nv = len(xs) - 1, len(ys) - 1
    Z = [[terrain_h(x, y) for y in ys] for x in xs]

    def pos(i, j):
        return (xs[i], ys[j], Z[i][j] + 0.004)

    def path_w(x, y):
        if y < -24.0:
            return 0.0
        px = 0.35 * math.sin(y * 0.13 + 0.7) + 0.25 * math.sin(y * 0.31)
        hw = 0.95 + 0.3 * math.sin(y * 0.21 + 1.0) + 0.15 * noise(x * 3, y * 2)
        w = 1.0 - smooth(hw * 0.55, hw * 1.35, abs(x - px))
        return w * smooth(-24.0, -12.0, y)

    def col(i, j):
        if i == 0 or j == 0 or i == nu - 1 or j == nv - 1:
            return P["edge"]
        x, y = (xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2
        z = (Z[i][j] + Z[i + 1][j] + Z[i][j + 1] + Z[i + 1][j + 1]) / 4
        n1, n2 = noise(x * 0.9, y * 0.9), noise(x * 2.3 + 5, y * 1.9)
        c = K.mix(P["grass"], P["grass_lt"], max(0.0, n1) * 0.8)
        c = K.mix(c, P["grass_dk"], max(0.0, -n1) * 0.55)
        c = K.mix(c, P["clover"], max(0.0, n2 - 0.35) * 0.9)
        c = K.mix(c, P["grass_dry"], max(0.0, noise(x * 0.4 + 3, y * 0.5 - 2) - 0.4) * 1.1)
        # slopes: darker, mossier, with the odd rocky patch
        sl = max(abs(Z[i + 1][j] - Z[i][j]) / max(0.1, xs[i + 1] - xs[i]),
                 abs(Z[i][j + 1] - Z[i][j]) / max(0.1, ys[j + 1] - ys[j]))
        c = K.mix(c, P["slope"], smooth(0.12, 0.45, sl) * 0.7)
        c = K.mix(c, P["rock_dk"], smooth(0.5, 0.9, sl) * 0.5 * max(0.0, n2))
        pw = path_w(x, y)
        if pw > 0:
            pc = K.mix(P["path"], P["path_dk"], max(0.0, n2) * 0.6)
            c = K.mix(c, pc, pw)
        # banks: mud/soil at the pool and river edges
        pd = pool_d(x, y)
        dr, wz = river_info(x, y)
        bank = max(1.0 - smooth(1.0, 1.4, pd), 1.0 - smooth(1.0, 1.45, pool_d(x, y, LPOOL_C, LPOOL_R)),
                   (1.0 - smooth(2.0, 3.6, dr)) if -60.0 < y < -48.0 else 0.0)
        c = K.mix(c, P["bank"], bank * 0.75)
        # melt into the flat edge colour near the band border
        e = min(xs[i] - X0, X1 - xs[i + 1], ys[j] - Y0, Y1 - ys[j + 1])
        c = K.mix(P["edge"], c, smooth(0.0, 6.0, e))
        return K.jit(c, 0.03, R)

    surf(nu, nv, pos, col)

# --- cliff + waterfall ---------------------------------------------------------------------
FALLS_X = (-11.0, -1.0)            # notch
LIP_Z = 24.3
LEDGE_Z = 12.4

def cliff_base_y(x):
    return -80.0 + 24.0 * smooth(25.0, 75.0, abs(x + 5.0))

def cliff_top(x):
    u = abs(x + 6.0)
    base = 30.0 + 3.5 * math.sin(x * 0.083 + 1.0) + 2.2 * math.sin(x * 0.21 + 0.3) + 1.2 * math.sin(x * 0.57)
    base -= 9.0 * smooth(45.0, 75.0, abs(x + 5.0))
    return LIP_Z + (base - LIP_Z) * smooth(4.6, 9.0, u)

def in_notch(x):
    return 1.0 - smooth(5.6, 7.4, abs(x + 6.0))

def cliff():
    xs = steps(-82.0, 72.0, 1.7) + [72.0]
    ni = 16
    nj = len(xs) - 1

    def zb(x):
        return terrain_h(x, cliff_base_y(x)) - 1.2

    def pos(i, j):
        x = xs[j]
        b, top = zb(x), cliff_top(x)
        t = i / ni
        z = b + (top - b) * t
        nz = in_notch(x)
        # buttresses (low-frequency vertical ribs) + stepped strata ledges
        relief = (1.8 * math.sin(x * 0.27 + 0.6 * math.sin(z * 0.11)) + 0.7 * math.sin(x * 0.61 + 1.3)
                  + 0.35 * noise(x * 0.4, z * 0.3)) * (1 - nz)
        ledge = -0.5 * (int(z / 4.3) % 2) * (1 - nz)
        y = cliff_base_y(x) + relief + ledge - 0.09 * (z - b) - 1.3 * nz
        if i == ni:
            y -= 0.6  # rounded top edge
        return (x, y, z)

    def col(i, j):
        x = (xs[j] + xs[j + 1]) / 2
        b, top = zb(x), cliff_top(x)
        z = b + (top - b) * (i + 0.5) / ni
        band = math.sin(z * 0.55 + 1.8 * noise(x * 0.05, z * 0.04)) * 0.5 + 0.5
        c = K.mix(P["cliff_dk"], P["cliff"], 0.35 + 0.65 * band)
        c = K.mix(c, P["cliff_lt"], max(0.0, noise(x * 0.11, z * 0.13)) * 0.5)
        if noise(x * 0.9 + 4.0, 1.0) > 0.72:                  # sparse vertical cracks
            c = K.mix(c, P["crack"], 0.4)
        if i >= ni - 1 or (i % 4 == 3 and noise(x * 0.3, z * 0.2) > 0.25):  # moss: rim + some ledges
            c = K.mix(c, P["cliff_moss"], 0.5)
        nz = in_notch(x)
        if nz > 0 and z < LIP_Z + 1:                            # wet rock behind the water
            c = K.mix(c, P["wet"], 0.75 * nz)
        return K.jit(c, 0.025, R)

    surf(ni, nj, pos, col)

def sheet(x0, x1, z0, z1, y_top, y_bot, nu=8, nv=11, flare=0.0):
    """Falling water: a camera-facing sheet from (y_top, z1) arcing out to
    (y_bot, z0). Columns read as streaks, the bottom rows as foam."""
    streak = [R.random() for _ in range(nu)]

    def pos(i, j):
        t = 1.0 - i / nv            # 0 at the lip, 1 at the bottom
        z = z1 + (z0 - z1) * t
        y = y_top + (y_bot - y_top) * (1 - (1 - t) ** 4)
        w = (x1 - x0) * (1 + flare * t)
        cx = (x0 + x1) / 2
        x = cx - w / 2 + w * j / nu + 0.12 * math.sin(i * 1.7 + j * 2.3)
        return (x, y, z)

    def col(i, j):
        t = 1.0 - (i + 0.5) / nv
        s = streak[j]
        c = P["falls_w"] if s > 0.55 else (P["falls_m"] if s > 0.2 else P["falls_e"])
        if j == 0 or j == nu - 1:
            c = K.mix(c, P["falls_e"], 0.6)
        c = K.mix(c, P["foam"], smooth(0.8, 1.0, t))
        return K.jit(c, 0.04, R)

    surf(nv, nu, pos, col)

def falls():
    with K.into(K.water()):
        # upper tier: lip -> ledge
        sheet(-10.4, -1.6, LEDGE_Z + 0.1, LIP_Z + 0.1, -83.3, -80.4, nu=8, nv=11, flare=0.12)
        # lower tier: ledge -> pool
        sheet(-11.6, -0.4, POOL_Z, LEDGE_Z + 0.2, -79.1, -77.4, nu=10, nv=8, flare=0.15)
        # spray mounds where the water lands
        for (x, s) in ((-6.0, 1.7), (-9.3, 1.1), (-2.8, 1.2)):
            K.blob((x, -77.0, POOL_Z), s, P["foam"], sub=1, squash=0.55, col_top=P["falls_w"])
    # ledge shelf + its lip rocks (wet)
    K.box((-6.0, -81.0, LEDGE_Z - 0.6), (15.0, 3.4, 1.3), P["wet"], skip=("-z", "-y"),
          colf=lambda k: P["cliff_moss"] if k == "+z" else P["wet"])
    for k in range(7):
        K.rock((-13.0 + k * 2.1 + R.uniform(-0.4, 0.4), -79.4, LEDGE_Z - 0.5), R.uniform(0.6, 1.1), P["wet"])
    # wet boulders around the pool base
    for k in range(12):
        a = math.pi * (0.05 + 0.9 * k / 11)
        x = POOL_C[0] + math.cos(a) * POOL_R[0] * 0.98
        y = POOL_C[1] - math.sin(a) * POOL_R[1] * 0.4 - 3.4
        K.rock((x, y, POOL_Z - 0.6), R.uniform(0.7, 1.6), P["wet"] if k % 2 else P["rock_dk"])

def ellipse_water(c, r, z, deep, shallow, foam_at=None, nr=4, na=24):
    """Flat water disc (rings + centre cap), ripples at runtime."""
    rs = [0.12 + 0.88 * (k / nr) for k in range(nr + 1)]

    def ppos(i, j):
        a = 2 * math.pi * (j % na) / na
        return (c[0] + math.cos(a) * r[0] * rs[i], c[1] + math.sin(a) * r[1] * rs[i], z)

    def pcol(i, j):
        a = 2 * math.pi * (j + 0.5) / na
        rr = (rs[i] + rs[i + 1]) / 2
        x, y = c[0] + math.cos(a) * r[0] * rr, c[1] + math.sin(a) * r[1] * rr
        col = K.mix(deep, shallow, smooth(0.55, 1.0, rr))
        if foam_at:
            col = K.mix(col, P["foam"], 0.9 * (1.0 - smooth(1.5, 5.5, math.hypot((x - foam_at[0]) * 0.6, y - foam_at[1]))))
        return K.jit(col, 0.04, R)

    surf(nr, na, ppos, pcol)
    K.face([ppos(0, j) for j in range(na)], deep)

def strip_water(pts, w0, w1, cols):
    """Flat ribbon along pts (x, y, z) from width w0 to w1."""
    n = len(pts) - 1
    for k in range(n):
        a, b = Vector(pts[k]), Vector(pts[k + 1])
        d = b - a
        side = Vector((-d.y, d.x, 0)).normalized()
        wa, wb = w0 + (w1 - w0) * k / n, w0 + (w1 - w0) * (k + 1) / n
        q = [a - side * wa, a + side * wa, b + side * wb, b - side * wb]
        for v in q:
            v.z += 0.02
        if (q[1] - q[0]).cross(q[3] - q[0]).z < 0:
            q = list(reversed(q))
        K.face([tuple(v) for v in q], K.jit(cols[k % len(cols)], 0.05, R))

def pool_and_river():
    with K.into(K.water()):
        ellipse_water(POOL_C, POOL_R, POOL_Z, P["pool_deep"], P["pool_sh"], foam_at=(-6.0, -77.2))
        strip_water([(POOL_C[0] - 4.0, POOL_C[1] + 3.0, POOL_Z)] + [(x, y, POOL_Z) for (x, y) in OUTLET],
                    2.2, 2.6, [P["river"], P["river_lt"]])
        # outlet cascade over the terrace lip (camera-facing, left of the foe ray)
        sheet(CASCADE_X[0], CASCADE_X[1], LPOOL_Z, POOL_Z + 0.05, -62.8, -59.2, nu=6, nv=6, flare=0.1)
        ellipse_water(LPOOL_C, LPOOL_R, LPOOL_Z, P["pool_deep"], P["pool_sh"], foam_at=(-19.8, -59.4), nr=3, na=16)
        strip_water([(LPOOL_C[0] - 3.2, LPOOL_C[1] + 0.2, LPOOL_Z)] + [(x, y, z) for (x, y), z in zip(STREAM, STREAM_Z)],
                    1.7, 1.4, [P["river"], P["river_lt"], P["river"]])
        K.blob((-19.8, -59.6, LPOOL_Z), 0.9, P["foam"], sub=1, squash=0.6, col_top=P["falls_w"])
    # rocks flanking the cascade + along the stream banks
    for (x, s_) in ((CASCADE_X[0] - 0.8, 1.5), (CASCADE_X[1] + 0.9, 1.7), (CASCADE_X[1] + 2.6, 1.1),
                    (CASCADE_X[0] - 2.4, 1.2)):
        K.rock((x, -61.4, terrain_h(x, -61.4) - 0.3), s_, P["wet"] if s_ > 1.3 else P["rock_dk"])
    for k in range(12):
        s_ = R.random()
        i = min(len(STREAM) - 2, int(s_ * (len(STREAM) - 1)))
        t = s_ * (len(STREAM) - 1) - i
        ax, ay = STREAM[i]
        bx, by = STREAM[i + 1]
        x, y = ax + (bx - ax) * t, ay + (by - ay) * t
        dx, dy = bx - ax, by - ay
        L = math.hypot(dx, dy)
        sd = R.choice((-1, 1)) * R.uniform(1.8, 2.6)
        x, y = x - dy / L * sd, y + dx / L * sd
        K.rock((x, y, terrain_h(x, y) - 0.1), R.uniform(0.3, 0.6), P["rock_dk"] if k % 3 else P["wet"])

# --- vegetation -------------------------------------------------------------------------------
def pine(x, y, h, z=None, tiers=3, segs=7, trunk=True, cols=None):
    z = terrain_h(x, y) if z is None else z
    cols = cols or (P["pine_dk"], P["pine"], P["pine_lt"])
    if trunk:
        with K.into(K.paint()):
            K.cyl((x, y, z - 0.2), 0.16 + h * 0.012, h * 0.35, 5, P["bark_dk"], r2=0.1, caps=(False, False))
    r0 = h * 0.26
    for k in range(tiers):
        zb = z + h * (0.2 + 0.26 * k)
        rr = r0 * (1.0 - 0.24 * k)
        K.cone((x, y, zb), rr, h * (0.5 - 0.06 * k), segs, K.jit(cols[min(k, 2)], 0.06, R),
               rot=(0, 0, R.random() * 6.28), tip_col=K.jit(cols[min(k + 1, 2)], 0.05, R))

def card_pine(x, y, z, h, col, col_top=None):
    """Camera-facing pine silhouette (3 stacked triangles) for far forests."""
    w = h * 0.24
    for k in range(3):
        zb = z + h * (0.12 + 0.27 * k)
        ww = w * (1 - 0.25 * k)
        top = (x + R.uniform(-0.15, 0.15) * w, y, zb + h * 0.42)
        c = K.jit(col if k < 2 or col_top is None else col_top, 0.07, R)
        K.face([(x + ww, y, zb), (x - ww, y, zb), top], c)

def broadleaf(x, y, h, birch=False):
    z = terrain_h(x, y)
    with K.into(K.paint()):
        K.cyl((x, y, z - 0.2), 0.24 if not birch else 0.17, h * 0.58, 6, P["birch"] if birch else P["bark"],
              r2=0.15 if not birch else 0.11, caps=(False, False))
    with K.into(K.foliage()):
        r = h * 0.3
        K.blob((x, y, z + h * 0.66), r, P["leaf"], sub=1, squash=0.85, lump=0.22, col_top=P["leaf_lt"])
        a = R.random() * 6.28
        K.blob((x + math.cos(a) * r * 0.75, y + math.sin(a) * r * 0.6, z + h * 0.5), r * 0.72, P["leaf_dk"],
               sub=1, squash=0.8, lump=0.22, col_top=P["leaf"])

def bush(x, y, r, sub=1):
    z = terrain_h(x, y)
    K.blob((x, y, z + r * 0.45), r, P["bush"], sub=sub, squash=0.72, lump=0.25, col_top=P["bush_lt"])

def two_sided(pts, cols, eps=0.004):
    """Thin card seen from both sides: two opposite faces pushed eps apart
    along their own normals, so neither shadows the other in the AO bake
    (coincident twins came out fully occluded)."""
    v = [Vector(p) for p in pts]
    n = (v[1] - v[0]).cross(v[2] - v[0])
    if n.length < 1e-9:
        return
    n.normalize()
    K.face([tuple(p + n * eps) for p in v], cols)
    K.face([tuple(p - n * eps) for p in reversed(v)], list(reversed(cols)) if isinstance(cols, list) else cols)

def fern(x, y, s):
    z = terrain_h(x, y)
    n = 5
    a0 = R.random() * 6.28
    for k in range(n):
        a = a0 + 2 * math.pi * k / n + R.uniform(-0.2, 0.2)
        d = Vector((math.cos(a), math.sin(a), 0))
        sd = Vector((-d.y, d.x, 0))
        L = s * R.uniform(0.85, 1.15)
        b = Vector((x, y, z + 0.02))
        m = b + d * L * 0.5 + Vector((0, 0, L * 0.42))
        t = b + d * L + Vector((0, 0, L * 0.12))
        wb, wm = L * 0.03, L * 0.16
        cb = K.jit(P["fern"], 0.08, R)
        ct = K.jit(P["fern_lt"], 0.08, R)
        q = [b - sd * wb, b + sd * wb, m + sd * wm, m - sd * wm]
        tri = [m - sd * wm, m + sd * wm, t]
        two_sided(q, [cb, cb, ct, ct])
        two_sided(tri, [ct, ct, ct])

def tuft(x, y, h, n=3, dry=False):
    z = terrain_h(x, y)
    for k in range(n):
        a = R.random() * 6.28
        b = Vector((x + math.cos(a) * 0.08, y + math.sin(a) * 0.08, z))
        lean = Vector((math.cos(a), math.sin(a), 0)) * h * R.uniform(0.15, 0.4)
        tip = b + lean + Vector((0, 0, h * R.uniform(0.75, 1.05)))
        sd = Vector((-math.sin(a + 1.2), math.cos(a + 1.2), 0)) * h * 0.06
        c0 = K.jit(P["tuft_dry"] if dry else P["tuft"], 0.08, R)
        c1 = K.jit(P["tuft_lt"], 0.06, R)
        two_sided([b - sd, b + sd, tip], [c0, c0, c1])

def boulder(x, y, r, pale=True, squash=0.62):
    z = terrain_h(x, y)
    K.blob((x, y, z + r * 0.18), r, P["rock"] if pale else P["rock_dk"], sub=1, squash=squash, lump=0.16,
           col_top=P["rock_lt"] if pale else P["rock"])

def rock_mass(cx, cy, z0, z1, rx, ry, segs=14, rows=9, seed=0.0, lean=0.3):
    """Stratified rock tower: polar surface with ledges every ~1.8m + top cap."""
    def rad(i, j):
        t = i / rows
        z = z0 + (z1 - z0) * t
        th = -2 * math.pi * (j % segs) / segs
        ledge = 0.07 if (int((z - z0) / 1.9) % 2) else 0.0
        n = (1.0 + 0.22 * noise(math.cos(th) * 1.6 + seed, math.sin(th) * 1.6 + z * 0.12)
             + 0.08 * math.sin(th * 5.0 + seed) - ledge)
        k = (1.0 - lean * t) * n
        return th, z, k

    def pos(i, j):
        th, z, k = rad(i, j)
        return (cx + math.cos(th) * rx * k, cy + math.sin(th) * ry * k, z)

    def col(i, j):
        z = z0 + (z1 - z0) * (i + 0.5) / rows
        band = 0.5 + 0.5 * math.sin(z * 1.75 + seed)
        c = K.mix(P["cliff_dk"], P["cliff_lt"], 0.25 + 0.6 * band)
        if i == rows - 1 or (i % 3 == 2 and noise(j * 1.3 + seed, z) > 0.1):
            c = K.mix(c, P["cliff_moss"], 0.4)
        return K.jit(c, 0.03, R)

    surf(rows, segs, pos, col)
    top = [pos(rows, j) for j in range(segs)]
    K.face(list(reversed(top)), K.mix(P["cliff_moss"], P["moss"], 0.4))
    return z1

def outcrop():
    """Big pale stratified rock on the right (the ref's right-hand cliff)."""
    t1 = rock_mass(17.2, -2.5, -0.6, 14.5, 5.0, 9.5, segs=18, rows=9, seed=1.0, lean=0.12)
    rock_mass(14.2, 6.6, -0.6, 7.6, 2.9, 3.6, segs=12, rows=5, seed=3.0, lean=0.18)
    rock_mass(20.8, -12.5, -0.6, 11.0, 4.6, 5.2, segs=14, rows=7, seed=5.0, lean=0.2)
    rock_mass(15.6, -9.5, -0.6, 9.5, 3.4, 3.8, segs=12, rows=6, seed=7.0, lean=0.2)
    with K.into(K.paint()):
        pine(17.4, -2.0, 7.0, z=t1 - 0.3, tiers=3)
        pine(18.6, -5.8, 5.6, z=t1 - 0.4, tiers=3)
        pine(21.5, -13.0, 6.0, z=10.7, tiers=3)
        bush(16.0, 1.0, 0.9, sub=0)

def ridge(y, x0, x1, n, hf, cols, rows=4, base=-1.0):
    """Camera-facing curtain at depth y: top height hf(x), strata by row."""
    xs = [x0 + (x1 - x0) * i / n for i in range(n + 1)]
    hs = [hf(x) for x in xs]
    for i in range(n):
        xa, xb, ha, hb = xs[i], xs[i + 1], hs[i], hs[i + 1]
        for r in range(rows):
            za0, za1 = base + (ha - base) * r / rows, base + (ha - base) * (r + 1) / rows
            zb0, zb1 = base + (hb - base) * r / rows, base + (hb - base) * (r + 1) / rows
            K.face(((xa, y, za1), (xb, y, zb1), (xb, y, zb0), (xa, y, za0)), K.jit(cols[r % len(cols)], 0.04, R))

def backdrop():
    # wooded hills behind the cliff, pine silhouettes along their crest
    def hill_h(x):
        return 31.0 + 6.0 * math.sin(x * 0.031 + 0.4) + 4.0 * math.sin(x * 0.083 + 2.0) + 2.0 * math.sin(x * 0.21)
    ridge(-128.0, -340.0, 340.0, 120, hill_h, [P["hill_dk"], P["hill"], P["hill"], P["hill_dk"]], rows=4)
    for k in range(150):
        x = -330.0 + 660.0 * k / 150 + R.uniform(-2.0, 2.0)
        card_pine(x, -127.6, hill_h(x) - 2.5, R.uniform(6.0, 10.0), P["hill_dk"])
    # blue mountains far behind
    def mtn_h(x):
        return max(44.0, 70.0 + 22.0 * math.sin(x * 0.012 + 1.0) + 12.0 * math.sin(x * 0.037 + 0.3)
                   + 6.0 * math.sin(x * 0.09))
    ridge(-230.0, -460.0, 460.0, 90, mtn_h, [P["mtn_dk"], P["mtn"], P["mtn"], P["mtn_lt"]], rows=4)
    # forest on the cliff top (silhouettes over the rim)
    for k in range(95):
        x = -80.0 + 150.0 * k / 95 + R.uniform(-0.6, 0.6)
        if abs(x + 6.0) < 6.5:
            continue
        y = cliff_base_y(x) - 6.0 - R.uniform(0.0, 9.0)
        card_pine(x, y, cliff_top(x) - 1.5, R.uniform(6.0, 11.0), P["pine_dk"], P["pine"])
    # outer forests beyond the valley walls (tops show above the crest)
    for side in (-1, 1):
        for k in range(150):
            x = side * R.uniform(47.0, 120.0)
            y = R.uniform(-108.0, 46.0)
            if y < cliff_base_y(x) - 2.0 and abs(x) < 78.0:
                continue
            card_pine(x, y, 0.0, R.uniform(13.0, 22.0), P["pine_dk"] if R.random() < 0.6 else P["pine"])

def vegetation():
    # --- valley-wall forests (3D pines; far ones cheaper, static in S_Paint) ---
    for side in (-1, 1):
        y = 46.0
        while y > -78.0:
            for x in (side * v for v in (19.0, 24.5, 30.0, 35.5, 41.0)):
                xx = x + R.uniform(-2.2, 2.2)
                yy = y + R.uniform(-1.8, 1.8)
                if yy < cliff_base_y(xx) + 3.0:
                    continue
                if side > 0 and 9.5 < xx < 23.0 and -15.0 < yy < 11.0:
                    continue  # the outcrop
                if abs(xx) < side_floor(yy) + 4.0 and yy < -18.0:
                    continue  # keep the wide pool floor open
                h = R.uniform(9.0, 15.0)
                if yy > -34.0:
                    pine(xx, yy, h)
                else:
                    with K.into(K.paint()):
                        pine(xx, yy, h, tiers=2, segs=6, trunk=False)
            y -= R.uniform(4.6, 6.0)
    # --- meadow edge: broadleaf trees, bushes ---
    for (x, y, h, birch) in ((-12.5, 34.0, 10.5, False), (-15.0, 25.0, 12.0, False), (-11.8, 14.0, 9.0, True),
                             (-14.5, 4.0, 11.5, False), (-12.0, -6.0, 10.0, False), (-16.5, -13.0, 12.5, False),
                             (12.5, 33.0, 10.0, False), (14.5, 22.5, 12.0, False), (11.8, 13.5, 8.5, True),
                             (15.5, 41.0, 11.0, False), (-17.0, 42.0, 12.0, False), (-23.0, -22.0, 11.0, False),
                             (24.0, -24.0, 10.5, False), (-26.0, -36.0, 10.0, True)):
        broadleaf(x, y, h, birch)
    with K.into(K.foliage()):
        for (x, y, r) in ((-9.0, 30.0, 1.0), (-10.0, 20.0, 1.2), (-9.5, 9.0, 1.1), (-10.5, -1.0, 1.3),
                          (-8.6, -11.0, 0.9), (9.2, 28.0, 1.1), (10.0, 18.0, 0.9), (9.6, 38.0, 1.2),
                          (8.4, 12.5, 0.8), (-7.8, 40.0, 0.9), (-13.0, -18.0, 1.4), (12.0, -17.0, 1.2),
                          (-20.0, -30.0, 1.3), (-18.5, -42.0, 1.5), (-33.0, -44.0, 1.6), (-37.0, -49.0, 1.8),
                          (-41.0, -45.0, 1.7), (-30.0, -52.5, 1.3), (16.0, -36.0, 1.4), (22.0, -50.0, 1.5)):
            bush(x, y, r)
        # ferns along the clearing sides
        for k in range(90):
            x = R.choice((-1, 1)) * R.uniform(3.8, 12.0)
            y = R.uniform(-14.0, 46.0)
            if abs(x) < 5.0 and -1.0 < y < 12.0:
                continue  # beside the foe: keep him readable
            fern(x, y, R.uniform(0.55, 1.05))
        # tall grass tufts: thick at the sides, low + sparse in the aisle
        for k in range(470):
            x = R.choice((-1, 1)) * (2.6 + 11.4 * R.random() ** 1.6)
            y = R.uniform(-15.0, 46.0)
            if abs(x) < 4.5 and 0.0 < y < 11.0:
                tuft(x, y, R.uniform(0.18, 0.26))
                continue
            tuft(x, y, R.uniform(0.35, 0.9) * (0.6 if abs(x) < 3.5 else 1.0), n=4, dry=R.random() < 0.2)
        for k in range(70):
            x = R.choice((-1, 1)) * R.uniform(1.2, 2.5)
            y = R.uniform(8.0, 44.0)
            tuft(x, y, R.uniform(0.12, 0.22), n=3)
        # back meadow toward the pool
        for k in range(60):
            x = R.uniform(-28.0, 24.0)
            y = R.uniform(-62.0, -16.0)
            if pool_d(x, y) < 1.3 or river_info(x, y)[0] < 2.6:
                continue
            tuft(x, y, R.uniform(0.3, 0.6), dry=R.random() < 0.3)
    # --- boulders ---
    for (x, y, r, pale) in ((7.6, 5.6, 2.1, True), (5.9, 1.6, 0.9, True), (9.8, 9.8, 1.2, False),
                            (-7.4, 3.0, 1.4, True), (-8.6, 22.0, 0.9, False), (8.2, 24.5, 1.0, True),
                            (-6.6, -9.0, 1.1, True), (6.8, -12.5, 1.5, True), (-11.0, -16.0, 1.8, False),
                            (11.0, -21.0, 1.4, True), (-19.0, -26.0, 2.2, True), (19.5, -31.0, 2.0, False),
                            (-14.0, 45.0, 1.6, True), (6.5, 42.0, 0.8, True)):
        boulder(x, y, r, pale)
    for k in range(26):
        x = R.choice((-1, 1)) * R.uniform(4.0, 16.0)
        y = R.uniform(-30.0, 46.0)
        if abs(x) < 6.0 and -2.0 < y < 12.0:
            continue
        K.rock((x, y, terrain_h(x, y) - 0.05), R.uniform(0.15, 0.4), P["rock"] if R.random() < 0.6 else P["rock_dk"])

def terrace():
    """Bushes and pines along the terrace lip framing the falls; clear in front
    of them (x -14 .. 2) so the lower tier stays in view."""
    for k in range(26):
        x = R.uniform(-44.0, 30.0)
        if -15.0 < x < 3.0 or CASCADE_X[0] - 1.5 < x < CASCADE_X[1] + 1.5:
            continue
        y = R.uniform(-66.0, -62.5)
        bush(x, y, R.uniform(0.9, 1.6), sub=0)
    for k in range(18):
        x = R.choice((R.uniform(-40.0, -24.0), R.uniform(8.0, 30.0)))
        y = R.uniform(-76.0, -64.0)
        if y < cliff_base_y(x) + 2.5:
            continue
        pine(x, y, R.uniform(8.0, 13.0), tiers=2, segs=6, trunk=False)

def clumps():
    """Tree clumps on the back meadow so the valley floor between the foe and
    the falls has depth; kept off the foe ray (x -10 .. 4) and off the sight
    line to the outlet cascade (x -18 .. -11)."""
    centres = [(-24.0, -21.0), (-29.0, -31.0), (-23.5, -40.0), (-33.0, -38.0), (-27.0, -47.0),
               (9.5, -24.0), (14.0, -33.0), (10.5, -44.0), (17.0, -50.0), (22.0, -40.0), (8.5, -55.0)]
    for (cx, cy) in centres:
        for k in range(R.randint(2, 4)):
            x, y = cx + R.uniform(-3.0, 3.0), cy + R.uniform(-2.5, 2.5)
            if R.random() < 0.55:
                pine(x, y, R.uniform(8.0, 13.0), tiers=3 if y > -35 else 2, segs=7 if y > -35 else 6)
            else:
                broadleaf(x, y, R.uniform(7.0, 10.5), birch=R.random() < 0.2)
        with K.into(K.foliage()):
            for k in range(2):
                bush(cx + R.uniform(-3.5, 3.5), cy + R.uniform(1.0, 3.5), R.uniform(0.8, 1.3))

def build():
    K.seed(1859)
    R.seed(1859)
    K.CUR[0] = K.paint()
    ground()
    cliff()
    falls()
    pool_and_river()
    outcrop()
    terrace()
    clumps()
    backdrop()
    vegetation()

K.run("FALLS", build, "Falls", "falls.glb", sky=(0.55, 0.72, 0.9))
