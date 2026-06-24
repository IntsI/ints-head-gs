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

### ⚠️ CONFIRMED EMPIRICALLY: the OAC web export is blocked by a MISSING ASSET
Tested with `colab_bake_oac.py --add-teeth` on a real bake. Tracking + LAM
inference run fine and `offset.ply` writes — but **the OAC export fails at the
`skin.glb` step** with exact numbers:

```
[add-teeth] shaped mesh (nature.obj): 20426 verts = 61278 floats
[add-teeth] template_file.fbx declares: Vertices: *60054 floats   (= 20018 verts)
            -> MISMATCH (61278 vs 60054); +408 teeth verts
Blender FBX import dies: "NoneType is not iterable"
```

So teeth add **+408 verts** (20018 → 20426); the no-teeth template can't absorb
them and Blender's import chokes. Confirmed, not predicted.

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

**Verdict (confirmed):** teeth in the **OAC/WebRender** path are **blocked pending
a teeth-rigged `template_file.fbx`**. LAM ships only the 60054-float (20018-vert)
no-teeth template in `sample_oac.tar`. This is an asset/rigging gap, **not** a
one-line flag. Options, if teeth are wanted in-product:
1. **Blender job (the fix):** build a teeth-aware `template_file.fbx` — add the
   **+408 teeth verts** (→ 20426 verts / 61278 floats) with faces, and **skin them
   to the jaw bone (lower teeth) / skull (upper teeth)**, then update the
   `Vertices: *60054` header logic in `update_flame_shape` to match (or make it
   dynamic). Once that template exists, `--add-teeth` should produce a teeth head.
2. Or build `skin.glb` from the teeth-augmented `v_template_up`/`faces_up`
   directly (skip the FBX template) and rig the procedural teeth to the jaw bone
   in Blender — a deeper export-tool change.
3. Or accept no teeth (current state) and rely on closed-ish mouth visemes.

The **`--add-teeth` flag stays in `colab_bake_oac.py`** for the day a teeth
template exists — it already prints the counts and surfaces the failure, so it's
the test harness for verifying a new template.

### ✅ But LAM's OWN demo shows teeth — via a DIFFERENT format (the FLAME path)
LAM's project-page demo (`g.alicdn.com/T.I.D.E/GaussianAvatarShow/0.0.8/demo`)
renders heads **with teeth**. Inspecting it: it loads a **FLAME-format** avatar
(`…/gaussianAvatarData/20k/man.zip`) with **`getInstance(div, path, useFlame=true)`**.

That zip is **not** our OAC format — it's LAM's `create_zip_archive` /
`h5_render_data` set:
```
man/lbs_weight_20k.json (1.97MB)   man/skin.glb (24.9MB — vs OAC's 3.6MB)
man/flame_params.json (430KB)       man/offset.ply (1.36MB)
man/vertex_order.json (209KB)       man/bone_tree.json (1KB)
```
**Why this one HAS teeth:** the FLAME `skin.glb` is the full FLAME mesh and teeth
are deformed by **`lbs_weight` skinning** (computed for the real topology, teeth
included) — there is **no fixed `template_file.fbx` injection**, so no vertex
desync. Our renderer (`gaussian-splat-renderer-for-lam@0.0.9-alpha.1`) supports
this path: `getInstance(div, path, { useFlame: true, … })`
(`if (charactorConfig.useFlame) renderer.useFlame = …`).

### ⚠️ The catch: the FLAME path is CLIP PLAYBACK, not live control
The FLAME render runs `updateFlameBones()` every frame, sourcing everything from
the **baked `flame_params.json`** clip:
```js
this.splatMesh.bsWeight = this.flame_params['expr'][this.frame];          // expression
setBoneRotation(bones[2], this.flame_params['jaw_pose'][this.frame]);     // JAW
setBoneRotation(bones[0], this.flame_params['rotation'][this.frame]);     // head rotation
```
`this.frame` is derived from elapsed time and wraps at `totalFrames`. It
**overwrites** anything our live `getExpressionData`→`bsWeight` produced. So:

