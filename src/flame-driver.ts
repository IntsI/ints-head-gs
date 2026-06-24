/**
 * FLAME rig — maps the SAME ARKit "brain" (driver.ts emotion + idle, speech.ts
 * visemes) onto LAM's FLAME render path, so v2 (teeth) can be compared fairly
 * against v1 (OAC) with the same living base.
 *
 * The FLAME path is bones + a 100-dim FLAME-PCA expression basis (the skin.glb
 * carries morph targets named `expr0..expr99`; per frame the renderer does
 * `splatMesh.bsWeight = flame_params['expr'][frame]` and
 * `setBoneRotation(skeleton.bones[i], flame_params[channel][frame])`). We pin
 * `totalFrames=1` and OVERWRITE index [0] every tick (proven live in the spike).
 *
 *   bones[0] <- rotation   (head/root, axis-angle 3-vec)
 *   bones[1] <- neck_pose  (3-vec)
 *   bones[2] <- jaw_pose   (3-vec, x ≈ open)
 *   bones[3] <- eyes_pose[0..2]  (left eye)   bones[4] <- eyes_pose[3..5] (right)
 *   bsWeight <- expr       (FLAME-PCA coeffs; morph i ↔ component parseInt(name_i))
 *
 * WHAT MAPS NOW vs LATER
 *   - jaw, eye-gaze, head sway/cursor, neck, breath  → BONES/transform, no PCA
 *     needed → live now.
 *   - blink, brow, mouth-shape, emotion              → need ARKit→FLAME-PCA
 *     coefficients (EXPR_MAP). FLAME PCA component semantics are not known a
 *     priori, so EXPR_MAP is calibrated empirically per the sweep tools below
 *     (man.zip ships an EMPTY expr, but the morphs exist, so sweeping works on
 *     any FLAME head). Until filled, expr stays neutral — the face still lives
 *     via bones+breath, it just doesn't blink/emote yet.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/**
 * ARKit channel → FLAME-PCA contribution. Each entry: when this ARKit coeff is
 * `v` (0..1), add `w * v` to FLAME component `comp` (0..99). CALIBRATE with the
 * sweep tools, then paste findings here. Empty = expr stays neutral (safe).
 *
 * e.g. once you find component 12 closes the eyes:
 *   eyeBlinkLeft:  [[12, 1.0]],
 *   eyeBlinkRight: [[12, 1.0]],
 */
export const EXPR_MAP: Record<string, Array<[number, number]>> = {
  // filled by calibration on a freshly-baked fisherman (see __flame.calib)
};

