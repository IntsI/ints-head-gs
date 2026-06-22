# ints-head-gs — SPIKE (throwaway)

Viability test: can **LAM's animatable Gaussian-splatting head**
(`gaussian-splat-renderer-for-lam`, from [aigc3d/LAM_WebRender](https://github.com/aigc3d/LAM_WebRender))
clear the photoreal quality bar AND hold 60fps in-browser, as a replacement for
the three.js mesh + skin-shader route in `ints-head`?

**This is a kill-switch experiment, not a product.** Do not over-build. Not part
of the `ints-head` repo.

## Run it

```bash
npm install
npm run dev
# open the printed Local URL in a REAL Chrome (not headless) for a true fps read
```

First load fetches + decompresses a ~3.9MB `.zip` GS avatar; give it a second.

## What's here

| File | Role |
|------|------|
| `src/main.ts` | Gate 0: load LAM sample avatar, render, idle (replays LAM's sample expression clip) + a rolling fps HUD |
| `src/gs.d.ts` | Ambient types for the renderer (package ships built JS, no `.d.ts`) |
| `public/asset/arkit/p2-1.zip` | LAM's bundled sample GS avatar |
| `public/asset/test_expression_1s.json` | LAM's sample ARKit clip (973 frames @ 30fps) — used as Gate-0 idle |

## Renderer API (reverse-engineered — the valuable bit for port-back)

The package ships no types and thin docs. Confirmed from the built module +
LAM's official example:

```ts
const renderer = await GaussianSplatRenderer.getInstance(
  containerDiv,
  "./asset/arkit/p2-1.zip",
  {
    // PULL MODEL: the renderer polls these every rendered frame.
    getExpressionData: () => ({ /* [arkitName]: weight 0..1 */ }),
    getChatState:      () => "Idle", // | "Listening" | "Thinking" | "Responding"
    backgroundColor:   "0x000000",
    alpha:             0,            // 0 = transparent bg (CSS shows through)
    enablePan:         false,        // option exists in the build
  },
);
```

- **Driver seam = `getExpressionData`.** No push API; you return the *current*
  blendshape state each time it's polled. This is a clean fit for a spring/damped
  driver (Gate 2): hold target coeffs, ease toward them, return them on poll.
- **Blendshapes = standard ARKit 52**, keyed by name (not index). Exact names in
  `public/asset/test_expression_1s.json` → `names[]`. This matches `ints-head`'s
  ARKit-first action recipes, so the semantic→ARKit map ports over directly.
- Each clip frame also carries a `rotation` field (head pose) — empty `[]` in the
  sample, so pose-via-clip is unverified. Cursor-follow (Gate 3) may need another
  hook; TBD.
- Bundles its own **three.js (0.173)** — we don't import three ourselves yet.

## Gate status

- **GATE 0 — quality: PASS** (Ints eyeballed). Note: the sample's stylized look +
  dissolving shoulders are single-image-recon artifacts of *this asset*, not the
  route's ceiling. Real verdict waits on a properly baked photoreal head — do not
  over-tune against the sample.
- **GATE 1 — 60fps: PASS** (60 on iPhone, confirmed by Ints). The in-harness
  reading of 30 is a headless-Chrome rAF artifact — ignore it.
- **GATE 2 — driver seam: PASS.** `src/driver.ts` maps 14 semantic keys → ARKit
  coefficient sets with spring/damped easing; verified live (shock/smug/tongue
  all read). Same key names as ints-head → recipe table ports back as-is.
- **GATE 3 — feel + cursor follow: PASS.** Keyboard map identical to ints-head;
  cursor-follow drives the `head`+`neckUpper` bones live (`src/pose.ts`).
- **Head-pose API (route-level): CONFIRMED LIVE.** The avatar is skinned to a
  262-bone rig; rotating bones deforms the splats in real time. Not clip-only.

## ⚠️ Key finding — believability is a MOTION problem, not a renderer one

The sample clip felt natural; the first driver pass felt dead. Cause: a **static
held blendshape pose reads as a death mask**. The clip only felt alive because it
was captured motion that never stops. The renderer faithfully renders whatever you
feed it — so the fix is architectural, not a renderer limitation:

> **Never hold a static pose. Keep an always-on living base (micro brow/mouth
> drift, breath, eye saccades, blink, head sway) and layer each semantic
> expression as a BIAS on top of it.**

This is implemented in `driver.ts` (idle layer + additive expression) and
`pose.ts` (head breath/sway). It's the same "idle life that never stops"
principle as ints-head's `idle.ts`. Final per-expression tuning belongs on the
real baked head, not this sample.

## docs/

- [`living-base-architecture.md`](docs/living-base-architecture.md) — the portable
  result: living base + expression-as-bias. Renderer-agnostic; capture regardless
  of which renderer wins.
- [`PORTBACK.md`](docs/PORTBACK.md) — how to port this into ints-head (recipe-table
  copy + output-target swap). **Documentation only — not a green light.** ints-head
  stays untouched until Gate 0 is confirmed on a real baked photoreal head.

## Non-goals (do NOT)

Build a GS renderer from scratch · bake a custom avatar · run CUDA/Python/LAM
training · integrate into `ints-head` · author expressions in FLAME params.
