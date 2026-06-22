/**
 * GATE 2 — driver seam.
 *
 * Maps SEMANTIC expression keys → ARKit-52 blendshape coefficient sets, eases
 * between them, and exposes the current frame for the renderer to pull via
 * `getExpressionData`. This mirrors ints-head's `expressions.ts` intent
 * (semantic → recipe) and keeps the SAME key names, so a port-back is a copy of
 * the recipe table — only the output target (ARKit dict vs three.js morphs)
 * differs.
 *
 * Composition model, same as ints-head:
 *   - the active expression sets per-channel targets; everything else eases to 0
 *   - autonomous blink composites ON TOP via max(), so blinking never stops and
 *     a held wink is never re-opened by a blink.
 */

// The renderer's blendshape vocabulary — standard ARKit 52, name-keyed.
// (Order/source: asset/test_expression_1s.json → names[].)
export const ARKIT_NAMES = [
  "browDownLeft", "browDownRight", "browInnerUp", "browOuterUpLeft",
  "browOuterUpRight", "cheekPuff", "cheekSquintLeft", "cheekSquintRight",
  "eyeBlinkLeft", "eyeBlinkRight", "eyeLookDownLeft", "eyeLookDownRight",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
  "eyeLookUpLeft", "eyeLookUpRight", "eyeSquintLeft", "eyeSquintRight",
  "eyeWideLeft", "eyeWideRight", "jawForward", "jawLeft", "jawOpen", "jawRight",
  "mouthClose", "mouthDimpleLeft", "mouthDimpleRight", "mouthFrownLeft",
  "mouthFrownRight", "mouthFunnel", "mouthLeft", "mouthLowerDownLeft",
  "mouthLowerDownRight", "mouthPressLeft", "mouthPressRight", "mouthPucker",
  "mouthRight", "mouthRollLower", "mouthRollUpper", "mouthShrugLower",
  "mouthShrugUpper", "mouthSmileLeft", "mouthSmileRight", "mouthStretchLeft",
  "mouthStretchRight", "mouthUpperUpLeft", "mouthUpperUpRight", "noseSneerLeft",
  "noseSneerRight", "tongueOut",
] as const;

export type Arkit = Partial<Record<(typeof ARKIT_NAMES)[number], number>>;

// Helper for symmetric pairs: lr("mouthSmile", 0.8) → both sides at 0.8.
const lr = (base: string, v: number): Arkit =>
  ({ [`${base}Left`]: v, [`${base}Right`]: v }) as Arkit;
const merge = (...parts: Arkit[]): Arkit => Object.assign({}, ...parts);

/**
 * Semantic key → ARKit target coefficients. Same 14 keys as ints-head. Only
 * non-zero channels are listed; the driver eases all unlisted channels to 0.
 * These are first-pass recipes — tune against a real baked head, not the sample.
 */
