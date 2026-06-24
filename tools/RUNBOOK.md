# LAM → OAC bake on Colab — runbook

Companion to `LAM_bake_oac_colab.ipynb`. One portrait in → one **OAC zip**
(`skin.glb`, `offset.ply`, `animation.glb`, `vertex_order.json`), loadable by
`ints-head-gs` per `docs/AVATAR_FORMAT.md`. **Not** `h5_render_data.zip`.

The pipeline has run **end-to-end on Colab** (a baked `fisherman.zip` rendered in
the spike at ~120fps). This notebook now folds in **every** fix that took to get
there, so the next bake should be one clean top-to-bottom run.

> ⚠️ This *consolidated* notebook has not yet been run on a **fresh** Colab
> runtime — the individual fixes are all verified, but their assembly into one
> clean pass is the next real test. Run order below; if a cell errors, it's
> designed to fail loudly at that step.

## The three non-obvious traps (read these first)
1. **Rasterizer must be ashawkey's.** `diff-gaussian-rasterization` from
   ashawkey returns **4** values; graphdeco-inria's returns **2** → LAM throws a
   `4-vs-2` ValueError at render. Cell 2 uninstalls any copy and force-installs
   `git+https://github.com/ashawkey/diff-gaussian-rasterization.git`.
2. **`transformers==4.40.0`** — not newer. transformers 5.x / very new releases
   disable torch on 2.3.0. (And `diffusers==0.31.0` — 0.27 breaks on a modern
   `huggingface_hub`.)
3. **`--motion` takes the CLIP NAME only** (e.g. `Look_In_My_Eyes`), not a path.
   `find_motion` prepends `assets/sample_motion/export/` itself, so a full path
   doubles up.

## Run order
`Runtime ▸ Change runtime type ▸ T4 GPU`, then cells top to bottom.

| # | Does | Success looks like |
|---|------|--------------------|
| 1 | GPU + Python report | T4, `CUDA available: True` |
| 1b | Miniforge + **conda env `lam` (py3.10)**, defines `RUN` | `env python: 3.10.x` |
| 2 | install the verified dep set into the env | `IMPORTS_OK` then `INSTALL DONE` |
| 3 | weights + assets + **OAC template** (`sample_oac.tar`) | `WEIGHTS + ASSETS OK` |
| 4 | Blender headless + pathlib/patool + **FBX SDK in the env** | `BLENDER OK` + `import fbx OK` |
| 5 | upload portrait (kernel) | `Saved: assets/sample_input/fisherman.jpg` |
| 6 | bake + OAC export via `conda run` (`MPLBACKEND=Agg`, clip-name `--motion`) | `✅ OAC zip ready …` |
| 7 | download zip (kernel) | browser download |

## Why a conda env (the Python 3.10 problem)
LAM's FBX SDK is a **cp310-only** wheel; `skin.glb` (and thus the OAC zip) can't
be built without it. Colab is Python 3.12, and condacolab installs its own 3.12
build regardless of pinned URLs — so we **don't** touch the base Python. Cell 1b
creates a named env `lam` on 3.10 and every install/bake step runs through
`conda run -n lam` (the `RUN` prefix). `files.upload`/`download` (5/7) stay in the
kernel.

## Cell 2 — the verified dependency set (not requirements.txt)
`requirements.txt` pins conflicting versions (`transformers==4.41.2`,
`huggingface_hub==0.23.2`) and was the source of the live failures, so Cell 2
installs an **explicit** set instead, all `{RUN}` into the env, **numpy pinned to
1.23.0** via a pip constraints file (`-c /tmp/constraints.txt` on every install):

- torch 2.3.0 + torchvision 0.18.0 + torchaudio 2.3.0 + xformers 0.0.26.post1 (cu121 wheels)
- build deps first: `numpy==1.23.0 Cython ninja setuptools wheel`
- **pytorch3d** = prebuilt wheel `py310_cu121_pyt230` (0.7.6) — no 45-min build
- core deps: `opencv-python-headless gradio omegaconf einops roma moviepy imageio
  imageio-ffmpeg tyro lpips face-alignment loguru scikit-image kornia matplotlib
  trimesh jaxtyping plyfile tensorboard transformers==4.40.0 diffusers==0.31.0
  accelerate safetensors` (pulls huggingface_hub transitively; Cell 3 uses its
  Python API, not the CLI)