| path | teeth | live conversation |
|------|:-----:|:-----------------:|
| OAC (offset.ply, `useFlame:false`) — what we use | ❌ (template desync) | ✅ live `getExpressionData` |
| FLAME (`useFlame:true`) — the demo | ✅ via `lbs_weight` | ❌ replays baked `flame_params` |

You can't get both by a format swap — the teeth-capable path is wired for clip
playback.

### Three options to get teeth
1. **Live FLAME-drive (teeth + live; the real prize, most work):** load the FLAME
   format `useFlame:true`, and instead of letting `flame_params` play, **overwrite
   `viewer.flame_params['expr'/'jaw_pose'/'rotation']` per frame** with our
   viseme/emotion values (pin `totalFrames=1`, mutate index `[0]` each tick — the
   renderer re-reads it every frame). Needs a **viseme→FLAME mapping** (ARKit
   blendshapes → FLAME `expr` PCA coeffs + `jaw_pose` bone). **DE-RISKED — see
   results below** (`flame-spike.html` / `src/flame-spike.ts`).
2. **Playback FLAME (teeth, not live):** bake a `flame_params` clip per TTS reply
   and play it — teeth, but each reply is pre-rendered, not live.
3. **Stay OAC + renderer-side teeth:** the teeth-rigged `template_file.fbx` Blender
   job above (live conversation, but needs the asset built).

---

## 3. DE-RISK SPIKE RESULTS (Option 1 — live FLAME-drive)

Built `flame-spike.html` + `src/flame-spike.ts`, loaded `man.zip` (FLAME format)
and drove `flame_params` live. Verified **programmatically in-browser** (Playwright
reading the actual jaw-bone quaternion — no eyeballing needed).

### ✅ UNKNOWN 1 — does the renderer read live-updated `flame_params`? **YES.**
Pin `totalFrames=1` (the render loop then computes `frameIndex = 0` forever:
`calcDelta = (now-start) % (totalFrames * 1/30)` → `floor(... / (1/30)) = 0`).
Mutate `viewer.flame_params['jaw_pose'][0] = [jaw,0,0]` each tick. The loop runs
`runMorphUpdate()` → `updateFlameBones()` **~70×/s** (measured), which re-reads
`flame_params['jaw_pose'][frame=0]` and writes `viewer.skeleton.bones[2]`.

Measured slider → `flame_params` → **jaw-bone quaternion**, exact tracking:

| slider | flame_params.jaw_pose[0][0] | jaw bone (rad) |
|-------:|----------------------------:|---------------:|
| 0.10 | 0.10 | 0.10 |
| 0.25 | 0.25 | 0.25 |
| 0.40 | 0.40 | 0.40 |
| 0.50 | 0.50 | 0.50 |
| 0 | 0 | 0 (rest) |

`__flame.proveLive()` returns
`✅ jaw bone followed our live value (0.400 ≈ 0.4)`.

### ✅ UNKNOWN 2 — viseme → FLAME jaw (minimal): **YES.**
Firing `speak("hello there…")` drove the jaw bone through **22 distinct values
(0.02–0.26 rad)** over the utterance — the existing `src/speech.ts` viseme
`jawOpen` sequence maps straight onto `flame_params['jaw_pose']` (axis-angle, x ≈
open). Jaw articulation on speech is proven. Visual **teeth** appear as the jaw
opens (confirm in a browser — the splat render is too heavy to screenshot).

### ⚠️ THE REAL BLOCKER — the published renderer can't enter the FLAME path
`gaussian-splat-renderer-for-lam` **every version 0.0.1 → 0.0.9-alpha.2** hardcodes
the FLAME switch off and gives the caller **no hook** to turn it on:
```js
var useFlame = "false";
var charactorConfig = { …, useFlame };      // module-internal const
// inside getInstance(container, assetPath, options):
if (charactorConfig.useFlame) {              // reads the const, NOT options
  renderer.useFlame = charactorConfig.useFlame == "false" ? false : true;  // → false
}
// options is NEVER merged into charactorConfig
```
So `getInstance(div, path, { useFlame:true })` is **ignored** — `useFlame` stays
false and the renderer always runs the **OAC `loadModel`** path, which also fetches
`pathName + "/animation.glb"`. `man.zip` has no `animation.glb` → `zip.file()`
returns null → `new Blob([undefined])` → GLTFLoader parses the literal string
`"undefined"` → `SyntaxError: "undefined" is not valid JSON`. (That error is the
signature of this bug.) The alicdn demo runs a **custom/internal build** with the
switch on.

