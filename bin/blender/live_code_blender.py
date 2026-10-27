# Live Code: Blender, live in the dashboard.
#
# Laid into Blender's startup scripts by the Live Code dashboard, once you
# switch "Blender live" on there (it takes it away again when you switch it
# off). While Blender runs, also in the background as Claude starts it
# (blender -b ... --python ...), the visible meshes go to
# ~/.claude/live-code-blender as they change, and every finished render is
# named there; the dashboard shows the model turning, and the renders.
# Nothing leaves this PC. Without that folder (Live Code switched off) it does
# nothing at all.
import atexit
import json
import os
import struct
import sys
import time

import bpy
from bpy.app.handlers import persistent

try:
    import numpy as np
except ImportError:  # (every Blender since 2.8 has it)
    np = None

_home = os.environ.get("LIVE_CODE_HOME") or os.path.join(os.path.expanduser("~"), ".claude")
OUT = os.path.join(_home, "live-code-blender")
EVERY = 0.25  # seconds between two snapshots, at least
MAX_TRIS = 400_000  # a bigger scene is cut there
MAX_RENDERS = 12
KINDS = {"MESH", "CURVE", "SURFACE", "FONT", "META"}

_st = {"last": 0.0, "cost": 0.0, "busy": False, "seq": 0, "renders": [], "objects": 0, "tris": 0, "cut": False}


def _on():
    return os.path.isdir(OUT)


def _write(name, data):
    tmp = os.path.join(OUT, "%s.%d.tmp" % (name, os.getpid()))
    with open(tmp, "wb") as f:
        f.write(data)
    # (the dashboard may be reading the old one this very moment: next time then)
    for _ in range(3):
        try:
            os.replace(tmp, os.path.join(OUT, name))
            return True
        except OSError:
            time.sleep(0.05)
    try:
        os.remove(tmp)
    except OSError:
        pass
    return False


def _info(running=True):
    blend = ""
    try:
        blend = os.path.basename(bpy.data.filepath)
    except Exception:
        pass
    info = {
        "v": 1, "pid": os.getpid(), "at": int(time.time() * 1000), "seq": _st["seq"], "running": running,
        "blend": blend, "objects": _st["objects"], "tris": _st["tris"], "cut": _st["cut"],
        "renders": _st["renders"][-MAX_RENDERS:],
    }
    try:
        info["version"] = bpy.app.version_string
    except Exception:
        pass
    _write("info.json", json.dumps(info).encode("utf-8"))


def _srgb(c):
    return max(0.0, min(1.0, c)) ** (1 / 2.2)


def _color(mat, i):
    """What a material looks like, roughly: its viewport colour, else the base
    colour of its shader, else one of a few calm colours by its name."""
    if mat is not None:
        c = tuple(mat.diffuse_color)[:3]
        if any(abs(v - 0.8) > 0.01 for v in c):
            return tuple(_srgb(v) for v in c)
        try:
            for n in mat.node_tree.nodes if mat.use_nodes else ():
                if n.type == "BSDF_PRINCIPLED":
                    v = n.inputs[0].default_value
                    return (_srgb(v[0]), _srgb(v[1]), _srgb(v[2]))
        except Exception:
            pass
    palette = ((0.62, 0.68, 0.76), (0.80, 0.66, 0.50), (0.56, 0.74, 0.62), (0.76, 0.60, 0.70), (0.70, 0.70, 0.56), (0.55, 0.70, 0.78))
    key = mat.name if mat is not None else str(i)
    return palette[sum(map(ord, key)) % len(palette)]


def _snapshot(depsgraph=None):
    """The visible meshes, in world space, one block per object:
    name, vertices, and per material a colour and its triangles."""
    if np is None or _st["busy"] or not _on():
        return
    _st["busy"] = True
    t0 = time.time()
    try:
        dg = depsgraph or bpy.context.evaluated_depsgraph_get()
        blocks, objects, tris, cut = [], 0, 0, False
        for ob in bpy.context.scene.objects:
            if ob.type not in KINDS:
                continue
            try:
                if not ob.visible_get():
                    continue
            except Exception:
                if ob.hide_viewport:
                    continue
            if tris >= MAX_TRIS:
                cut = True
                break
            ev = ob.evaluated_get(dg)
            try:
                me = ev.to_mesh()
            except Exception:
                continue
            try:
                me.calc_loop_triangles()
                nv, nt = len(me.vertices), len(me.loop_triangles)
                if nv == 0 or nt == 0:
                    continue
                if tris + nt > MAX_TRIS:
                    nt = MAX_TRIS - tris
                    cut = True
                co = np.empty(nv * 3, dtype=np.float32)
                me.vertices.foreach_get("co", co)
                idx = np.empty(len(me.loop_triangles) * 3, dtype=np.int32)
                me.loop_triangles.foreach_get("vertices", idx)
                mi = np.empty(len(me.loop_triangles), dtype=np.int32)
                me.loop_triangles.foreach_get("material_index", mi)
                idx, mi = idx[: nt * 3], mi[:nt]
                mw = np.array(ob.matrix_world, dtype=np.float32)
                co = (co.reshape(-1, 3) @ mw[:3, :3].T + mw[:3, 3]).astype(np.float32)
                mats = [s.material for s in ob.material_slots] or [None]
                parts = []
                for m in np.unique(mi):
                    sel = idx.reshape(-1, 3)[mi == m].reshape(-1).astype(np.uint32)
                    mat = mats[m] if 0 <= m < len(mats) else None
                    parts.append(struct.pack("<3fI", *_color(mat, int(m)), sel.size) + sel.tobytes())
                name = ob.name.encode("utf-8")[:200]
                name += b"\0" * (-(len(name) + 2) % 4)
                blocks.append(struct.pack("<H", len(name)) + name + struct.pack("<I", nv) + co.tobytes() + struct.pack("<I", len(parts)) + b"".join(parts))
                objects += 1
                tris += nt
            finally:
                ev.to_mesh_clear()
        data = b"LCB1" + struct.pack("<I", len(blocks)) + b"".join(blocks)
        # (nothing changed since the last one: nothing written)
        sig = hash(data)
        if sig == _st.get("sig"):
            return
        _st["sig"] = sig
        _st["seq"] += 1
        _st["objects"], _st["tris"], _st["cut"] = objects, tris, cut
        if _write("mesh.bin", data):
            _info()
    except Exception as e:  # never in the way of the work itself
        print("live-code: no snapshot (%s)" % e)
    finally:
        _st["busy"] = False
        _st["last"] = time.time()
        _st["cost"] = _st["last"] - t0


