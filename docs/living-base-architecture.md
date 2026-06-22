# The living-base architecture

> The portable result of this spike. Renderer-agnostic — it holds whether the
> head is Gaussian splats, a three.js mesh, or anything else driven by
> blendshapes/morphs. Capture this regardless of which renderer wins.

## The finding, stated plainly

A **static held expression reads as a death mask.** It does not matter how good
the recipe is. The LAM sample clip felt alive for exactly one reason: it was
captured motion that **never stopped moving**. The renderer faithfully shows
whatever you feed it — so "lifeless" is never the renderer's fault, it's the
driver feeding it a frozen vector.

The first driver pass set a target expression and eased to it, then **held**.
That hold is the bug. The fix is architectural, not cosmetic.

## The model: living base + expression as bias

Two layers, composited every frame. Nothing is ever held still.

```
final[channel] = clamp01( idleBase(t)[channel] + expressionBias[channel] )
then: lids = max(lids, blink)        // blink overrides only the eyelids
```

1. **Living base** — always on, never zero, low amplitude. This is the "idle life
   that never stops." Components:
   - **micro brow/mouth drift** — slow, non-harmonic sines so it never loops
     visibly (e.g. `browInnerUp += 0.04 + 0.03·sin(t·0.85)`).
   - **breath** — a soft periodic `jawOpen` swell and/or a head-bone swell.
   - **eye saccades** — gaze darts to a new small offset every ~0.7–2.6s and
     snaps there fast (~45ms); mapped to the `eyeLookIn/Out/Up/Down` channels.
   - **blink** — autonomous, randomized, occasional double-blinks; composited via
     `max()` so it overrides the lids without fighting a held wink.
   - **head breath/sway** — tiny continuous yaw/pitch/tilt on the neck+head
     bones (the part that made the *body* read as alive, not just the face).

2. **Expression bias** — the semantic recipe (smile, smug, …), eased toward its
   target with an exponential approach (`k = 1 - exp(-dt/τ)`, τ≈0.11s), then
   **added** on top of the living base. It biases the face; it never replaces it.
   A neutral expression = bias of all zeros, so the living base alone keeps the
   face alive.

### Compositing order (matters)

```
1. ease expressionBias toward the active recipe        (per channel)
2. out[c] = expressionBias[c]                           (start from the bias)
3. out[c] += idleBase(t)[c]; clamp01                    (add living motion)
4. out.eyeBlink* = max(out.eyeBlink*, blink)            (blink wins on lids only)
```

Why this order: blink last and via `max` so neither the expression (e.g. a held
wink) nor the saccade re-opens a closing eye. Everything else is additive so the
base is always present.

## Why "additive over a living base" beats "ease to a held pose"

- A held pose has zero motion between expression changes → mask.
- Additive-over-idle means even `neutral` is alive, and every expression inherits
  the base's micro-motion, breath, blink and gaze for free.
- It degrades gracefully: turn the idle layer off (`setIdle(false)`) and you get
  the old frozen-mask failure mode back — useful for A/B confirming the effect.

## Where this lives in the spike

- `src/driver.ts` — living base (brow/mouth drift, breath, saccades, blink) +
  additive expression bias + `setIdle()` toggle.
- `src/pose.ts` — head breath/sway added on top of cursor-follow, so the head
  never freezes even with a still cursor.

## Tuning notes

- Keep base amplitudes **small** (≤~0.04). The base is felt, not seen.
- Use **non-harmonic** frequencies (0.17, 0.23, 0.55, 0.85 …) so no axis lines up
  and the loop never reads as a loop.
- Final per-expression magnitudes are **asset-dependent** — tune them on the real
  baked head, never on a single-image-recon sample.