**To enter the FLAME path you must patch/fork the renderer.** The spike does it
with a tiny local node_modules patch gated on a window flag (so the OAC head is
untouched) — **NOT committed** (node_modules isn't tracked). To re-run the spike:

```js
// in BOTH:
//   node_modules/gaussian-splat-renderer-for-lam/build/gaussian-splat-renderer-for-lam.module.js
//   node_modules/.vite/deps/gaussian-splat-renderer-for-lam.js   (then `vite --force`)
// right after the `if (charactorConfig.useFlame) { … }` block, add:
if (typeof window !== "undefined" && window.__FORCE_FLAME) { renderer.useFlame = true; }
```
`flame-spike.ts` sets `window.__FORCE_FLAME = true` before `getInstance`. Also strip
the macOS `__MACOSX/` + `.DS_Store` junk from `man.zip` and keep the explicit `man/`
dir entry (else the folder-name autodetect / file lookup misfires).

### Verdict
Both technical unknowns for **Option 1 are GREEN**: the renderer honours live
`flame_params`, and our viseme jaw stream drives it. The remaining work is
**engineering, not research**:
1. **Fork/patch the renderer** to expose `useFlame` (one line; or vendor a build) —
   this is the gating dependency, not a Gaussian-splat problem.
2. Build the full **viseme/emotion → FLAME `expr` (PCA) + `jaw_pose`** mapping
   (jaw done; `expr` coeffs for lips/brow/emotion still to map — note `expr[0]`
   came back length-0 on `man.zip`, so confirm the `expr` basis/length before
   wiring blendshapes).
3. Decide sourcing of FLAME-format avatars (the bake must emit the
   `lbs_weight_20k.json` + FLAME `skin.glb` set, not the OAC set).

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

---

## 4. FLAME-format bake recipe (TEETH) — `tools/colab_bake_flame.py`

The OAC bake can't do teeth (the hardcoded no-teeth `template_file.fbx`, §1). The
**FLAME web format** can, because it exports the GLB **directly from the model's
own FLAME mesh** — no FBX injection, no fixed vertex count. `colab_bake_flame.py`
is a sibling of `colab_bake_oac.py` that produces the 6-file FLAME zip man.zip uses
(`skin.glb`, `flame_params.json`, `lbs_weight_20k.json`, `bone_tree.json`,
`offset.ply`, `vertex_order.json`).

It mirrors LAM's `core_fn` **FLAME/h5 branch** (`app_lam.py` ~283–289, gated behind
the hardcoded global `h5_rendering=False`), calling the four functions directly:
1. `lam.renderer.flame_model.save_h5_info(shape.unsqueeze(0).cuda(), fd="./runtime_data")`
   → `lbs_weight_20k.json`, `bone_tree.json`, `nature.obj`, `bs/expr0..99.obj`
2. `res['cano_gs_lst'][0].save_ply(".../offset.ply", offset2xyz=True)`
3. Blender `tools/generateGLBWithBlender_v2.py` (paths hardcoded to `./runtime_data`)
   → `skin.glb` + `vertex_order.json` (builds armature + 100 `expr` shape keys)
4. assemble the zip with our **folder + directory-entry** convention (the renderer
   needs the dir entry or throws `file fold is not found`).

**Teeth = one toggle.** `cfg.model.add_teeth = True` BEFORE `_build_model(cfg)`
(shipped config has it `false`). It flows `ModelLAM → GS3DRenderer →
FlameHeadSubdivided(add_teeth=True)`; teeth are added to the base template, THEN
subdivided, so every artifact (`nature.obj`, all 100 `bs/expr*.obj`,
`lbs_weight_20k.json`, `offset.ply`) grows by the same teeth-vertex count
consistently. **No desync** (that was OAC-only). This runner defaults teeth **ON**
(`--no-teeth` to disable).