export const RECIPES: Record<string, Arkit> = {
  neutral: {},

  smile: merge(lr("mouthSmile", 0.85), lr("cheekSquint", 0.5), lr("eyeSquint", 0.2)),

  beam: merge(
    lr("mouthSmile", 1.0), lr("cheekSquint", 0.85), lr("eyeSquint", 0.45),
    { jawOpen: 0.16, browInnerUp: 0.12 },
  ),

  // one brow down, tight asymmetric squint, mouth pulled to one side
  suspicious: {
    browDownLeft: 0.55, eyeSquintLeft: 0.65, eyeSquintRight: 0.3,
    mouthLeft: 0.3, mouthPressLeft: 0.35, mouthDimpleLeft: 0.2,
  },

  // one-sided smirk
  smug: {
    mouthSmileLeft: 0.7, mouthDimpleLeft: 0.5, cheekSquintLeft: 0.45,
    eyeSquintLeft: 0.35, eyeSquintRight: 0.25, browDownRight: 0.2,
  },

  shock: merge(
    lr("eyeWide", 0.9), lr("browOuterUp", 0.7),
    { browInnerUp: 0.8, jawOpen: 0.7 },
  ),

  unimpressed: merge(
    lr("mouthFrown", 0.25), lr("mouthPress", 0.3), lr("eyeSquint", 0.3),
    lr("browDown", 0.15), { browInnerUp: 0.12 },
  ),

  angry: merge(
    lr("browDown", 0.9), lr("noseSneer", 0.45), lr("mouthPress", 0.5),
    lr("eyeSquint", 0.4), lr("mouthFrown", 0.3), { jawForward: 0.2 },
  ),

  sad: merge(
    lr("mouthFrown", 0.6), lr("mouthLowerDown", 0.2),
    { browInnerUp: 0.85, mouthShrugLower: 0.25, eyeSquintLeft: 0.1, eyeSquintRight: 0.1 },
  ),

  // left eye closed + half smile on that side
  wink: {
    eyeBlinkLeft: 1.0, mouthSmileLeft: 0.55, cheekSquintLeft: 0.55,
    mouthSmileRight: 0.2,
  },

  tongue: merge(lr("mouthSmile", 0.3), { tongueOut: 1.0, jawOpen: 0.35 }),

  // wild / unhinged — wide eyes, asymmetric brow, big stretched grin
  crazy: merge(
    lr("mouthStretch", 0.45),
    { eyeWideLeft: 1.0, eyeWideRight: 0.65, jawOpen: 0.45,
      browOuterUpLeft: 0.7, browInnerUp: 0.4, tongueOut: 0.25,
      mouthSmileLeft: 0.5, mouthSmileRight: 0.5 },
  ),

  disgust: merge(
    lr("noseSneer", 0.8), lr("mouthUpperUp", 0.6), lr("browDown", 0.4),
    lr("eyeSquint", 0.5), lr("mouthLowerDown", 0.15),
  ),

  kiss: merge(
    lr("cheekSquint", 0.2), lr("eyeSquint", 0.2),
    { mouthPucker: 0.9, mouthFunnel: 0.35, browInnerUp: 0.2 },
  ),
};

export type ExpressionKey = keyof typeof RECIPES;

export interface DriverHandle {
  setExpression: (key: string) => void;
  /** Pull target for the renderer's getExpressionData. */
  getFrame: () => Record<string, number>;
  /** Advance easing + idle life. Call once per frame with dt seconds. */
  update: (dt: number) => void;
  current: () => string;
  /** Global liveliness toggle (for A/B-ing the "frozen mask" failure mode). */
  setIdle: (on: boolean) => void;
}

/**
 * KEY SPIKE FINDING: a STATIC held blendshape pose reads as a death mask. The
 * LAM sample clip felt alive only because it was captured motion that never
 * stops. So expressions can't be a freeze — they must be a BIAS layered on a
 * living base that's always in subtle motion. This idle layer is that base:
 * micro brow/mouth drift, breath, eye saccades, and blink, all low-amplitude
 * and continuous. The semantic recipe is ADDED on top, then clamped. Same
 * philosophy as ints-head/src/idle.ts — just outputting ARKit coeffs.
 */
