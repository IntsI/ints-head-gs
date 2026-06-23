# LAM → OAC bake on Colab — runbook

Companion to `LAM_bake_oac_colab.ipynb`. Goal: one portrait in → one **OAC zip**
out (`skin.glb`, `offset.ply`, `animation.glb`, `vertex_order.json`), loadable by
`ints-head-gs` per `docs/AVATAR_FORMAT.md`. **Not** `h5_render_data.zip`.

> Built from LAM's documented Linux install + source — **not yet run on live
> Colab**. The call-outs below are the known landmines, with fixes inline.

## TL;DR
`Runtime ▸ Change runtime type ▸ T4 GPU`, then run cells 1→7 top to bottom.
Setup is ~30–60 min. The bake itself is fast. The one step most likely to block
you is the **FBX SDK** (Cell 4) — read that section first.

## Cell-by-cell

| # | Does | Success looks like | If it fails |
|---|------|--------------------|-------------|
| 1 | GPU + CUDA check | T4 shown, `CUDA available: True` | No GPU → Change runtime type → T4; Restart & run all |
| 2 | clone LAM + install (cu121/cu118 auto) | `INSTALL DONE`, no red tracebacks | see **CUDA / build** below (~20–40 min, be patient) |
| 3 | HF weights + assets | `WEIGHTS + ASSETS OK` | token optional (repos public); rate-limited → paste a token |
| 4 | Blender + FBX SDK | `BLENDER OK` **and** `import fbx OK` | see **FBX on Colab** — the critical one |
| 5 | upload portrait | `Saved: assets/sample_input/fisherman.jpg` | front-facing, well-lit image |
| 6 | bake + OAC export | `✅ OAC zip ready …/fisherman.zip` | internal error → use the Gradio fallback cell |
| 7 | download zip | browser download | nothing found → Cell 6 didn't finish |

## Known landmines + fixes

### GPU not assigned (Cell 1)
Free Colab may give no GPU at busy times. `Runtime ▸ Change runtime type ▸ T4
GPU`. If none is offered, wait and retry, or use a paid tier. T4 (~15 GB VRAM)
is plenty for LAM-20K single-image inference; host RAM (~12 GB) is the tighter
limit once TensorFlow + JAX + torch load.

### CUDA / build failures (Cell 2)
- The installer **pins torch 2.3.0** (+cu121 or cu118) and **compiles** `pytorch3d`,
  `diff-gaussian-rasterization`, `nvdiffrast`, `simple-knn`. This is slow and the
  usual failure point.
- Pick **cu121** on Colab (CUDA 12 runtimes); the notebook auto-detects.
- `pytorch3d` build error → prebuilt wheel (note: built for pyt2.5.1, may mismatch
  torch 2.3.0; try only if source build fails):
  `pip install --no-index --no-cache-dir pytorch3d -f https://dl.fbaipublicfiles.com/pytorch3d/packaging/wheels/py310_cu121_pyt251/download.html`
- `nvcc: not found` / `make.sh` fails → `!apt-get install -y cuda-toolkit-12-1`, re-run.
- `numpy==1.23.0` downgrade warnings are expected; ignore unless an import breaks.

### FBX on Colab — THE blocker (Cell 4)
The OAC `skin.glb` is built **ASCII FBX → (FBX SDK) binary FBX → (Blender) GLB**,
and that Blender step also emits `vertex_order.json`. LAM ships the FBX SDK **only
as a `cp310` wheel**, so it installs **only on Python 3.10**. Colab is often
3.11/3.12 → the wheel won't install and `skin.glb` can't be built.

Three ways forward, best first:

1. **condacolab → Python 3.10 (makes the full pipeline work).** Run this FIRST,
   before Cell 2; the kernel restarts once (expected), then continue:
   ```python
   !pip install -q condacolab
   import condacolab; condacolab.install()   # kernel restarts here — this is normal
   ```
   After restart:
   ```python
   !conda create -y -n lam python=3.10 && echo "use this env for all later cells"
   # then prefix python/pip calls with: conda run -n lam <cmd>
   ```
   Simpler in practice: `condacolab.install_from_url(...)` of a py3.10 miniconda,
   or just rely on condacolab's base (it sets Python to a conda build). Verify
   `sys.version` is 3.10 before installing the FBX wheel.
   > Trade-off: condacolab makes the runtime non-linear (one restart) and you must
   > install LAM's deps into the conda Python. Worth it only if you need the full
   > on-Colab export.

2. **Bake on LAM's ModelScope Space (no setup).** The hosted Space exports the OAC
   zip server-side: <https://www.modelscope.cn/studios/Damo_XR_Lab/LAM_Large_Avatar_Model>.
   Upload the portrait, enable the chatting-avatar export, download `<id>.zip`,
   drop it into `ints-head-gs`. This sidesteps every Colab landmine — often the
   fastest path to a first baked head.

3. **Blender present, FBX absent.** Cells 1–3, 5 (LAM inference) still run; only
   the `skin.glb` half of the export is blocked. Useful for sanity-checking the
   model before solving FBX.

### Blender headless won't start (Cell 4)
Even with `--background`, Blender needs some X libs. The cell installs
`libxi6 libxxf86vm1 libxfixes3 libxrender1 libgl1 libsm6` and retries. If it still
fails, run `ldd /content/blender-4.0.2-linux-x64/blender | grep 'not found'` and
`apt-get install` whatever's missing.

### Session timeout / lost work
Free Colab idles after ~90 min and caps ~12 h. Setup is the slow part; once Cell 4
passes, baking + download is quick. If the session dies mid-setup, re-run from
Cell 1 (downloads are cached on the same VM until it's recycled).

## Output contract (what you should get)
`output/open_avatar_chat/<image-stem>.zip` containing
`<image-stem>/{skin.glb, offset.ply, animation.glb, vertex_order.json}` — inner
folder == zip name. Validate by dropping it into `ints-head-gs`
(`?avatar=…` or the drag-drop zone). See `docs/AVATAR_FORMAT.md`.

## Credentials
Notebook uses placeholders only. `HF_TOKEN` is optional (LAM repos are public);
never commit it. Google Drive mount is not used. Don't paste tokens into files
that get committed.