**`flame_params.json` is NOT generated by LAM** — it's the *driving clip's* params,
copied from the `--motion` clip. We pin `totalFrames=1` and overwrite it live in
the spike, so its content only needs valid keys/shapes (translation, rotation,
neck_pose, jaw_pose, eyes_pose, shape, expr).

### Preflight (run this FIRST — fails in seconds, not after inference)
The FLAME runner needs deps the OAC bake doesn't (chiefly
`tools/generateGLBWithBlender_v2.py`, the FLAME export methods, a Blender with
`wm.obj_import` + glTF). `tools/preflight_flame.py` checks them all by file
existence + source-grep + a Blender `bpy` smoke test — **no model build, no
inference**. Upload it into `/content/LAM/` (next to the runner) and run as a cell
(base kernel — no conda env needed):

```bash
!python preflight_flame.py --blender_path {BLENDER} --motion Look_In_My_Eyes
```
Exit 0 = good to bake; it prints exactly which dep is missing otherwise (e.g.
`MISSING tools/generateGLBWithBlender_v2.py → update LAM`, or a Blender OBJ-import
op mismatch). Only run the bake below once preflight is green.

### Exact Colab command (bake fisherman with teeth)
Reuse the **same notebook setup** as the OAC bake (`LAM_bake_oac_colab.ipynb`
cells 1–5: GPU, conda env `lam`/`RUN`, deps, weights, Blender — all identical).
Then **upload `tools/colab_bake_flame.py` into `/content/LAM/`** (next to
`colab_bake_oac.py`) and run, in place of the OAC bake cell:

```bash
!MPLBACKEND=Agg {RUN} python colab_bake_flame.py \
    --image assets/sample_input/fisherman.jpg \
    --blender_path {BLENDER} \
    --motion Look_In_My_Eyes
```
(`{RUN}` = `conda run -n lam`, `{BLENDER}` = the Blender path — both defined in the
notebook. Teeth are on by default.) Output:
`./output/flame_render/fisherman.zip`. Download it, then load in the FLAME spike
(`/flame-spike.html?avatar=…`) or the comparison page (`/compare.html?v2=…`).

> Requires `tools/generateGLBWithBlender_v2.py` in the LAM checkout (present on the
> `master` branch). If absent, update LAM. If a LAM signature drifts, fall back to
> flipping the app's `h5_rendering=True` global and running LAM's Gradio path.

---

## 5. v1 vs v2 comparison + living-base port (`compare.html`, `src/flame-driver.ts`)

**Goal:** a fair side-by-side — v1 (OAC fisherman: alive, no teeth) vs v2 (FLAME
fisherman: teeth + the SAME living base). The jaw-only spike looked uncanny because
only the jaw moved; v2 now runs the same brain as v1.

**`compare.html`** puts both heads side by side as two **iframes** — each iframe is
its own JS realm, so the renderer singleton + the `window.__FORCE_FLAME` flag don't
collide, and both render live at once. `?v1=<oac avatar>&v2=<flame avatar>` set the
two heads (v2 defaults to man.zip until you bake fisherman FLAME). The OAC head
(`/`, `main.ts`) is **untouched**.

**`src/flame-driver.ts`** maps the SAME ARKit brain (`driver.ts` emotion+idle,
`speech.ts` visemes) onto the FLAME path. Per-frame it pins `totalFrames=1` and
overwrites `flame_params[…][0]`:

| channel | FLAME target | status |
|---|---|---|
| jaw (idle breath + speech visemes) | `jaw_pose` bone | ✅ live |
| eye gaze / saccades | `eyes_pose` bones (L=[0..2], R=[3..5]) | ✅ live |
| head glances (autonomous wander) + neck | `rotation`/`neck_pose` bones | ✅ live |
| breath (chest rise/lean/swell) | splatMesh transform | ✅ live |
| whole-face emotion (smile/surprise/…) | `expr` (FLAME-PCA, name-keyed) | ⏳ reachable (path works; needs directions) |
| **isolated blink** | `expr` (FLAME-PCA) | ❌ not representable on this head (see below) |

