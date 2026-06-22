# Port-back notes: GS spike → ints-head

> **Status: DOCUMENTATION ONLY. Do not execute.**
> ints-head stays untouched until Gate 0 is re-confirmed on a real *baked
> photoreal* head (the spike used LAM's single-image-recon sample). This file is
> the recipe for that future port, written while it's fresh — not a green light.

## The one-sentence version

The driver is the **same** in both repos — semantic key → coefficient set, eased,
composited over a living base. Only the **output target** differs: the GS spike
*returns* an ARKit dict for the renderer to pull; ints-head *writes* into three.js
morph targets it owns. Port-back = **copy the recipe table** + **swap the output
target** + **fold the living-base additions into `idle.ts`**.

## Why the recipe table copies almost verbatim

ints-head's `expressions.ts` already keys recipes on semantic **action** keys
whose *first* candidate name is the ARKit name:

```ts
// ints-head/src/expressions.ts (existing)
const ACTIONS = {
  smileL: ["mouthSmileLeft", "LIP_CORNER_PULLER_L"],  // ARKit first, FACS fallback
  browInnerUpL: ["browInnerUp", "INNER_BROW_RAISER_L"],
  ...
};
```

The GS spike's `RECIPES` are keyed directly on those same ARKit names:

```ts
// ints-head-gs/src/driver.ts
smile: merge(lr("mouthSmile", 0.85), lr("cheekSquint", 0.5), lr("eyeSquint", 0.2)),
```

So the **values** (which channels, how strong, the 14 expressions) transfer 1:1.
The only adaptation is shape: GS uses raw `mouthSmileLeft: 0.85`; ints-head wires
the same number through its `smileL` action which resolves to whatever the rig
actually exports (ARKit or FACS). The numbers are the asset to copy; the
resolution layer ints-head already has stays.

> ⚠️ Re-tune magnitudes on the baked head. The spike numbers are principled FACS
> defaults validated against a *stylized* sample, not final values.

## The output-target swap

| | GS spike (`ints-head-gs`) | ints-head (target) |
|---|---|---|
| Render driver | `getInstance(div, asset, { getExpressionData })` — **pull** | own `requestAnimationFrame` loop — **push** |
| Per-frame write | `return out` (ARKit name → weight dict) | `morphs.set(morphName, weight)` per channel |
| Channel naming | raw ARKit 52 names | action keys → `resolveSemantics` → actual morph names |
| Head pose | rotate `head`/`neckUpper` **bones** in the splat skeleton | rotate the `rig` group / gaze morphs (as `idle.ts` already does) |

Concretely, the driver's compute is identical; only the last step changes:

```ts
// GS spike — driver hands the frame back, renderer pulls it:
getExpressionData: () => driver.getFrame()           // { arkitName: weight }

// ints-head — push each channel into the MorphController instead:
const frame = driver.getFrame();
for (const action in frame) morphs.set(resolve(action), frame[action]);
```

Everything above that line — easing, additive-over-idle compositing, blink via
`max()` — moves over unchanged.

## Fold the living base into `idle.ts`

This is the important part (see `living-base-architecture.md`). ints-head's
`idle.ts` already has **blink + breath**; it's missing the rest of the living
base, and `expressions.ts` currently **eases unused morphs to 0** (a replace
model, which is what produces the frozen-mask look).

Two changes:

1. **Add to `idle.ts`**: micro brow/mouth drift + eye saccades (the
   `eyeLookIn/Out/Up/Down` darts). Code is in `ints-head-gs/src/driver.ts`'s idle
   block — lift it directly.
2. **Change the compositing in `expressions.ts`** from "ease everything else to
   0" (replace) to "expression is a **bias added on top** of the idle base, then
   clamp; blink via `max` on the lids." i.e. adopt the order documented in
   `living-base-architecture.md`. This is the behavioural fix that made the spike
   feel alive.

## File-by-file map

| ints-head file | Action |
|---|---|
| `src/expressions.ts` | Paste the 14 recipe **values** from `driver.ts RECIPES`; switch compositing from replace → additive-over-idle bias |
| `src/idle.ts` | Add micro brow/mouth drift + eye saccades from `driver.ts` idle block (keep existing blink/breath) |
| `src/main.ts` | `KEY_MAP` is **already identical** — no change |
| `src/morphs.ts` | No change — `resolveSemantics` already does ARKit/FACS resolution |
| head rotation | `pose.ts` cursor-follow maps onto the `rig`/gaze path ints-head already uses; reuse the breath/sway offsets |

## Definition of done for the port (future)

- [ ] Gate 0 re-confirmed on a baked photoreal head (prerequisite — not yet met)
- [ ] 14 recipes pasted + re-tuned on that head
- [ ] `idle.ts` carries the full living base; `expressions.ts` composites additively
- [ ] cursor-follow + keyboard parity verified in-browser, 60fps on mobile
- [ ] frozen-mask A/B: `setIdle(false)` visibly reverts to the dead look
