# LAM → OAC bake on Colab — runbook

Companion to `LAM_bake_oac_colab.ipynb`. Goal: one portrait in → one **OAC zip**
out (`skin.glb`, `offset.ply`, `animation.glb`, `vertex_order.json`), loadable by
`ints-head-gs` per `docs/AVATAR_FORMAT.md`. **Not** `h5_render_data.zip`.

> Built from LAM's documented Linux install + source. The Python-3.10-**base**
> approach was tried on live Colab and **failed** (condacolab installs its own
> 3.12 build regardless of the pinned URL). This runbook uses a **named conda
> env** instead — see below. The env approach is the fix but is **itself not yet
> confirmed on a full live run**; treat the call-outs as the map.

## The Python 3.10 problem (and the fix)
LAM's OAC export builds `skin.glb` via the **FBX SDK**, which LAM ships **only as
a cp310 wheel** → it needs **Python 3.10**. Colab is **Python 3.12**.

- ❌ Forcing a 3.10 *base* with condacolab does **not** work — condacolab installs
  its own recent Miniforge (3.12) and ignores a pinned-installer URL. Confirmed
  live: `condacolab.check()` says OK but `sys.version` is 3.12.
- ✅ **Create a named conda env `lam` on Python 3.10 and run every install/bake
  step through `conda run -n lam`.** This never touches the kernel/base Python;
  `conda create python=3.10` resolves a real 3.10 interpreter, and the cp310 FBX
  wheel installs into it. This is what the notebook does (Cell 1b defines `RUN`,
  the `conda run` prefix used by Cells 2/3/4/6).

`files.upload()` / `files.download()` (Cells 5/7) stay in the normal kernel — they
only move files on disk, so they don't need the env.

## TL;DR
`Runtime ▸ Change runtime type ▸ T4 GPU`, then run cells 1 → 7 top to bottom.
Setup ~30–60 min; the bake itself is fast. No kernel restart.

## Cell-by-cell

| # | Does | Success looks like | If it fails |
|---|------|--------------------|-------------|
| 1 | GPU + CUDA + Python report | T4 shown, `CUDA available: True` | No GPU → Change runtime type → T4; Restart & run all |
| 1b | Miniforge + **conda env `lam` (py3.10)**; defines `RUN` | `env python: 3.10.x`, `RUN = …` | see **conda env** below |
| 2 | clone LAM + install **into env** (build deps first, `--no-build-isolation`, fail-loud) | `INSTALL DONE` + `IMPORTS_OK` | see **CUDA / build** (~20–40 min) |
| 3 | HF weights + assets (via env) | `WEIGHTS + ASSETS OK` | token optional (repos public); rate-limited → paste a token |
| 4 | Blender + **FBX SDK into env** | `BLENDER OK` + `import fbx OK (in 3.10 env)` | see **FBX / Blender** |
| 5 | upload portrait (kernel) | `Saved: assets/sample_input/fisherman.jpg` | front-facing, well-lit image |
| 6 | bake + OAC export **via `conda run`** | `✅ OAC zip ready …/fisherman.zip` | internal error → Gradio fallback cell |
| 7 | download zip (kernel) | browser download | nothing found → Cell 6 didn't finish |

## Landmines + fixes

