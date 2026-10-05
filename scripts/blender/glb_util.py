"""Shared Blender -> GLB helpers for the generated sets (build_hell.py).

Copied verbatim from build_street.py (which keeps its own copies so its
byte-identical output never depends on this file): sRGB->linear palette,
vertex-colour material, collection reset, GLB export, and slim_glb (drop
NORMAL, COLOR_0 as normalized uint16).
"""
import bpy, os  # noqa: F401

def lin(h):
    def c(v):
        v /= 255.0
        return v / 12.92 if v <= 0.04045 else ((v + 0.055) / 1.055) ** 2.4
    return (c((h >> 16) & 255), c((h >> 8) & 255), c(h & 255), 1.0)

def jit(col, amt, r):
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

