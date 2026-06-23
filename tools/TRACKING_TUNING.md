# LAM bake — likeness / facial-shape-fit tuning knobs

Read-only analysis (no GPU run). Where the real shape-fit levers live, exact
locations, recommended values, and the over-fit/instability risk per knob. Use to
re-bake `ints_2` tighter and compare. **Don't change bake logic** — these are the
parameters to nudge.

> All `vhap/…`, `configs/…`, `lam/…`, and `tools/flame_tracking_single_image.py`
> paths below are **inside the cloned LAM repo** (`/content/LAM` on Colab), NOT
> `ints-head-gs`. This doc just documents them.

## The one fact that matters
The avatar's facial **shape** comes from the FLAME **tracker**, not from LAM:
`lam/runners/infer/head_utils.py:188` —
```python
cor_flame_path = .../canonical_flame_param.npz
shape_param = torch.FloatTensor(flame_p['shape'])   # this drives the baked head's shape
```
So **the tracking config is the lever**, and LAM inference resolution is mostly
locked (see §3). The single biggest *free* win is the input photo (sharp, frontal,
neutral, well-lit, face filling the frame) — LAM crops/resizes to 512, so detail
beyond a clean 512 frontal is wasted.

## The config that's actually used
`tools/flame_tracking_single_image.py:251` loads
`configs/vhap_tracking/base_tracking_config.yaml` and (line 253)
`tyro.from_yaml(...)` into `config_data`, then runs the tracker. That YAML is a
single tyro-serialized blob, so the cleanest way to override is **in code right
after line 253** (before `optimize()` runs), e.g.:
```python
config_data = tyro.from_yaml(BaseTrackingConfig, config_data)   # line 253
# --- tighter-fit overrides (add here) ---
config_data.w.reg_shape = 0.15
config_data.exp.photometric = True
config_data.pipeline.lmk_init_all.num_steps = 600
```
(Defaults also live in `vhap/config/base.py` with the line numbers below; the YAML
overrides those.)

---

## 1. FLAME tracking — shape-fit knobs

Ranked by impact on tighter likeness. Current values are from
`base_tracking_config.yaml` (defaults: `vhap/config/base.py`).

### A. `photometric` — **biggest lever**, currently OFF
- Where: `base_tracking_config.yaml` `exp.photometric: false`
  (default `vhap/config/base.py:214 photometric: bool = False`).
- Now: **false** → the single-image bake runs **landmark-only** (just the `lmk_*`
  stages). Shape is fit to 68 2D landmarks, nothing else.
- Tighter: **true** → adds the RGB photometric stages (`rgb_init_texture/all/offset`,
  500 steps each) that align the *rendered* FLAME to the actual image pixels →
  markedly closer shape + expression. Needs the nvdiffrast renderer (installed).
- Risk: **medium-high** — ~1500+ extra steps (slower bake), and the offset/texture
  stages can introduce surface noise. Note LAM consumes only `shape` (betas) +
  pose/expr, not the per-vertex `static_offset`, so the gain reaches the bake via
  refined betas/expr; geometry offsets don't. Try it first — it's the intended
  high-quality path.

### B. `w.reg_shape` — pull toward the generic FLAME average
- Where: `base_tracking_config.yaml` `w.reg_shape: 0.3`
  (default `vhap/config/base.py:131 reg_shape: float = 3e-1`).
- Now: **0.3**. Higher = more pull to the average face (safer, blander). Lower =
  tighter to *this* face.
- Tighter: **0.15** (gentle) → **0.1** (aggressive). This is the most direct
  "less generic" knob.
- Risk: **medium** — too low overfits to noisy 2D landmarks → distorted/asymmetric
  or unstable shape, especially off-frontal. Don't go below ~0.05.

### C. `pipeline.lmk_init_all.num_steps` — shape-fit convergence
- Where: `base_tracking_config.yaml` `pipeline.lmk_init_all.num_steps: 300`
  (default `vhap/config/base.py:231`). This is the stage that optimizes
  `cam,pose,shape,joints,expr` together — i.e. where shape is actually fit.