### ✅ RESOLVED: expr/morph deform works — it was a NAME-KEYING bug in our rig
**Earlier this section said the morph path was "renderer-blocked / inert." That was
WRONG.** The renderer is fine; LAM's demo emoting was the clue. The deform reads
weights by **morph NAME**:
```js
// updateBoneMatrixTexture: mutates the bone-matrix texture IN PLACE
for (const key in this.bsWeight) {
  const idx = this.morphTargetDictionary[key];        // key must be "expr0".."expr99"
  boneMatrix[idx + this.bonesNum*16] = uintEncodedFloat(this.bsWeight[key]);
}
```
The clip stores each frame as an **object** `{expr0:…, expr1:…}`, so the demo's
`bsWeight` keys resolve. **Our rig set `flame_params.expr[0]` as a numeric ARRAY**
`[w0…w99]` → `for…in` keys are `"0".."99"` → `morphTargetDictionary["0"]` is
`undefined` → every weight silently dropped → no deform. Bones never use `bsWeight`,
so they worked — exactly the symptom (bones live, expr "inert").

**Fix (in `flame-driver.ts`):** write `expr[0]` as a **name-keyed object** with
**all `expr0..expr99` keys every frame** (unused = 0 — `updateBoneMatrixTexture`
mutates in place, so absent keys keep stale weights). Confirmed: man.zip AND
fisherman both close their eyes; live autonomous blink fires through the loop. No
fork, no version bump, no re-bake — the renderer (`0.0.9-alpha.1`) and the bake
were correct all along.

### ❌ Isolated BLINK is NOT representable on this head (rigorously established)
FLAME has no eyelid bone, so blink must be an `expr` direction. We tried hard and
measured objectively (upper-lid vs lower-lid gap, evaluating the real morph combo):
- **Single PCA components:** none close the eyes cleanly — the best eye-movers also
  drag the mouth (localization ≤ 0.55).
- **Mouth/brow/cheek-penalized least-squares** (solve for lid-close while forbidding
  the rest): **~0–1 % lid closure** — when you forbid the face from moving, the basis
  has no eyelid-closing direction left.
- **Unconstrained eye-close direction:** *does* close the lids, but pulls brow down +
  cheek up + mouth → a **grimace** (this is the "crazy" frame). 
- **The clip's own captured blinks:** the deepest blink frame moves the upper lid only
  **~5 %** of the eye gap — negligible. LAM heads barely blink.

**Conclusion:** on this FLAME expression PCA, eyelid closure is **entangled** with
brow/cheek/mouth and cannot be isolated — a clean, visible blink is not achievable
without facial distortion. So we **do not drive blink** (it's off; the face stays
clean). `solveBlinkDir`/`setBlink` remain for experimentation only.

### Whole-face emotion (smile/surprise/…) — reachable, unlike blink
Emotions are *meant* to move multiple regions together, so they DON'T need the
isolation blink does. The name-keying fix makes them drivable: derive each
expression's direction (geometric region-scoring, or pull an expressive clip frame —
raw clip frames render naturally) and drop it into `EXPR_MAP` (component-keyed) in
`flame-driver.ts`; `writeFrame` composes it from the live `driver.ts` output. Tools:
`__flame.sweepComp(n,w)` / `resumeExpr()` / `inspectExpr()`.

**Net: teeth + speech-jaw + gaze + head + breath = a genuinely alive v2 (same
ingredients as LAM's own demo, which also doesn't crisply blink). Controllable
whole-face emotion is a reachable mapping task. A crisp isolated blink is the one
thing THIS asset's FLAME-PCA basis can't do — but a different bake CAN (below).**

### ✅ THE ROUTE TO BOTH (teeth + clean blink): re-bake FLAME with the ARKit basis
Researching LAM's source (project page → repos) settles it. LAM ships **two**
expression bases and clean blink lives only in the ARKit one:

