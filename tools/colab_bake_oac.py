#!/usr/bin/env python3
"""
Headless LAM → OpenAvatarChat (OAC) bake — one image in, one OAC zip out.

This is the gradio-free path used by the Colab notebook (LAM_bake_oac_colab.ipynb).
It is adapted *faithfully* from `app_lam.py`'s `core_fn` OAC-export branch
(the part gated behind the "Export ZIP file for Chatting Avatar" checkbox), with
the video-rendering steps stripped out — we only need the four OAC files.

Run from inside the cloned LAM repo:
    python colab_bake_oac.py \
        --image assets/sample_input/fisherman.jpg \
        --blender_path /content/blender-4.0.2-linux-x64/blender \
        --motion auto

Output: ./output/open_avatar_chat/<image-stem>.zip containing
    <image-stem>/skin.glb, offset.ply, animation.glb, vertex_order.json
i.e. exactly LAM's OAC format (see ints-head-gs/docs/AVATAR_FORMAT.md). NOT
h5_render_data.zip.

⚠️ This orchestration mirrors LAM internals at a point in time. If LAM changes a
signature (infer_single_view / prepare_motion_seqs / save_shaped_mesh), this will
raise — fall back to the notebook's Gradio cell, which runs LAM's own code.
"""
import argparse
import os
import sys
import shutil
import zipfile
from glob import glob
from pathlib import Path