- Now: **300**. Tighter: **500–600** for fuller convergence (pairs well with a
  lower reg_shape).
- Risk: **low** — just slower; landmark-only optimization is stable. (Related:
  `lmk_init_rigid.num_steps: 300` at base.py:225 only fits cam/pose — leave it.)

### D. `w.landmark` vs the regularizers — adherence strength
- Where: `base_tracking_config.yaml` `w.landmark: 10.0`
  (default `vhap/config/base.py:125`). `w.photo: 30.0` (base.py:129) only applies
  when photometric is on.
- Now: **10**. Tighter: **15** (or equivalently lower `reg_shape`). It's the ratio
  `landmark / reg_shape` that sets how hard the fit chases landmarks.
- Risk: **low-medium** — raising landmark while also dropping reg compounds the
  over-fit risk in B; change one at a time.

### E. `model.n_shape` — shape basis size (already maxed)
- Where: `base_tracking_config.yaml` `model.n_shape: 300` (default base.py:61).
- Now: **300** = the full FLAME2023 shape basis. **Leave it** — already maximal;
  raising isn't possible, and it's not the bottleneck (reg/photometric are).

---

## 2. Recommended first re-bake (conservative → compare)
Set, via the override point at `flame_tracking_single_image.py:253`:
```python
config_data.w.reg_shape = 0.15                       # 0.3 -> 0.15
config_data.pipeline.lmk_init_all.num_steps = 500    # 300 -> 500
config_data.exp.photometric = True                   # false -> true (the big one)
```
Bake `ints_2`, compare to the current `ints_2`. If shape looks distorted, raise
`reg_shape` back toward 0.2; if too generic, drop to 0.1. Change reg_shape and
photometric independently across two bakes so you can attribute the difference.

---

## 3. LAM inference resolution / detail — mostly LOCKED
- `configs/inference/lam-20k-8gpu.yaml:63 source_image_res: 512` → `cfg.source_size`
  (`app_lam.py:150`). This is the resolution the source face is fed to the LAM
  encoder. **Trained at 512** — raising it changes the encoder's token grid vs the
  released weights → likely degrades or errors. **Not safe to raise.**
- `configs/inference/lam-20k-8gpu.yaml:28 flame_subdivide_num: 1` → gaussian point
  density. Raising adds detail capacity **but** changes the gaussian/vertex count,
  which (a) mismatches the trained model and (b) breaks the OAC export's fixed
  `template_file.fbx` (`Vertices: *60054`, see `TEETH_AND_SPEECH.md`). **Not safe.**
- `dataset.render_image.high` → `cfg.render_size` only affects the LAM **preview
  video**, not the OAC avatar. Not a likeness knob.
- `gs_sh: 3` is unused in this config (`gs_use_rgb: True` forces sh_degree 0).

**Conclusion:** there is no safe LAM-inference detail knob for the released
LAM-20K. Likeness gains come from (1) a clean frontal input photo, and (2) the
FLAME tracking shape-fit knobs in §1 — not from raising inference resolution.

---

## Quick reference — exact locations
| knob | file:line (override file) | default (base.py) | now → try | risk |
|------|---------------------------|-------------------|-----------|------|
| photometric | base_tracking_config.yaml `exp.photometric` | base.py:214 | false → **true** | med-high |
| reg_shape | base_tracking_config.yaml `w.reg_shape` | base.py:131 | 0.3 → **0.15→0.1** | medium |
| lmk_init_all steps | base_tracking_config.yaml `pipeline.lmk_init_all.num_steps` | base.py:231 | 300 → **500-600** | low |
| landmark weight | base_tracking_config.yaml `w.landmark` | base.py:125 | 10 → **15** | low-med |
| n_shape | base_tracking_config.yaml `model.n_shape` | base.py:61 | 300 (max) | — |
| source_image_res | configs/inference/lam-20k-8gpu.yaml:63 | — | 512 (locked) | unsafe to raise |
| flame_subdivide_num | configs/inference/lam-20k-8gpu.yaml:28 | — | 1 (locked) | unsafe to raise |

Override cleanly in `tools/flame_tracking_single_image.py` after line 253 (see §2).