- **FLAME-PCA** (`lam/models/rendering/flame_model/flame.py`): expr =
  `shapedirs[:,:,300:300+100]` → the `expr0..99` morphs we have. Lid motion
  entangled → no clean blink. (What our `fisherman_flame.zip` carries.)
- **ARKit-on-FLAME** (`lam/models/rendering/flame_model/flame_arkit.py`): replaces
  the PCA with **52 ARKit blendshapes baked onto FLAME topology** (`flame_arkit_bs.npy`,
  asserts `expr_params==52`), with **`add_teeth=True` still default**. ARKit has a
  **dedicated `eyeBlinkLeft`/`eyeBlinkRight`** channel.

And LAM's blink is **procedural, not predicted**: `LAM_Audio2Expression`
(`models/utils.py` `BLINK_PATTERNS` ≈ `[0.365,0.95,0.956,0.917,0.367,0.119,0.025]`,
applied via `apply_random_eye_blinks*`) just writes that curve to ARKit indices 8/9
at random intervals. OpenAvatarChat streams a 52-channel `arkit_face` bundle
(`assets/arkit_face_channels.txt`) — that's why it blinks crisply. A real shipped
OAC sample (`james.zip → arkitWithBSData/skin.glb`) has the 52 ARKit `targetNames`
incl. `eyeBlinkLeft/Right`.

**The fix: bake the FLAME/teeth head with the ARKit-52 basis instead of `expr0..99`.**
Then the `skin.glb` carries ARKit-named morphs (`eyeBlinkLeft`…) AND teeth, and —
because our renderer keys `bsWeight` by morph NAME and **our `driver.ts` already
emits ARKit-52** — v2 drives by name directly: clean blink (dedicated channel) +
emotion + teeth, with **no PCA mapping at all** (the `EXPR_MAP`/solve problem
vanishes; v2 becomes the same ARKit drive as v1, plus teeth).

Concrete bake change (`colab_bake_flame.py`, an `--arkit` mode — NOT yet built/tested):
1. Build LAM's renderer with the **ARKit FLAME head** (`flame_arkit.py`,
   `expr_params=52`, needs the `flame_arkit_bs.npy` asset) instead of the PCA head.
2. In the `save_h5_info` equivalent, loop the **52 ARKit blendshapes** (subdivided,
   teeth-included topology) and export `bs/<arkitName>.obj` — so the Blender step
   (`generateGLBWithBlender_v2.py`, names shape keys by filename) yields morph
   `targetNames = the 52 ARKit names`.
3. Same `lbs_weight_20k.json` / `bone_tree.json` / `offset.ply` / `vertex_order.json`.
4. In the rig: drop the PCA path — set `bsWeight = driver.getFrame()` (ARKit object)
   directly; add the procedural blink curve to `eyeBlinkLeft/Right` like A2E does.

Caveat (honest): the shipped export tools don't have an out-of-the-box flag for
"teeth + ARKit morphs in one GLB" — the OAC/ARKit export (`generateARKITGLBWithBlender.py`)
injects a fixed DAZ-style `template_file.fbx` (clean ARKit blink, teeth only as
bones → not rendered), and the FLAME export (`generateGLBWithBlender_v2.py`) gives
teeth but PCA. The `--arkit` recipe above splices the two (ARKit basis through the
FLAME/teeth export path); it's grounded in LAM's code but needs a Colab bake to
validate. Source pointers: `flame_arkit.py:108,124-133`; A2E `models/utils.py:139-144`
(`BLINK_PATTERNS`), `engines/infer.py:255,283`; OAC
`avatar_handler_lam_audio2expression.py` + `assets/arkit_face_channels.txt`.

> Renderer access caveat (unchanged): published `gaussian-splat-renderer-for-lam`
> hardcodes `useFlame=false` and never merges caller options, so the spike/compare
> pages force the FLAME path with the gated `window.__FORCE_FLAME` node_modules
> patch (`tools/patch-renderer.mjs`, postinstall; NOT committed). That patch is the
> only renderer change needed — productionizing just needs `useFlame` exposed (a
> one-line vendor/fork), **not** a morph-deform fix.