export function createDriver(): DriverHandle {
  const expr: Record<string, number> = {}; // eased expression bias
  const tgt: Record<string, number> = {};
  const out: Record<string, number> = {};
  for (const n of ARKIT_NAMES) expr[n] = tgt[n] = out[n] = 0;

  let currentKey = "neutral";
  let idleOn = true;
  let t = 0; // internal clock

  const TAU = 0.11; // expression ease — a touch slower reads more human

  // ---- autonomous blink ----------------------------------------------------
  let timeToBlink = randRange(1.5, 4);
  let blinkT = -1;
  const BLINK_DUR = 0.16;
  let pendingDouble = false;
  function driveBlink(dt: number): number {
    if (blinkT < 0) {
      timeToBlink -= dt;
      if (timeToBlink <= 0) { blinkT = 0; pendingDouble = Math.random() < 0.25; }
      return 0;
    }
    blinkT += dt / BLINK_DUR;
    const v = blinkCurve(Math.min(blinkT, 1));
    if (blinkT >= 1) {
      blinkT = -1;
      timeToBlink = pendingDouble ? randRange(0.12, 0.22) : randRange(2.5, 6);
      pendingDouble = false;
    }
    return v;
  }

  // ---- eye saccades (gaze never sits perfectly still) ----------------------
  let sacX = 0, sacY = 0, sacTX = 0, sacTY = 0;
  let timeToSaccade = randRange(0.5, 2);
  function driveSaccade(dt: number) {
    timeToSaccade -= dt;
    if (timeToSaccade <= 0) {
      sacTX = randRange(-1, 1) * 0.15; // small darts, mostly horizontal
      sacTY = randRange(-1, 1) * 0.09;
      timeToSaccade = randRange(0.7, 2.6);
    }
    const k = 1 - Math.exp(-dt / 0.045); // saccades are fast
    sacX += (sacTX - sacX) * k;
    sacY += (sacTY - sacY) * k;
  }

  const add = (n: string, v: number) => { out[n] = clamp01(out[n] + v); };

  return {
    setExpression(key) {
      const recipe = RECIPES[key];
      if (!recipe) { console.warn(`[driver] unknown expression "${key}"`); return; }
      currentKey = key;
      for (const n of ARKIT_NAMES) tgt[n] = (recipe as Record<string, number>)[n] ?? 0;
    },

    setIdle(on) { idleOn = on; },

    update(dt) {
      t += dt;
      const k = 1 - Math.exp(-dt / TAU);
      for (const n of ARKIT_NAMES) expr[n] += (tgt[n] - expr[n]) * k;
      driveSaccade(dt);

      // start each frame from the eased expression bias
      for (const n of ARKIT_NAMES) out[n] = expr[n];

      if (idleOn) {
        // breath-paced brow lift + tiny asymmetric mouth life — never zero.
        add("browInnerUp", 0.04 + 0.03 * Math.sin(t * 0.85));
        add("mouthSmileLeft", 0.025 + 0.02 * Math.sin(t * 0.7 + 0.4));
        add("mouthSmileRight", 0.025 + 0.02 * Math.sin(t * 0.7 + 0.9));
        add("jawOpen", 0.015 + 0.015 * Math.max(0, Math.sin(t * 0.55))); // soft breath
        // gaze saccades, mapped to ARKit look channels
        if (sacX > 0) { add("eyeLookInLeft", sacX); add("eyeLookOutRight", sacX); }
        else { add("eyeLookOutLeft", -sacX); add("eyeLookInRight", -sacX); }
        if (sacY > 0) { add("eyeLookUpLeft", sacY); add("eyeLookUpRight", sacY); }
        else { add("eyeLookDownLeft", -sacY); add("eyeLookDownRight", -sacY); }
      }

      // blink last, via max() so it overrides gaze/expression on the lids only.
      const b = driveBlink(dt);
      if (b > 0) {
        out.eyeBlinkLeft = Math.max(out.eyeBlinkLeft, b);
        out.eyeBlinkRight = Math.max(out.eyeBlinkRight, b);
      }
    },

    getFrame: () => out,
    current: () => currentKey,
  };
}

// ---- helpers --------------------------------------------------------------
function randRange(min: number, max: number) { return min + Math.random() * (max - min); }
function clamp01(v: number) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function blinkCurve(t: number): number {
  const peak = 0.38;
  if (t < peak) { const x = t / peak; return 1 - (1 - x) * (1 - x); }
  const x = (t - peak) / (1 - peak);
  return x < 0.5 ? 1 - 2 * x * x : Math.pow(-2 * x + 2, 2) / 2;
}