### conda env (Cell 1b)
- Installs Miniforge to `/usr/local/miniforge3` (silent, no restart) and creates
  env `lam` with `python=3.10`. `RUN = '<conda> run -n lam --no-capture-output'`
  is a **kernel variable** reused by later cells (persists — there's no restart).
- If `env python` isn't 3.10, the `conda create` output above it has the error
  (network/quota). Re-run the cell; it skips the parts already done.
- Everything that imports LAM/torch/fbx **must** carry the `{RUN}` prefix, or it
  runs in Colab's 3.12 kernel and the FBX import fails.

### CUDA / build failures (Cell 2)
- Order matters: torch+xformers wheels → **pre-install build deps** (`Cython`,
  `ninja`, `numpy==1.23.0`, `setuptools`, `wheel`) → `pip install
  --no-build-isolation -r requirements.txt` → FaceBoxesV2 `make.sh`. The
  `--no-build-isolation` is what fixes **`No module named 'Cython'`** /
  `torch not found` during source builds: pip's default isolation hides the env's
  packages from `pytorch3d`, `diff-gaussian-rasterization`, `nvdiffrast`,
  `simple-knn`, `pymcubes`, and FaceBoxes' Cython ext. Pre-installing the build
  deps + turning isolation off lets every source build see them.
- **Fail-loud:** each step runs via `subprocess.run(check=True)`, so a non-zero
  exit raises and the cell errors. `INSTALL DONE` (and the `IMPORTS_OK` check that
  imports torch/pytorch3d/diff_gaussian_rasterization/simple_knn in the env) only
  appears on full success. No more false "DONE".
- Build-time deps audited from `requirements.txt`: `pymcubes`→Cython+numpy,
  `chumpy`→numpy, the 4 git pkgs→torch(+ninja+numpy), FaceBoxes→Cython — all
  pre-installed. `tensorflow`/`jaxlib`/`face-detection-tflite` ship wheels (no
  build).
- `pytorch3d` still failing → prebuilt wheel (py310/cu121/pyt2.5.1; may mismatch
  torch 2.3.0, last resort):
  `!{RUN} pip install --no-index --no-cache-dir pytorch3d -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt251/download.html`
- `nvcc: not found` → `!apt-get install -y cuda-toolkit-12-1`, re-run. (conda run
  keeps the system PATH, so `/usr/local/cuda/bin/nvcc` is still found.)
- `numpy==1.23.0` downgrade warnings are expected.

### FBX / Blender (Cell 4)
- Blender 4.0.2 is a standalone binary (kernel-agnostic). The cp310 FBX wheel goes
  into the **env** via `{RUN} pip install`; the cell asserts `import fbx` *inside
  the env* (`conda run -n lam python -c "import fbx"`).
- `import fbx` fails in env → the env isn't really 3.10 (re-check Cell 1b) or the
  wheel download failed (re-run the wget).
- Blender headless won't start → the cell installs `libxi6 libxxf86vm1 libxfixes3
  libxrender1 libgl1 libsm6` and retries; if still failing,
  `ldd /content/blender-4.0.2-linux-x64/blender | grep 'not found'` and apt-install
  the rest.

### Bake (Cell 6)
- Runs `!{RUN} python colab_bake_oac.py …` so the runner executes on 3.10 with FBX
  + LAM deps. The runner is adapted from `app_lam.py core_fn`; if a LAM internal
  signature changed it will raise — use the **Gradio fallback** cell (LAM's own
  code) right below it.

### Session timeout / lost work
Free Colab idles ~90 min, caps ~12 h. Setup is the slow part; baking + download is
quick. If the VM is recycled, re-run from Cell 1 (the env + downloads are gone with
the VM).

## If Colab keeps fighting you
LAM's [ModelScope Space](https://www.modelscope.cn/studios/Damo_XR_Lab/LAM_Large_Avatar_Model)
exports the OAC zip **server-side** — upload the portrait, enable the chatting-avatar
export, download `<id>.zip`, drop it into `ints-head-gs`. Sidesteps every Colab
landmine; often the fastest path to a first baked head.

## Output contract
`output/open_avatar_chat/<image-stem>.zip` →
`<image-stem>/{skin.glb, offset.ply, animation.glb, vertex_order.json}`, inner
folder == zip name. Validate by dropping into `ints-head-gs` (`?avatar=…` or the
drag-drop zone). See `docs/AVATAR_FORMAT.md`.

## Credentials
Placeholders only. `HF_TOKEN` is optional (LAM repos are public); never commit it.
Drive mount is not used.