export interface FlameRig {
  ok: boolean;
  exprLen: number;
  /** map FLAME component number (0..99) → bsWeight/expr array index */
  compIndex: number[];
  /** Pin to a single live frame and zero the channels we own. */
  pinLive(): void;
  /** Write one composed ARKit frame into flame_params[0] (head via setHeadTarget). */
  writeFrame(ark: Record<string, number>): void;
  /** Calm breath on the bust via the splatMesh transform (no PCA). */
  breath(t: number): void;
  /** Direct jaw read-back (rad) for proofs/HUD: viewer.skeleton.bones[2]. */
  jawBoneRad(): number;
  /** Cursor head target, normalized device coords -1..1 (eased into rotation). */
  setHeadTarget(nx: number, ny: number): void;
  // --- calibration helpers (run in console on a loaded FLAME head) ---
  zeroExpr(): void;
  /** Set a single FLAME component to weight w (zeros the rest). For sweeping. */
  setExprComp(comp: number, w: number): void;
  raw: { viewer: Any; fp: Any; sm: Any };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

// ARKit (0..1) → radians/scale tuning for the bone channels.
const JAW_RAD = 0.55;   // jawOpen=1 → ~0.55 rad (matches the spike's good range)
const EYE_RAD = 0.30;   // full gaze dart → ~0.30 rad eye rotation
const HEAD_YAW = 0.42;  // cursor head yaw range (rad), split head/neck
const HEAD_PITCH = 0.26;

export function createFlameRig(renderer: Any): FlameRig {
  const viewer: Any = renderer?.viewer;
  const fp: Any = viewer?.flame_params;
  const sm: Any = viewer?.splatMesh;
  const ok = !!(viewer && fp && viewer.skeleton && sm);

  // morph component-number → array index (names are "exprNN", shuffled order)
  const compIndex: number[] = [];
  let exprLen = 0;
  if (ok) {
    const root = viewer.avatarMesh || viewer.skinModel;
    let dict: Record<string, number> | null = null;
    root?.traverse?.((n: Any) => { if (n.morphTargetDictionary && !dict) dict = n.morphTargetDictionary; });
    if (dict) {
      exprLen = Object.keys(dict).length;
      for (const [name, idx] of Object.entries(dict as Record<string, number>)) {
        const m = /^expr(\d+)$/.exec(name);
        if (m) compIndex[Number(m[1])] = idx;
      }
    }
  }

  // breath transform baseline (captured at pin time)
  let baseY = 0, baseZ = 0, sx = 1, sy = 1, sz = 1;
  // head sway clock + eased cursor
  let cYaw = 0, cPitch = 0, tYaw = 0, tPitch = 0;

  function newExpr(): number[] { return new Array(exprLen).fill(0); }

  return {
    ok, exprLen, compIndex,
    raw: { viewer, fp, sm },

    pinLive() {
      if (!ok) return;
      fp.expr = [newExpr()];
      fp.jaw_pose = [[0, 0, 0]];
      fp.rotation = [[0, 0, 0]];
      fp.neck_pose = [[0, 0, 0]];
      fp.eyes_pose = [[0, 0, 0, 0, 0, 0]];
      for (const o of [viewer, renderer]) { if (o && "totalFrames" in o) o.totalFrames = 1; if (o && "frame" in o) o.frame = 0; }
      baseY = sm.position.y; baseZ = sm.position.z;
      sx = sm.scale.x; sy = sm.scale.y; sz = sm.scale.z;
    },

    writeFrame(ark) {
      if (!ok) return;
      viewer.frame = 0; if ("frame" in renderer) renderer.frame = 0;

      // --- JAW (bone) ---
      const jaw = clamp(ark.jawOpen ?? 0, 0, 1) * JAW_RAD;
      fp.jaw_pose[0] = [jaw, 0, 0];

      // --- EYE GAZE (bones 3/4) from ARKit look channels ---
      const lYaw = ((ark.eyeLookInLeft ?? 0) - (ark.eyeLookOutLeft ?? 0)) * EYE_RAD;
      const rYaw = ((ark.eyeLookOutRight ?? 0) - (ark.eyeLookInRight ?? 0)) * EYE_RAD;
      const lPit = ((ark.eyeLookDownLeft ?? 0) - (ark.eyeLookUpLeft ?? 0)) * EYE_RAD;
      const rPit = ((ark.eyeLookDownRight ?? 0) - (ark.eyeLookUpRight ?? 0)) * EYE_RAD;
      fp.eyes_pose[0] = [lPit, lYaw, 0, rPit, rYaw, 0];

      // --- HEAD + NECK (bones 0/1): eased cursor + always-on micro sway ---
      const k = 1 - Math.exp(-0.016 / 0.12);
      cYaw += (tYaw - cYaw) * k; cPitch += (tPitch - cPitch) * k;
      const tt = performance.now() / 1000;
      const swayY = Math.sin(tt * 0.23) * 0.015;
      const swayX = Math.sin(tt * 0.6 + 1.3) * 0.010;
      const tiltZ = Math.sin(tt * 0.17) * 0.012;
      const yaw = -cYaw * HEAD_YAW, pitch = -cPitch * HEAD_PITCH;
      fp.rotation[0] = [pitch * 0.6 + swayX, yaw * 0.6 + swayY, tiltZ];
      fp.neck_pose[0] = [pitch * 0.4, yaw * 0.4 + swayY * 0.5, 0];

      // --- EXPR (FLAME-PCA): blink/brow/mouth/emotion via calibrated EXPR_MAP ---
      const e = fp.expr[0];
      for (let i = 0; i < e.length; i++) e[i] = 0;
      for (const ch in EXPR_MAP) {
        const v = ark[ch]; if (!v) continue;
        for (const [comp, w] of EXPR_MAP[ch]) {
          const idx = compIndex[comp];
          if (idx != null) e[idx] += w * v;
        }
      }
    },

    breath(t) {
      if (!ok) return;
      const PERIOD = 4.6, BOB = 0.0025, LEAN = 0.002, SWELL = 0.0022;
      const s = Math.sin((t % PERIOD) / PERIOD * Math.PI * 2);
      const inhale = (s + 1) / 2;
      sm.position.y = baseY + s * BOB;
      sm.position.z = baseZ + s * LEAN;
      const g = 1 + inhale * SWELL;
      sm.scale.set(sx * g, sy * g, sz * g);
      // nostril/mouth breath bias is ARKit→PCA, so it rides through writeFrame's
      // EXPR_MAP once calibrated; jaw breath already comes through ark.jawOpen.
    },

    // cursor target (normalized -1..1); call from pointermove
    // (kept on the object via closure setters below)
    jawBoneRad() {
      const q = viewer?.skeleton?.bones?.[2]?.quaternion;
      return q ? 2 * Math.acos(Math.min(1, Math.abs(q.w))) : NaN;
    },

    setHeadTarget(nx, ny) { tYaw = clamp(nx, -1, 1); tPitch = clamp(ny, -1, 1); },

    zeroExpr() { if (ok) fp.expr[0] = newExpr(); },
    setExprComp(comp, w) {
      if (!ok) return;
      const e = newExpr();
      const idx = compIndex[comp];
      if (idx != null) e[idx] = w;
      fp.expr[0] = e;
      viewer.frame = 0;
    },
  };
}
