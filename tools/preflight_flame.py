#!/usr/bin/env python3
"""
Preflight for colab_bake_flame.py — verify the FLAME-runner-specific deps EXIST
before you spend GPU time on a full bake. Fast: only file checks, source greps
(to catch LAM signature/path drift), a config-flag check, the driving clip, and a
Blender `bpy` smoke test. NO model build, NO inference. Seconds, not minutes.

Run as a notebook cell (base kernel is fine — no conda env needed; it's all file
checks + a Blender subprocess):
    !python tools/preflight_flame.py --blender_path {BLENDER} --motion Look_In_My_Eyes

Exit code 0 = good to bake. Non-zero = a hard dependency is missing (the printed
line tells you which). WARN lines are non-fatal but worth a glance.
"""
import argparse
import os
import re
import subprocess
import sys
from glob import glob

OK, WARN, FAIL = "  [OK]  ", " [WARN] ", " [FAIL] "
fails: list[str] = []
warns: list[str] = []


def ok(msg: str) -> None: print(OK + msg)
def warn(msg: str) -> None: warns.append(msg); print(WARN + msg)
def fail(msg: str) -> None: fails.append(msg); print(FAIL + msg)


def grep(path: str, *needles: str) -> dict:
    """Return {needle: present?} for each needle (substring) in the file."""
    try:
        txt = open(path, encoding="utf-8", errors="ignore").read()
    except Exception:
        return {n: False for n in needles}
    return {n: (n in txt) for n in needles}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--blender_path", required=True, help="path to Blender >=4.0 executable")
    ap.add_argument("--motion", default="Look_In_My_Eyes", help="driving clip name (provides flame_params.json)")
    ap.add_argument("--lam-root", dest="lam_root", default="",
                    help="LAM repo root (default: cwd if it has app_lam.py, else /content/LAM)")
    args = ap.parse_args()

    # --- locate the LAM repo root ---
    root = args.lam_root or (os.getcwd() if os.path.exists("app_lam.py") else "/content/LAM")
    print(f"LAM root: {root}\nmotion:   {args.motion}\nblender:  {args.blender_path}\n" + "-" * 60)
    if not os.path.exists(os.path.join(root, "app_lam.py")):
        fail(f"{root}/app_lam.py not found — wrong --lam-root or LAM not cloned")
        return summary()

    def P(*p: str) -> str: return os.path.join(root, *p)

    # --- 1. the runner itself (must be uploaded next to LAM) ---
    runner = P("colab_bake_flame.py")
    if os.path.exists(runner):
        ok("colab_bake_flame.py present in LAM root")
    elif os.path.exists("colab_bake_flame.py"):
        ok("colab_bake_flame.py present in cwd")
    else:
        fail("colab_bake_flame.py not found — upload it into the LAM root before baking")

    # --- 2. the FLAME GLB Blender exporter (the big FLAME-only dep) ---
    glb = P("tools", "generateGLBWithBlender_v2.py")
    if not os.path.exists(glb):
        fail(f"MISSING tools/generateGLBWithBlender_v2.py — this LAM checkout lacks the "
             f"FLAME GLB exporter. Update LAM (it's on the `master` branch) or this bake "
             f"can't build skin.glb/vertex_order.json.")
    else:
        ok("tools/generateGLBWithBlender_v2.py present")
        # 2a. functions the runner relies on (catch a rename/refactor)
        g = grep(glb, "def main", "create_armature_from_bone_tree", "apply_vertex_weights",
                 "add_shape_keys", "export_as_glb")
        miss = [k for k, v in g.items() if not v]
        (ok if not miss else warn)(
            "generateGLBWithBlender_v2 functions: " + (", ".join(k for k in g if g[k]) or "—")
            + (f"  (MISSING: {miss})" if miss else ""))
        # 2b. it hardcodes runtime_data/ paths — the runner stages there
        rd = grep(glb, "runtime_data/nature.obj", "runtime_data/skin.glb",
                  "runtime_data/vertex_order.json", "runtime_data/bs")
        if all(rd.values()):
            ok("exporter reads/writes ./runtime_data/* (matches the runner's staging)")
        else:
            warn("exporter's runtime_data/* paths changed — check the runner stages the right dir: "
                 + str(rd))
        # 2c. which OBJ-import op does it use? (Blender 4.x removed import_scene.obj)
        txt = open(glb, encoding="utf-8", errors="ignore").read()
        uses_new = "wm.obj_import" in txt
        uses_old = "import_scene.obj" in txt
        script_obj_op = "wm.obj_import" if uses_new else ("import_scene.obj" if uses_old else "?")
        print(f"         exporter OBJ-import op: {script_obj_op}")

    # --- 3. LAM source: the FLAME export methods exist (grep, no heavy import) ---
    flames = glob(P("lam", "**", "flame.py"), recursive=True)
    flame_py = next((f for f in flames if "flame_model" in f), flames[0] if flames else None)
    if not flame_py:
        fail("could not find lam/.../flame_model/flame.py")
    else:
        fg = grep(flame_py, "def save_h5_info", "def save_bone_tree")
        if all(fg.values()):
            ok(f"flame_model has save_h5_info + save_bone_tree ({os.path.relpath(flame_py, root)})")
        else:
            fail(f"flame_model missing { [k for k,v in fg.items() if not v] } in {flame_py} — "
                 f"LAM signature drift; the FLAME export branch won't run as written")

    # --- 4. GaussianModel.save_ply supports offset2xyz (offset.ply) ---
    gms = glob(P("lam", "**", "*gaussian*model*.py"), recursive=True) or \
          glob(P("lam", "**", "gaussian_model.py"), recursive=True)
    if any(grep(f, "def save_ply").get("def save_ply") and grep(f, "offset2xyz").get("offset2xyz") for f in gms):
        ok("GaussianModel.save_ply supports offset2xyz (offset.ply)")
    else:
        warn("couldn't confirm save_ply(offset2xyz=...) by grep — OAC bake uses it too, so likely fine")

    # --- 5. config has the teeth flag ---
    cfgp = P("configs", "inference", "lam-20k-8gpu.yaml")
    if os.path.exists(cfgp) and grep(cfgp, "add_teeth").get("add_teeth"):
        cur = re.search(r"add_teeth:\s*(\w+)", open(cfgp).read())
        ok(f"config has model.add_teeth (currently {cur.group(1) if cur else '?'}; runner sets it True)")
    elif os.path.exists(cfgp):
        warn("config lacks an add_teeth line — runner sets cfg.model.add_teeth=True anyway; verify it takes")
    else:
        fail(f"missing config {os.path.relpath(cfgp, root)}")

    # --- 6. driving clip → flame_params.json (the 6th file, not generated) ---
    clip = P("assets", "sample_motion", "export", args.motion)
    if not os.path.isdir(clip):
        fail(f"motion clip not found: {os.path.relpath(clip, root)} "
             f"(pick one from assets/sample_motion/export/)")
    else:
        ok(f"motion clip exists: {args.motion}")
        if not os.path.isdir(os.path.join(clip, "flame_param")):
            fail(f"{args.motion}/flame_param/ missing (needed by prepare_motion_seqs)")
        else:
            ok(f"{args.motion}/flame_param/ present")
        fp = (glob(os.path.join(clip, "flame_params.json"))
              or glob(os.path.join(clip, "**", "flame_params.json"), recursive=True))
        if fp:
            ok(f"flame_params.json found: {os.path.relpath(fp[0], root)}")
        else:
            fail(f"no flame_params.json under {args.motion} — pass --flame-params to the runner "
                 f"(keys: translation, rotation, neck_pose, jaw_pose, eyes_pose, shape, expr)")

    # --- 7. Blender binary + version ---
    if not os.path.exists(args.blender_path):
        fail(f"blender not found at {args.blender_path}")
        return summary()
    try:
        v = subprocess.run([args.blender_path, "--version"], capture_output=True, text=True, timeout=60)
        line = (v.stdout or v.stderr).splitlines()[0].strip()
        m = re.search(r"Blender\s+(\d+)\.(\d+)", line)
        major = int(m.group(1)) if m else 0
        (ok if major >= 4 else warn)(f"{line}" + ("" if major >= 4 else "  (need >=4.0 for wm.obj_import / gltf)"))
    except Exception as e:
        warn(f"couldn't read Blender version: {e}")

    # --- 8. Blender bpy smoke: the ops the exporter needs actually exist ---
    smoke = "/tmp/_bl_smoke.py"
    open(smoke, "w").write(
        "import bpy, addon_utils\n"
        "print('OBJ_IMPORT_NEW', hasattr(bpy.ops.wm, 'obj_import'))\n"
        "print('OBJ_IMPORT_OLD', hasattr(bpy.ops.import_scene, 'obj'))\n"
        "try:\n"
        "    addon_utils.enable('io_scene_gltf2', default_set=True)\n"
        "except Exception as e:\n"
        "    print('GLTF_ENABLE_ERR', e)\n"
        "print('GLTF_EXPORT', hasattr(bpy.ops.export_scene, 'gltf'))\n"
    )
    try:
        r = subprocess.run([args.blender_path, "--background", "--python", smoke],
                           capture_output=True, text=True, timeout=180)
        out = r.stdout + r.stderr
        flags = dict(re.findall(r"(OBJ_IMPORT_NEW|OBJ_IMPORT_OLD|GLTF_EXPORT)\s+(True|False)", out))
        new = flags.get("OBJ_IMPORT_NEW") == "True"
        old = flags.get("OBJ_IMPORT_OLD") == "True"
        gltf = flags.get("GLTF_EXPORT") == "True"
        (ok if gltf else fail)(f"Blender glTF exporter (export_scene.gltf) available: {gltf}")
        ok(f"Blender OBJ import ops: wm.obj_import={new}  import_scene.obj={old}")
        # cross-check the exporter's op against what this Blender actually has
        if os.path.exists(glb):
            txt = open(glb, encoding="utf-8", errors="ignore").read()
            if "wm.obj_import" in txt and not new:
                fail("exporter uses wm.obj_import but this Blender lacks it (need Blender >=4.0)")
            if "import_scene.obj" in txt and not old:
                fail("exporter uses import_scene.obj (legacy) but this Blender removed it "
                     "(Blender 4.x) — exporter/Blender version mismatch")
            if not new and not old:
                warn("could not determine Blender OBJ-import support from smoke output")
    except Exception as e:
        warn(f"Blender bpy smoke test skipped: {e}")

    summary()


def summary() -> None:
    print("-" * 60)
    if fails:
        print(f"❌ PREFLIGHT FAILED — {len(fails)} hard issue(s); fix before baking:")
        for f in fails:
            print("   • " + f)
        sys.exit(1)
    if warns:
        print(f"✅ PREFLIGHT OK ({len(warns)} warning(s) — non-fatal). Good to run colab_bake_flame.py.")
    else:
        print("✅ PREFLIGHT OK — all FLAME-bake deps present. Good to run colab_bake_flame.py.")
    sys.exit(0)


if __name__ == "__main__":
    main()
