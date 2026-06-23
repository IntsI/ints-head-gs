# Avatar format reconciliation — does a LAM export load in this renderer?

**Verdict: YES — LAM's OpenAvatarChat (OAC) export is exactly the format this
renderer's default path loads. No repack needed.** Use the **OAC export**, NOT
the `h5_render_data.zip`. One hard constraint: the zip's inner folder name must
equal the zip filename (the OAC export already guarantees this).

This was determined by reading the renderer's loader and LAM's exporter source —
not inferred. Sources cited below so it's checkable.

---

## 0. BAKE TARGET — what a real export MUST be (read this first)

This is the spec the real bake gets validated against. If a generated avatar
meets all of this, it loads; if not, it won't.

### The 4 required files (exact names, all required)
```
skin.glb            mesh + skeleton (incl. head/neckUpper bones) + LBS + ARKit-52 morphs
offset.ply          the Gaussian splat data
animation.glb       animation clip (OAC copies a shared one — fine)
vertex_order.json   splat → mesh-vertex index map
```
Miss any one and the renderer's default load path throws.

### The zip MUST contain an explicit DIRECTORY ENTRY (the real gotcha)
The 4 files must sit inside a **single top-level folder, and that folder must
exist in the zip as an explicit directory entry** (a zip member whose name ends
in `/`):
```
myhead.zip
├── myhead/                ← REQUIRED explicit directory entry (a real zip member)
│   ├── skin.glb
│   ├── offset.ply
│   ├── animation.glb
│   └── vertex_order.json
```
Why (verified against the renderer bundle): on load it scans the zip for a
directory member to discover the folder name —
```js
let fileName = '';
Object.values(zipData.files).forEach(f => { if (f.dir) fileName = f.name.slice(0,-1); });
if (!fileName) throw new Error('file fold is not found');   // <-- no dir entry => this
```
and then reads `fileName + '/skin.glb'` etc. **The folder name comes from the
directory entry, NOT from the zip filename** — the URL only needs to end in
`something.zip` (any name). So:
- A zip with `myhead/skin.glb` … but **no `myhead/` directory member** fails with
  `Error: file fold is not found`. This is exactly what a Python `zipfile`-built
  zip looks like (file entries only). The `zip` CLI / `patoolib` (what LAM's own
  `app_lam.py` uses) DO write the directory entry — which is why a Gradio export
  loads but an early `colab_bake_oac.py` bake didn't.
- **The spike auto-repacks on load.** Both the drag-drop and `?avatar=` paths
  pre-check the zip and, if the directory entry is missing, repack it in-browser
  (JSZip) before handing it to the renderer (`src/avatar.ts → repackZip`). So a
  dir-entry-less zip "just works" in the spike — no manual step.
- **Fix a zip on disk / outside the spike:** `python tools/repack_oac.py
  <bake>.zip`. The current `colab_bake_oac.py` also writes the directory entry
  itself, so new Colab bakes are fine.
- Convention: keep the folder name == the zip basename (LAM does, and it keeps
  things obvious), but only the *presence* of the directory entry is enforced.
- macOS `__MACOSX/` + `.DS_Store` junk is ignored.

### What the validator checks and how it reports problems
`src/avatar.ts` → `inspectAvatarZip(bytes)` runs on every drag-drop/file-input
BEFORE anything touches the GPU:
1. Lists top-level folders, ignoring `__MACOSX/` and dotfiles.
   - 0 folders → `✗ zip is empty or has no top-level folder`.
   - >1 folder → warns `multiple top-level entries (…); using "<first>"`.
2. Takes that folder as `<name>` and checks `<name>/<file>` exists for each of
   the 4 required files.
3. Reports a precise verdict in the on-screen status box:
   - **Pass:** `✓ valid OAC avatar "<folder>" — loading…` then auto-loads.
   - **Fail:** `✗ <file>.zip is not loadable` + the detected `folder:` +
     `missing: <comma-list>` + the full required list. So a missing or misnamed
     file is named explicitly, not a silent failure.
   - **Misnamed inner folder on upload is auto-handled:** the uploader names the
     cache URL after the *detected* folder, so folder==name holds by
     construction. The folder==zipname rule only bites the static `?avatar=`
     path below (and any zip you hand to the renderer directly).