def find_motion(motion_arg: str) -> str:
    """Pick a driving motion-sequence dir (provides flame shape + render params)."""
    if motion_arg and motion_arg != "auto":
        d = f"./assets/sample_motion/export/{motion_arg}"
        assert os.path.isdir(d), f"motion not found: {d}"
        return d
    cands = sorted(glob("./assets/sample_motion/export/*/"))
    assert cands, "no sample motions under assets/sample_motion/export/ — did the assets download succeed?"
    # prefer the one LAM's own inference.sh uses, if present
    for c in cands:
        if "Look_In_My_Eyes" in c:
            return c.rstrip("/")
    return cands[0].rstrip("/")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", required=True, help="input portrait, e.g. assets/sample_input/fisherman.jpg")
    ap.add_argument("--blender_path", required=True, help="path to Blender >4.0 executable")
    ap.add_argument("--motion", default="auto", help="motion seq name under assets/sample_motion/export, or 'auto'")
    ap.add_argument("--shape-edit", dest="shape_edit", default="",
                    help="warp FLAME shape dims as deltas on the fitted shape, e.g. "
                         "'0:+1.5,3:-1.0'. Abstract FLAME PCA dims (not nose/jaw). "
                         "Same edit must be reused to reproduce a variant; bake several "
                         "to compare in the spike's variant switcher.")
    ap.add_argument("--tag", default="",
                    help="suffix for the output name so variants don't collide, e.g. "
                         "--tag s0plus -> <image>_s0plus.zip (distinct zip + inner folder "
                         "+ switcher chip). Use a different tag per variant bake.")
    args = ap.parse_args()

    assert os.path.exists(args.image), f"image not found: {args.image}"
    assert os.path.exists(args.blender_path), f"blender not found: {args.blender_path}"

    # --- env + config, copied from app_lam.launch_gradio_app -----------------
    os.environ.update({
        "APP_ENABLED": "1",
        "APP_MODEL_NAME": "./model_zoo/lam_models/releases/lam/lam-20k/step_045500/",
        "APP_INFER": "./configs/inference/lam-20k-8gpu.yaml",
        "APP_TYPE": "infer.lam",
        "NUMBA_THREADING_LAYER": "omp",
    })

    import torch
    import app_lam  # importing does NOT launch gradio (that's under __main__)
    from tools.generateARKITGLBWithBlender import generate_glb
    from lam.runners.infer.head_utils import prepare_motion_seqs, preprocess_image

    # parse_configs reads --blender_path off sys.argv; hand it a clean argv.
    sys.argv = ["colab_bake_oac.py", "--blender_path", args.blender_path]
    cfg, _ = app_lam.parse_configs()

    print("building model + flame tracking…")
    lam = app_lam._build_model(cfg)
    lam.to("cuda").eval()

    from tools.flame_tracking_single_image import FlameTrackingSingleImage
    flametracking = FlameTrackingSingleImage(
        output_dir="output/tracking",
        alignment_model_path="./model_zoo/flame_tracking_models/68_keypoints_model.pkl",
        vgghead_model_path="./model_zoo/flame_tracking_models/vgghead/vgg_heads_l.trcd",
        human_matting_path="./model_zoo/flame_tracking_models/matting/stylematte_synth.pt",
        facebox_model_path="./model_zoo/flame_tracking_models/FaceBoxesV2.pth",
        detect_iris_landmarks=False,
    )

    clip_dir = find_motion(args.motion)
    # LAM's core_fn passes the clip's `flame_param` subdir; prepare_motion_seqs then
    # reads transforms.json from its PARENT (the clip dir). Passing the clip dir
    # itself makes it look for transforms.json one level too high.
    motion_seqs_dir = os.path.join(clip_dir, "flame_param")
    assert os.path.isdir(motion_seqs_dir), f"missing flame_param dir: {motion_seqs_dir}"
    base_iid = os.path.basename(args.image).split(".")[0]
    if args.tag.strip():
        # keep names filesystem/URL-safe so variants get distinct zip + folder + chip
        safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in args.tag.strip())
        base_iid = f"{base_iid}_{safe}"
    print(f"image={args.image}  iid={base_iid}  clip={clip_dir}  motion_seqs_dir={motion_seqs_dir}")

    # --- flame tracking on the input image (core_fn steps) -------------------
    tmp_dir = "output/_bake_tmp"
    os.makedirs(tmp_dir, exist_ok=True)
    image_raw = os.path.join(tmp_dir, "raw.png")
    from PIL import Image
    with Image.open(args.image).convert("RGB") as im:
        im.save(image_raw)

    assert flametracking.preprocess(image_raw) == 0, "flametracking preprocess failed"
    assert flametracking.optimize() == 0, "flametracking optimize failed"
    rc, output_dir = flametracking.export()
    assert rc == 0, "flametracking export failed"

    image_path = os.path.join(output_dir, "images/00000_00.png")
    mask_path = os.path.join(output_dir, "fg_masks/00000_00.png")

    aspect_standard = 1.0 / 1.0
    image, _, _, shape_param = preprocess_image(
        image_path, mask_path=mask_path, intr=None, pad_ratio=0, bg_color=1.0,
        max_tgt_size=None, aspect_standard=aspect_standard, enlarge_ratio=[1.0, 1.0],
        render_tgt_size=cfg.source_size, multiply=14, need_mask=True, get_shape_param=True,
    )

    # --- optional shape warp (applied to the fitted betas, BEFORE all consumers) ---
    # Must run before prepare_motion_seqs/infer/save_shaped_mesh so the gaussians AND
    # the skin.glb mesh get the same modified shape (else they desync).
    if args.shape_edit.strip():
        edits = []
        for tok in args.shape_edit.split(","):
            if not tok.strip():
                continue
            dim_s, delta_s = tok.split(":")
            dim, delta = int(dim_s), float(delta_s)
            assert 0 <= dim < shape_param.shape[-1], f"shape dim {dim} out of range (0..{shape_param.shape[-1]-1})"
            shape_param[dim] += delta
            edits.append(f"dim{dim}{delta:+g}")
        print(f"shape-edit applied to fitted betas: {', '.join(edits)}")

    src = image_path.split("/")[-3]
    driven = motion_seqs_dir.split("/")[-2]
    motion_seq = prepare_motion_seqs(
        motion_seqs_dir, None, save_root=tmp_dir, fps=30, bg_color=1.0,
        aspect_standard=aspect_standard, enlarge_ratio=[1.0, 1, 0],
        render_image_res=cfg.render_size, multiply=16, need_mask=False,
        vis_motion=False, shape_param=shape_param, test_sample=False,
        cross_id=False, src_driven=[src, driven],
    )

    # --- inference → canonical gaussians -------------------------------------
    device, dtype = "cuda", torch.float32
    motion_seq["flame_params"]["betas"] = shape_param.unsqueeze(0)
    print("running LAM inference…")
    with torch.no_grad():
        res = lam.infer_single_view(
            image.unsqueeze(0).to(device, dtype), None, None,
            render_c2ws=motion_seq["render_c2ws"].to(device),
            render_intrs=motion_seq["render_intrs"].to(device),
            render_bg_colors=motion_seq["render_bg_colors"].to(device),
            flame_params={k: v.to(device) for k, v in motion_seq["flame_params"].items()},
        )

    # --- OAC export (app_lam.py lines ~304-342, minus the video) -------------
    oac_dir = os.path.join("./output/open_avatar_chat", base_iid)
    os.makedirs(oac_dir, exist_ok=True)
    print("writing offset.ply…")
    saved_head_path = lam.renderer.flame_model.save_shaped_mesh(
        shape_param.unsqueeze(0).cuda(), fd=oac_dir,
    )
    res["cano_gs_lst"][0].save_ply(os.path.join(oac_dir, "offset.ply"), rgb2sh=False, offset2xyz=True)

    print("generating skin.glb via Blender + FBX SDK (also writes vertex_order.json)…")
    generate_glb(
        input_mesh=Path(saved_head_path),
        template_fbx=Path("./assets/sample_oac/template_file.fbx"),
        output_glb=Path(os.path.join(oac_dir, "skin.glb")),
        blender_exec=Path(cfg.blender_path),
    )
    shutil.copy("./assets/sample_oac/animation.glb", os.path.join(oac_dir, "animation.glb"))
    if os.path.exists(saved_head_path):
        os.remove(saved_head_path)

    # --- validate the 4 OAC files, then zip with inner-folder == zip-name ----
    required = ["skin.glb", "offset.ply", "animation.glb", "vertex_order.json"]
    missing = [f for f in required if not os.path.exists(os.path.join(oac_dir, f))]
    assert not missing, f"OAC export incomplete, missing: {missing} (vertex_order.json comes from generate_glb step 4)"

    out_zip = os.path.join("./output/open_avatar_chat", base_iid + ".zip")
    if os.path.exists(out_zip):
        os.remove(out_zip)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        # The renderer finds the avatar folder by scanning for a DIRECTORY ENTRY
        # (dir==true). Python's zipfile writes only file entries by default, so we
        # must add the directory entry explicitly or the loader throws
        # 'file fold is not found'. (See tools/repack_oac.py / docs/AVATAR_FORMAT.md.)
        di = zipfile.ZipInfo(base_iid + "/")
        di.external_attr = (0o40755 << 16) | 0x10  # unix dir bit + MS-DOS dir flag
        z.writestr(di, b"")
        for f in required:
            z.write(os.path.join(oac_dir, f), arcname=os.path.join(base_iid, f))

    print("\n✅ OAC zip ready:", os.path.abspath(out_zip))
    print("   inner folder:", base_iid, "(with directory entry; matches docs/AVATAR_FORMAT.md)")
    print("   contents:", ", ".join(required))


if __name__ == "__main__":
    main()
