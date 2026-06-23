# LAM bake — teeth + speech findings

Investigation only (no pipeline rebuild). Two questions: (1) why the baked head
has no teeth and how to enable them, (2) how the motion clip maps to mouth
articulation and which clip best previews speech.

---

## 1. Teeth

### The flag (model/render side)
`configs/inference/lam-20k-8gpu.yaml` line 43:
```yaml
model:
  ...
  add_teeth: false      # <-- this is why the log prints add_teeth:False
```
Flow: `app_lam`/the runner load this config → `ModelLAM(**cfg.model)` →
`GS3DRenderer(add_teeth=cfg.model.add_teeth)` → `FlameHeadSubdivided(add_teeth=…)`.
The log line `#########scale sphere:False, add_teeth:False`
(`gs_renderer.py:433`) is printing exactly this config value.

To force it without editing LAM, set it in the runner after `parse_configs()`:
```python
cfg.model.add_teeth = True
```

### No asset is needed for the teeth *geometry*
`FlameHeadSubdivided.add_teeth()` (`flame_model/flame.py:289`) builds teeth
**procedurally** from the lip-ring vertices — it derives upper/lower teeth rows
from `lip_outside_ring_upper/lower`, offsets them back/in, and concatenates **120
teeth verts** to `v_template` (then subdivision multiplies that). No teeth mesh,
texture, or external file is loaded. And LAM queries gaussians **per FLAME
vertex** (`modeling_lam.py` → `renderer.get_query_points(flame_params)`), so the
extra teeth verts simply get their own gaussians — no fixed-count crash.

So on **LAM's own render path** (the preview video / h5 viewer), flipping
`add_teeth: true` should produce teeth. Caveat: the released LAM-20K ships with
`add_teeth:false`, so teeth positions are out-of-distribution and usually
occluded in the input image → their colour is model-guessed (expect pale/!
lip-tinted teeth, geometry solid). Worth a test render to judge quality.

### ⚠️ But the OAC web export is blocked by a MISSING ASSET
The OAC `skin.glb` (what the WebRender deforms) is **not** built from the
teeth-augmented mesh directly. `generate_glb` →
`tools/generateARKITGLBWithBlender.py::update_flame_shape` injects the shaped
verts into a **fixed template FBX** with a hardcoded vertex count:
```python
VERTEX_HEADER = "Vertices: *60054 {"   # 60054 floats = 20018 verts = NO-TEETH subdivided FLAME
template_fbx = ./assets/sample_oac/template_file.fbx
```
It replaces the template's vertex block but keeps the template's faces, skeleton,
and skinning weights — all authored for the **no-teeth 20018-vert** topology.
Enabling `add_teeth` makes the mesh (and `offset.ply` gaussians +
`vertex_order.json`) larger than 60054 → the injection desyncs: teeth verts have
no faces/skin weights, and the gaussian↔mesh mapping breaks. Result: a broken or
teeth-less `skin.glb`, not a teeth head.

**Verdict:** teeth in the **OAC/WebRender** path require a **teeth-matching
`template_file.fbx`** (correct larger vertex count + faces + jaw/skull skinning
weights for the teeth rows) — LAM does **not** ship one (`sample_oac.tar` only
has the 60054 no-teeth template). This is an asset/rigging gap, **not** a
one-line flag. Options, if teeth are wanted in-product:
1. Author a teeth-aware `template_file.fbx` (teeth rows rigged to jaw/skull) and
   update the `*60054` header logic to be dynamic.
2. Or build `skin.glb` from the teeth-augmented `v_template_up`/`faces_up`
   directly (skip the FBX template) and rig the procedural teeth to the jaw bone
   in Blender — a real export-tool change.
3. Or accept no teeth (current state: a gap) and rely on closed-ish mouth
   visemes.

### The "Ignoring unknown cluster teeth" warning — benign, unrelated
From `vhap/model/flame.py:981` (`process_face_clusters`): the FLAME **tracker**
tries to build a face cluster named `teeth` for texture regularization, but the
active `tex_clusters` / `FLAME_masks` define no `teeth` face region
(`vhap/config/base.py:81`), so `get_fid_by_region(["teeth"])` raises and it logs
`Ignoring unknown cluster teeth` and continues. It's a tracking-time texture
detail and has **nothing to do** with whether teeth geometry appears in the
output. Ignore it.

---

## 2. Speech / mouth articulation

### How the motion clip maps to the OAC export — it doesn't
The `--motion <clip>` argument drives the **inference-time preview render** (the
`output.mp4` LAM produces), via per-frame FLAME `jaw_pose` + `expr`. It does
**not** get baked into the OAC zip:
- `offset.ply` = **canonical** gaussians (neutral pose) — motion-independent.
- `skin.glb` = shape-only mesh — motion-independent.
- `animation.glb` = a **shared** clip copied from `sample_oac/` regardless of `--motion`.

So in the **spike web render**, mouth movement comes from the **ARKit blendshapes
fed at runtime** — currently `public/asset/test_expression_1s.json` (the talk
clip we loop), and in production your LLM-driven visemes. The 12 motion clips
only matter if you're eyeballing LAM's own preview video during the bake.

### Widest/clearest mouth movement (for the LAM preview video)
Measured `jaw_pose[:,0]` (jaw-open, radians) across all 12 clips —
`max` = peak opening, `std` = amount of movement:

| clip | frames | maxOpen | std (movement) |
|------|-------:|--------:|---------------:|
| **Pen_Pineapple_Apple_Pen** | 167 | **0.343** | **0.076** |
| Anti_Drugs | 226 | 0.289 | 0.066 |
| The_Shawshank_Redemption | 435 | 0.229 | 0.060 |
| Look_In_My_Eyes | 519 | 0.247 | 0.051 |
| Taylor_Swift | 403 | 0.278 | 0.050 |
| Donald_Trump | 264 | 0.161 | 0.033 |
| Michael_Wayne_Rosen | 60 | 0.243 | 0.030 |
| GEM | 516 | 0.174 | 0.024 |
| Joe_Biden | 264 | 0.136 | 0.022 |
| I_Am_Iron_Man | 282 | 0.132 | 0.019 |
| D_ANgelo_Dinero | 132 | 0.101 | 0.013 |
| Speeding_Scandal | 76 | 0.046 | 0.012 |

**Use `--motion Pen_Pineapple_Apple_Pen`** for the widest, clearest mouth
articulation (Anti_Drugs is a solid runner-up). Note the default
`Look_In_My_Eyes` is mid-pack and gaze-heavy — fine for head motion, not ideal
for judging mouth. Speeding_Scandal / D_ANgelo_Dinero barely open the mouth.

> Reminder: this only changes the LAM **preview** video. To judge speech of the
> **baked head in the spike**, look at the looped `test_expression_1s.json`
> articulation (or feed a wider ARKit clip) — that's the path your product uses.