def _due():
    # a big scene is looked at less often, so it never slows the work much
    return time.time() - _st["last"] >= max(EVERY, _st["cost"] * 4)


@persistent
def _changed(scene, depsgraph=None):
    if _on() and _due():
        _snapshot(depsgraph)


@persistent
def _loaded(*_):
    if _on():
        _snapshot()


@persistent
def _render_pre(scene, *_):
    if _on():
        _snapshot()
        _st["render_at"] = int(time.time() * 1000)


@persistent
def _render_post(scene, *_):
    """Where this render lands, as far as Blender says; the dashboard picks the
    one written (a still only lands on disk after this)."""
    if not _on():
        return
    try:
        r = scene.render
        path = bpy.path.abspath(r.filepath)
        cands = [path]
        ext = r.file_extension
        if ext and not path.lower().endswith(ext.lower()):
            cands.append(path + ext)
        try:
            cands.append(r.frame_path(frame=scene.frame_current))
        except Exception:
            pass
        _st["renders"].append({"at": _st.get("render_at") or int(time.time() * 1000), "frame": scene.frame_current, "cands": cands, "camera": scene.camera.name if scene.camera else ""})
        _st["renders"] = _st["renders"][-MAX_RENDERS:]
        _info()
    except Exception as e:
        print("live-code: render not noted (%s)" % e)


@persistent
def _saved(*_):
    if _on():
        _snapshot()


# A script that builds through the data (bpy.data, bmesh, from_pydata) gives
# Blender no reason to look at the scene until it saves. So a little clock
# thread asks every STEP_EVERY seconds for a step, and Python takes it in its
# main thread at the next moment it runs Python code (Py_AddPendingCall, the way
# it handles signals): every step of a script shows, at no cost in between. A
# big scene is looked at less often (_due), so the work is never slowed much.
STEP_EVERY = 0.25
_tick = {"stop": False, "asked": False, "cb": None}


def _step(_arg):
    _tick["asked"] = False
    try:
        if _on() and _due():
            _snapshot()
    except BaseException:  # (never an exception into the script)
        pass
    return 0


def _clock():
    import ctypes
    import threading

    add = ctypes.pythonapi.Py_AddPendingCall
    add.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    add.restype = ctypes.c_int
    _tick["cb"] = ctypes.CFUNCTYPE(ctypes.c_int, ctypes.c_void_p)(_step)
    ptr = ctypes.cast(_tick["cb"], ctypes.c_void_p)

    def run():
        while not _tick["stop"]:
            time.sleep(STEP_EVERY)
            if _tick["stop"] or sys.is_finalizing():
                break
            # (one at a time: while Blender sits in its own C code, they do not pile up)
            if not _tick["asked"] and not _st["busy"] and _due():
                _tick["asked"] = True
                add(ptr, None)

    threading.Thread(target=run, name="live-code-blender", daemon=True).start()


def _bye():
    # (bpy is gone by now: only the note that this Blender has ended)
    _tick["stop"] = True
    try:
        if _on():
            path = os.path.join(OUT, "info.json")
            with open(path, "r", encoding="utf-8") as f:
                info = json.load(f)
            if info.get("pid") == os.getpid():
                info["running"] = False
                info["endedAt"] = int(time.time() * 1000)
                _write("info.json", json.dumps(info).encode("utf-8"))
    except Exception:
        pass


_HANDLERS = (
    ("depsgraph_update_post", _changed),
    ("load_post", _loaded),
    ("render_pre", _render_pre),
    ("render_post", _render_post),
    ("save_post", _saved),
)


def register():
    for name, fn in _HANDLERS:
        lst = getattr(bpy.app.handlers, name)
        if fn not in lst:
            lst.append(fn)
    atexit.register(_bye)
    # (Blender with its window: its operators and the handlers above see each change)
    if _on() and bpy.app.background:
        try:
            _clock()
        except Exception as e:
            print("live-code: no step clock (%s)" % e)


def unregister():
    for name, fn in _HANDLERS:
        lst = getattr(bpy.app.handlers, name)
        if fn in lst:
            lst.remove(fn)
    _tick["stop"] = True