> Note: the validator confirms the 4 files are *present and correctly named/
> nested*. It does not parse GLB/PLY internals — a structurally corrupt
> `skin.glb` would pass inspection and then fail at render. The render-time path
> still surfaces that as `✗ renderer failed to load …`.

### The exact `?avatar=` URL pattern (load a custom zip without drag-drop)
```
http://localhost:5173/?avatar=<url-to-zip>
```
- Bundled sample:   `http://localhost:5173/?avatar=./asset/arkit/p2-1.zip`
- A zip you copied into `public/asset/avatars/`:
  `http://localhost:5173/?avatar=./asset/avatars/myhead.zip`
- For this static path YOU must ensure the zip's filename == its inner folder
  (e.g. `myhead.zip` → `myhead/…`), since the renderer derives `<name>` from the
  URL. The drag-drop path doesn't require this (it auto-matches).

(Or skip the URL and just edit `DEFAULT_AVATAR` in `src/main.ts`.)

---

## 1. What the renderer actually loads

Source: `node_modules/gaussian-splat-renderer-for-lam/build/…module.js`
(the npm package ships built JS only; analysis is of that bundle).

### How it finds the avatar inside the zip
`getInstance(container, assetPath, options)`:
```js
const { pathname } = urlParse(assetPath);
const matches = pathname.match(/\/([^/]+?)\.zip/);
const characterName = matches && matches[1];        // e.g. "p2-1"
if (!characterName) throw new Error('character model is not found');
```
Then every file is read as `characterName + '/<file>'` via JSZip's
`zip.file(path)`, which is an **exact-path match**.

➡️ **Constraint: the top-level folder inside the zip MUST equal the zip's
filename (without `.zip`).** `alice.zip` → must contain `alice/skin.glb`, etc.
Rename the zip and you must rename the inner folder to match.

### Which load path runs
The renderer has two paths, switched by `this.useFlame`:
- Constructor sets `this.useFlame = false`. **No option overrides it** (checked).
- Branch: `if (viewer.useFlame == true) loadFlameModel() else loadModel()`.

So the **default and only-reachable path is `loadModel` (non-FLAME)**.

### Files the default path requires (exactly 4)
```js
// loadModel(pathName):
Promise.all([
  unpackAndLoadGlb (pathName + '/skin.glb'),        // mesh + 262-bone rig + LBS + 51 ARKit morphs
  unpackAndLoadGlb (pathName + '/animation.glb'),   // animation clip
  unpackAndLoadJson(pathName + '/vertex_order.json')// splat↔vertex ordering
]);
// getInstance, separately:
unpackFileAsBlob(fileName + '/offset.ply');         // the Gaussian splats → addSplatScene
```

| File | Purpose | Required by default path |
|------|---------|--------------------------|
| `skin.glb` | mesh, skeleton, LBS weights, ARKit blendshapes | ✅ |
| `offset.ply` | Gaussian splat data | ✅ |
| `animation.glb` | animation clip | ✅ |
| `vertex_order.json` | splat→vertex index map | ✅ |

The FLAME path (`loadFlameModel`, **unreachable** by default) instead wants
`lbs_weight_20k.json`, `flame_params.json`, `bone_tree.json` (+ skin.glb,
vertex_order.json) and **no** offset.ply/animation.glb. Ignore it.

### Ground truth: the sample `p2-1.zip` contains
```
p2-1/skin.glb            3.4M
p2-1/offset.ply          1.3M
p2-1/animation.glb       2.1M
p2-1/vertex_order.json   204K
(+ harmless macOS junk: __MACOSX/, .DS_Store — ignored, exact-path reads)
```
Inner folder `p2-1/` == zip name `p2-1.zip`. ✔ Matches the spec above exactly.

---

## 2. What LAM's exporter produces

