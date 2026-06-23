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
| 2 | clone LAM + install **into env** (prebuilt wheels; one small ext built w/ timeout) | `IMPORTS_OK` + `INSTALL DONE` | see **CUDA / build** (~10–15 min) |
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

### Source-build hang → prebuilt wheels (Cell 2)
The original `pip install -r requirements.txt` compiled `pytorch3d` from git and
**hung ~45 min silently**. Cell 2 now installs prebuilt wheels and only builds the
one small ext that has no wheel.

**Runtime-dependency audit of the bake/OAC path** (`colab_bake_oac.py` → `app_lam`
→ `ModelLAM`/`gs_renderer` + `FlameTrackingSingleImage`) decided what to install:

| pkg | on the bake path? | handling |
|-----|-------------------|----------|
| `pytorch3d` | yes — `gs_renderer.py` + `flame_model` (imported at model build) | **prebuilt wheel** py310/cu121/pyt230 (0.7.6) |
| `diff_gaussian_rasterization` | yes — top-level import in `gs_renderer.py` | build (small CUDA ext) w/ ninja + `-v` + 15-min timeout |
| `nvdiffrast` | yes — top-level in `vhap/export_as_nerf_dataset.py` (flame tracking) | pip from git, **fast** (JIT-compiles at first render, not at install) |
| `simple_knn` | **no** — `grep` finds zero imports in LAM | **dropped** |
| `pymcubes` | **no** — only `lam/runners/infer/lam.py`, not imported by the bake | **dropped** |

- **cu121 only:** the prebuilt pytorch3d wheel is cu121 (Colab T4 is cu121). On
  cu118 the cell asserts and stops — you'd need a source build there.
- **Fail-loud + no silent hang:** every step is `subprocess.run(check=True,
  timeout=…)`; non-zero **or** timeout raises → cell errors. The lone build
  (`diff_gaussian_rasterization`) streams live (`-v`) and dies at 15 min instead
  of hanging. `INSTALL DONE` only prints after the in-env `IMPORTS_OK` check
  imports `torch, pytorch3d, diff_gaussian_rasterization, nvdiffrast.torch` +
  `ModelLAM` + `FlameTrackingSingleImage`.
- `diff_gaussian_rasterization` build fails / times out → `nvcc` issue: ensure
  `/usr/local/cuda/bin` is on PATH (conda run keeps system PATH) or
  `!apt-get install -y cuda-toolkit-12-1`. Bump `MAX_JOBS` if the VM has cores.
- `numpy==1.23.0` downgrade warnings are expected.

### FBX / Blender (Cell 4)
- Blender 4.0.2 is a standalone binary (kernel-agnostic).
- FBX: the cell first checks `import fbx` *inside the env*. If it already imports
  (it often does — pulled in transitively), it **skips the wheel install**. Only
  if the import fails does it download the cp310 wheel **with its real filename**
  (`fbx-2020.3.4-cp310-...whl` — pip rejects a renamed `fbx.whl`), validate it's a
  real zip, install, and re-check.
- `import fbx` fails *and* the wheel install also fails → the env isn't really
  3.10 (re-check Cell 1b) or the OSS wheel URL is unreachable (the validation
  asserts on a bad/empty download).
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