- `chumpy` + `pymcubes` with **`--no-build-isolation`** (they build against the
  env's numpy/Cython)
- **ashawkey** `diff-gaussian-rasterization` (force; trap #1) — small CUDA build,
  ninja + live `-v` + 15-min timeout
- `nvdiffrast` from **NVlabs** (`git+https://github.com/NVlabs/nvdiffrast.git`) —
  the build verified live; fast install, JIT-compiles at first render
- FaceBoxesV2 Cython ext (`make.sh`)

Fail-loud: every step is `subprocess.run(check=True[, timeout])`; non-zero or a
hang errors the cell. `INSTALL DONE` prints only after an in-env `IMPORTS_OK`
check imports `torch, pytorch3d, diff_gaussian_rasterization, nvdiffrast.torch` +
`ModelLAM` + `FlameTrackingSingleImage`.

The `IMPORTS_OK` check runs with **`MPLBACKEND=Agg`** (same as the bake). LAM
imports `matplotlib.pyplot` at import time; without `MPLBACKEND=Agg` the subprocess
inherits Colab's notebook-only backend and **false-fails** with
`ValueError: Key backend: 'module://matplotlib_inline.backend_inline' is not a
valid value for backend` — even though the env is fine. Set it for that call.

### If Cell 2 fails
- `…matplotlib_inline.backend_inline is not a valid value for backend` in the
  IMPORTS_OK step → MPLBACKEND not set for that subprocess (fixed: the cell now
  prepends `MPLBACKEND=Agg`). The environment is actually fine.
- pytorch3d wheel issue → cu118 isn't supported by the prebuilt wheel (Colab is
  cu121; the cell asserts).
- a source build hangs → it's timeout-guarded; bump `MAX_JOBS` if the VM has cores.
- `nvcc: not found` → `!apt-get install -y cuda-toolkit-12-1`, re-run.

## Cell 3 — weights, assets, OAC template
`snapshot_download("3DAIGC/LAM-assets")` + `"3DAIGC/LAM-20K"` via the
huggingface_hub **Python API** (version-agnostic; avoids the `hf`/`huggingface-cli`
CLI-name churn). Token optional; repos public.
**plus** `sample_oac.tar` extracted into `assets/` — that's where
`template_file.fbx` lives, and the GLB export fails without it. Asserts both the
LAM-20K `model.safetensors` and `assets/sample_oac/template_file.fbx`.

## Cell 4 — Blender + FBX SDK
Blender 4.0.2 (standalone binary). Installs `pathlib` + `patool` (export helpers).
FBX: checks `import fbx` **inside the env** first (the false-OK bug was checking
the base kernel); if missing, downloads the wheel **with its real filename**
(pip rejects a bare `fbx.whl`) and installs into the env.

## Cell 6 — bake
`!MPLBACKEND=Agg {RUN} python colab_bake_oac.py --image … --blender_path {BLENDER}
--motion Look_In_My_Eyes`
- `MPLBACKEND=Agg` — matplotlib's default inline backend crashes headless.
- `--motion Look_In_My_Eyes` — clip name only (trap #3).
- Runner is adapted from `app_lam.py core_fn`; on LAM-internal signature drift,
  use the Gradio fallback cell below it.

## Output
`output/open_avatar_chat/<stem>.zip` → `<stem>/{skin.glb, offset.ply,
animation.glb, vertex_order.json}` **with a directory entry** (the runner writes
it now — see `docs/AVATAR_FORMAT.md`; the renderer needs it or throws `file fold
is not found`). Drop it into `ints-head-gs` (`?avatar=…` or drag-drop) to verify.

## Repacking older zips
A zip from an earlier runner (no directory entry) won't load. Fix any zip:
`python tools/repack_oac.py <bake>.zip`.

## If Colab keeps fighting you
LAM's [ModelScope Space](https://www.modelscope.cn/studios/Damo_XR_Lab/LAM_Large_Avatar_Model)
exports the OAC zip server-side, no setup.

## Credentials
Placeholders only. `HF_TOKEN` optional (LAM repos public); never commit it.