Source: `aigc3d/LAM` @ `master` — `app_lam.py`, `tools/AVATAR_EXPORT_GUIDE.md`,
`tools/generateARKITGLBWithBlender.py`. LAM has **two** export formats:

### (A) OAC export — OpenAvatarChat (`enable_oac_file=True`) ✅ THE ONE TO USE
`app_lam.py` lines 304-342 build `output/open_avatar_chat/<id>/`:
```python
res['cano_gs_lst'][0].save_ply(oac_dir/"offset.ply", …)         # offset.ply
generate_glb(input_mesh, template_fbx, output_glb=oac_dir/"skin.glb", …)  # skin.glb
shutil.copy('./assets/sample_oac/animation.glb', oac_dir/'animation.glb') # animation.glb
# then zips the folder <id> into <id>.zip  (inner folder == zip name)
```
`vertex_order.json` is produced **inside `generate_glb`**, Step 4
(`generateARKITGLBWithBlender.py` lines 234-237):
```python
gen_vertex_order_with_blender(input_mesh,
    Path(os.path.join(os.path.dirname(output_glb), 'vertex_order.json')), …)
```
i.e. written next to `skin.glb` in `oac_dir`. So the OAC zip ends up containing:
```
<id>/skin.glb   <id>/offset.ply   <id>/animation.glb   <id>/vertex_order.json
```
**Identical file set + folder convention to what the renderer loads.** ✔

### (B) `h5_render_data.zip` — ❌ do NOT use
`create_zip_archive` (lines 188-203) packs `lbs_weight_20k.json`, `offset.ply`,
`skin.glb`, `vertex_order.json`, `bone_tree.json`, `flame_params.json` into a
folder `h5_render_data/`. That's the FLAME file set (and folder name ≠ your zip
name). The default renderer path can't load it.

---

## 3. Do they match? — YES

| Renderer default path needs | OAC export provides |
|---|---|
| `<name>/skin.glb` | ✅ |
| `<name>/offset.ply` | ✅ |
| `<name>/animation.glb` | ✅ (copied from a shared sample clip) |
| `<name>/vertex_order.json` | ✅ (generate_glb step 4) |
| inner folder == zip name | ✅ (zips the `<id>` folder into `<id>.zip`) |

**No transform required.** The OAC `<id>.zip` is a direct drop-in.

---

## 4. Exact drop-in instructions

1. Generate the avatar via the LAM ModelScope demo / `app_lam.py` gradio with the
   **OpenAvatarChat export enabled** (the `enable_oac_file` checkbox / OAC export
   button). You get `<id>.zip`.
2. Drop it into the spike one of two ways:
   - **File/drag-drop zone** (in-page): just drop `<id>.zip`. The app validates
     the 4 files + detects the inner folder, then loads it. (See `src/avatar.ts`.)
   - **Static path**: copy `<id>.zip` into `public/asset/avatars/`, then open
     `http://localhost:5173/?avatar=./asset/avatars/<id>.zip`, or change
     `DEFAULT_AVATAR` in `src/main.ts`.
3. Everything already built (driver, idle living-base, cursor-follow, keyboard)
   runs unchanged — LAM avatars share the skeleton (`head`, `neckUpper` bones)
   and the ARKit-52 morph vocabulary.

### If a load ever fails, check in this order
- **Inner folder ≠ zip name** → rename one to match (most common gotcha).
- **Missing `vertex_order.json`** → your export skipped `generate_glb` step 4;
  run `tools/generateVertexIndices.py` on the mesh, or re-export via OAC.
- **You used `h5_render_data.zip`** → wrong format; export via OAC instead.
- **`animation.glb` absent** → OAC copies a stock clip; if your pipeline omitted
  it, copy any LAM `animation.glb` in (it's a shared idle/talk clip, not
  per-avatar).

> Caveat worth a 60-second live check before baking a batch: this analysis is
> against `aigc3d/LAM` @ master and renderer `0.0.9-alpha.1`. Generate ONE OAC
> avatar, drop it in, confirm it renders — then bake the rest.
