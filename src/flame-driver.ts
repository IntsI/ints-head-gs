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
  /** True when skin.glb carries ARKit-named morphs (eyeBlinkLeft…) instead of
   *  expr0..99 PCA — then expression incl. CLEAN BLINK drives by name directly. */
  arkitMode: boolean;
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
  // --- manual control panel (ARKit mode): bias composed OVER the living base ---
  /** The ARKit morph names this head carries (for building the panel). */
  morphList(): string[];
  /** Set a manual bias on an ARKit morph (0 clears it). Composes additively over
   *  the autonomous frame (blink/gaze/speech), clamped 0..1. */
  setMorph(name: string, value: number): void;
  getMorph(name: string): number;
  /** Clear all manual morph bias → back to the pure living base. */
  resetMorphs(): void;
  // --- neutral offset: a STATIC baseline pose applied at rest, UNDER the living
  //     base + manual. For hand-correcting the baked neutral (mouth/chin). ---
  setNeutral(name: string, value: number): void;
  getNeutral(name: string): number;
  /** Replace the whole neutral-offset recipe (e.g. a saved per-avatar correction). */
  setNeutralOffset(map: Record<string, number>): void;
  getNeutralOffset(): Record<string, number>;
  resetNeutral(): void;
  // --- calibration helpers (run in console on a loaded FLAME head) ---
  zeroExpr(): void;
  /** Set a single FLAME component to weight w (zeros the rest). For sweeping. */
  setExprComp(comp: number, w: number): void;
  /** Pause writeFrame's expr write so a sweep persists across ticks (bones stay live). */
  setExprPause(on: boolean): void;
  /** Preview the wired blink at amount 0..1 (pauses expr; for verification/tuning). */
  setBlink(amt: number): void;
  raw: { viewer: Any; fp: Any; sm: Any };
}

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

/**
 * Persistent FLAME framing — the OAC head has createFraming (main.ts); the FLAME
 * path had none, so the renderer's default camera (target y≈1.8, z≈7) pointed at
 * empty space far above the head (the FLAME rig sits at world Y≈0). This aims the
 * OrbitControls at the head bbox centre (biased up toward the eyes) and pulls in
 * to frame the head, so v2 sits the same size/position as v1. Tune live with
 * __flame.setFrame({ distMul, dy }); persists to localStorage('gsFrameFlame').
 */
export function createFlameFraming(renderer: Any) {
  const v: Any = renderer?.viewer;
  const cam: Any = renderer?.getCamera?.() || v?.camera;
  let ctrl: Any = null;
  if (v) for (const k of Object.keys(v)) {
    const o = v[k];
    if (o && o.target && typeof o.update === "function") { if (!ctrl) ctrl = o; if (o.object === cam) { ctrl = o; break; } }
  }
  // head bbox (mesh is at origin, scale 1 → local ≈ world)
  const root = v?.avatarMesh || v?.skinModel;
  let mesh: Any = null;
  root?.traverse?.((n: Any) => { if ((n.isMesh || n.isSkinnedMesh) && !mesh) mesh = n; });
  let cx = 0, cy = 0, cz = 0, sy = 0.4;
  if (mesh?.geometry) {
    mesh.geometry.computeBoundingBox?.();
    const bb = mesh.geometry.boundingBox;
    cx = (bb.min.x + bb.max.x) / 2; cy = (bb.min.y + bb.max.y) / 2; cz = (bb.min.z + bb.max.z) / 2;
    sy = Math.max(1e-3, bb.max.y - bb.min.y);
  }
  const DEF = { distMul: 0.8, dy: 0.0, dx: 0.0 }; // tighter portrait (smaller = closer = bigger head)
  function load() { try { return { ...DEF, ...JSON.parse(localStorage.getItem("gsFrameFlame") || "{}") }; } catch { return { ...DEF }; } }
  let cfg = load();
  function apply() {
    if (!ctrl || !cam) return;
    const fov = ((cam.fov || 50) * Math.PI) / 180; // three.js fov is vertical
    const ty = cy + sy * 0.15 + cfg.dy;            // bias up toward eyes/face
    const dist = (sy * cfg.distMul) / (2 * Math.tan(fov / 2));
    const tx = cx + (cfg.dx ?? 0);                 // centred in the window (dx nudges H)
    ctrl.target.set(tx, ty, cz);
    cam.position.set(tx, ty, cz + dist);
    cam.near = Math.max(0.01, dist * 0.05); cam.far = dist * 100 + 10;
    cam.updateProjectionMatrix?.();
    ctrl.update();
  }
  return {
    apply,
    setFrame(p: { distMul?: number; dy?: number; dx?: number }) {
      cfg = { ...cfg, ...p };
      localStorage.setItem("gsFrameFlame", JSON.stringify({ distMul: cfg.distMul, dy: cfg.dy, dx: cfg.dx }));
      apply();
      return cfg;
    },
    get cfg() { return cfg; },
  };
}

// In ARKit-morph mode these channels are driven by BONES (jaw_pose / eyes_pose),
// so we must NOT also drive their ARKit morphs (would double the motion).
const BONE_DRIVEN = new Set([
  "jawOpen", "jawLeft", "jawRight", "jawForward",
  "eyeLookInLeft", "eyeLookInRight", "eyeLookOutLeft", "eyeLookOutRight",
  "eyeLookUpLeft", "eyeLookUpRight", "eyeLookDownLeft", "eyeLookDownRight",
]);

// ARKit (0..1) → radians/scale tuning for the bone channels.
const JAW_RAD = 0.55;   // jawOpen=1 → ~0.55 rad (matches the spike's good range)
const EYE_RAD = 0.30;   // full gaze dart → ~0.30 rad eye rotation
const HEAD_YAW = 0.42;  // cursor head yaw range (rad), split head/neck
const HEAD_PITCH = 0.26;

/**
 * Solve the clean blink direction in FLAME-PCA space from geometry alone:
 * find coeffs that pull the eyelids together (upper verts down, lower up) while
 * a least-squares penalty keeps the mouth region still — because individual PCA
 * components, and the clip's own blink frames, drag the mouth into a grimace.
 * Returns blinkDir[comp] scaled so blink amount 1 → ~full closure.
 */
function solveBlinkDir(mesh: Any, compIndex: number[], D: number): number[] {
  const base = mesh.geometry.attributes.position;
  const morphs = mesh.geometry.morphAttributes.position;
  const N = base.count;
  const isEye = (x: number, y: number, z: number) =>
    y > 0.012 && y < 0.05 && Math.abs(x) > 0.012 && Math.abs(x) < 0.075 && z > 0.0;
  const isMouth = (x: number, y: number, z: number) =>
    y > -0.07 && y < 0.0 && Math.abs(x) < 0.055 && z > 0.015;
  const LAMBDA = 8, MU = 0.3, dClose = 0.010, GAIN = 10;

  const A: Float64Array[] = Array.from({ length: D }, () => new Float64Array(D));
  const b = new Float64Array(D);
  for (let i = 0; i < N; i++) {
    const x = base.getX(i), y = base.getY(i), z = base.getZ(i);
    if (isEye(x, y, z)) {
      const t = y >= 0.033 ? -dClose : dClose; // upper lid down, lower lid up → converge
      const r = new Float64Array(D);
      for (let c = 0; c < D; c++) r[c] = morphs[compIndex[c]].getY(i);
      for (let p = 0; p < D; p++) { b[p] += r[p] * t; const rp = r[p], Ap = A[p]; for (let q = 0; q < D; q++) Ap[q] += rp * r[q]; }
    }
    if (isMouth(x, y, z)) { // penalize mouth motion on all axes (target 0)
      const rx = new Float64Array(D), ry = new Float64Array(D), rz = new Float64Array(D);
      for (let c = 0; c < D; c++) { const d = morphs[compIndex[c]]; rx[c] = d.getX(i); ry[c] = d.getY(i); rz[c] = d.getZ(i); }
      for (let p = 0; p < D; p++) { const Ap = A[p], xp = rx[p], yp = ry[p], zp = rz[p]; for (let q = 0; q < D; q++) Ap[q] += LAMBDA * (xp * rx[q] + yp * ry[q] + zp * rz[q]); }
    }
  }
  for (let p = 0; p < D; p++) A[p][p] += MU;

  // Gaussian elimination on [A | b]
  const M: number[][] = A.map((row, i) => { const r = Array.from(row); r.push(b[i]); return r; });
  for (let col = 0; col < D; col++) {
    let piv = col;
    for (let r = col + 1; r < D; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    [M[col], M[piv]] = [M[piv], M[col]];
    const pv = M[col][col] || 1e-9;
    for (let r = 0; r < D; r++) { if (r === col) continue; const fac = M[r][col] / pv; for (let k = col; k <= D; k++) M[r][k] -= fac * M[col][k]; }
  }
  const dir = new Array<number>(D);
  for (let i = 0; i < D; i++) dir[i] = (M[i][D] / (M[i][i] || 1e-9)) * GAIN;
  return dir;
}

export function createFlameRig(renderer: Any): FlameRig {
  const viewer: Any = renderer?.viewer;
  const fp: Any = viewer?.flame_params;
  const sm: Any = viewer?.splatMesh;
  const ok = !!(viewer && fp && viewer.skeleton && sm);

  // morph component-number → array index (names are "exprNN", shuffled order)
  const compIndex: number[] = [];
  const morphNames = new Set<string>();
  let arkitMode = false;
  let exprLen = 0;
  // blink direction in FLAME-PCA space, solved per-head from geometry: the coeff
  // vector that CLOSES the eyelids while PENALIZING mouth motion (a single PCA
  // component drags the mouth into a grimace — the clean blink is a mouth-
  // orthogonal combination). blinkDir[comp] scaled so ARKit blink=1 → full closure.
  const blinkDir: number[] = [];
  if (ok) {
    const root = viewer.avatarMesh || viewer.skinModel;
    let mesh: Any = null;
    root?.traverse?.((n: Any) => { if (n.morphTargetDictionary && n.geometry?.morphAttributes?.position && !mesh) mesh = n; });
    const dict: Record<string, number> | null = mesh?.morphTargetDictionary ?? null;
    if (dict) {
      exprLen = Object.keys(dict).length;
      for (const k of Object.keys(dict)) morphNames.add(k);
      for (const [name, idx] of Object.entries(dict)) {
        const m = /^expr(\d+)$/.exec(name);
        if (m) compIndex[Number(m[1])] = idx as number;
      }
      // ARKit-morph head (the teeth + clean-blink bake) drives by name; the PCA
      // head (expr0..99) only does the geometric blink solve (entangled, unused).
      arkitMode = morphNames.has("eyeBlinkLeft") || morphNames.has("eyeBlinkRight");
      if (!arkitMode) blinkDir.push(...solveBlinkDir(mesh, compIndex, exprLen));
    }
  }

  // breath transform baseline (captured at pin time)
  let baseY = 0, baseZ = 0, sx = 1, sy = 1, sz = 1;
  // head sway clock + eased cursor
  let cYaw = 0, cPitch = 0, tYaw = 0, tPitch = 0;
  let exprPaused = false; // calibration: hold expr so a sweep isn't wiped each tick
  const manual: Record<string, number> = {};  // manual control-panel bias (ARKit mode)
  const neutral: Record<string, number> = {}; // static neutral-offset correction (under everything)

  // Renderer keys bsWeight by morph NAME (for key in bsWeight → morphTargetDictionary[key])
  // and updateBoneMatrixTexture mutates in place, so we MUST emit ALL exprN keys
  // every frame (unused = 0) to clear stale weights. (An array → keys "0".."99" →
  // dict lookup undefined → weights silently dropped = the no-op bug we hit.)
  function newExpr(): Record<string, number> {
    const o: Record<string, number> = {};
    for (let c = 0; c < exprLen; c++) o["expr" + c] = 0;
    return o;
  }

  return {
    ok, exprLen, arkitMode, compIndex,
    raw: { viewer, fp, sm },

    pinLive() {
      if (!ok) return;
      fp.expr = [newExpr()]; // name-keyed object, all exprN = 0
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

      // --- HEAD + NECK (bones 0/1): autonomous slow "glances" + micro sway ---
      // FLAME has no eyelid bone and the expr/morph path is inert on this build
      // (blink/emotion can't show), so we lean on bone life: a gentle wander makes
      // the head slowly look around, reading alive. (setHeadTarget still overrides
      // if cursor-follow is ever re-enabled.)
      const tt = performance.now() / 1000;
      const wanderYaw = (Math.sin(tt * 0.13) * 0.5 + Math.sin(tt * 0.071 + 1.7) * 0.35) * 0.45;
      const wanderPit = (Math.sin(tt * 0.097 + 0.6) * 0.4 + Math.sin(tt * 0.053) * 0.25) * 0.4;
      if (tYaw === 0 && tPitch === 0) { tYaw = wanderYaw; tPitch = wanderPit; }
      const k = 1 - Math.exp(-0.016 / 0.5); // slow ease → unhurried glances
      cYaw += (tYaw - cYaw) * k; cPitch += (tPitch - cPitch) * k;
      tYaw = 0; tPitch = 0; // consumed; wander re-supplies next frame
      const swayY = Math.sin(tt * 0.23) * 0.012;
      const swayX = Math.sin(tt * 0.6 + 1.3) * 0.008;
      const tiltZ = Math.sin(tt * 0.17) * 0.012;
      const yaw = cYaw * HEAD_YAW, pitch = cPitch * HEAD_PITCH;
      fp.rotation[0] = [pitch * 0.6 + swayX, yaw * 0.6 + swayY, tiltZ];
      fp.neck_pose[0] = [pitch * 0.4, yaw * 0.4 + swayY * 0.5, 0];

      // --- EXPR (FLAME-PCA), NAME-KEYED object (renderer keys bsWeight by name) ---
      // NOTE: a clean isolated BLINK is NOT representable in this head's FLAME expr
      // PCA — eyelid motion is entangled with brow/cheek/mouth (penalize them → ~0
      // lid closure; allow them → facial grimace), and the captured clip's own
      // blinks move the lid only ~5%. So we do NOT drive blink here (it looked
      // "crazy"). Whole-face EXPRESSIONS (smile/surprise/etc.) DON'T need that
      // isolation, so EXPR_MAP stays wired for them. See TEETH_AND_SPEECH.md §5.
      if (!exprPaused) {
        if (arkitMode) {
          // ARKit-morph head: drive expression morphs by NAME straight from the
          // ARKit frame (driver emotion+idle incl. autonomous BLINK on
          // eyeBlinkLeft/Right + speech visemes). Skip BONE_DRIVEN channels (jaw,
          // gaze) — those ride jaw_pose/eyes_pose. Emit all names every frame
          // (0 default) to clear stale weights.
          const e: Record<string, number> = {};
          for (const name of morphNames) {
            // neutral correction (static) + autonomous (blink/emotion/visemes,
            // minus bone-driven) + manual bias. Allow small negatives for sculpting.
            const auto = BONE_DRIVEN.has(name) ? 0 : (ark[name] ?? 0);
            e[name] = clamp((neutral[name] ?? 0) + auto + (manual[name] ?? 0), -1, 1);
          }
          fp.expr[0] = e;
        } else {
          // PCA head: no clean blink (entangled); only the optional EXPR_MAP.
          const e = newExpr();
          for (const ch in EXPR_MAP) {
            const v = ark[ch]; if (!v) continue;
            for (const [comp, w] of EXPR_MAP[ch]) e["expr" + comp] = (e["expr" + comp] ?? 0) + w * v;
          }
          fp.expr[0] = e;
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

    morphList() { return [...morphNames].sort(); },
    setMorph(name, value) { if (value) manual[name] = value; else delete manual[name]; },
    getMorph(name) { return manual[name] ?? 0; },
    resetMorphs() { for (const k of Object.keys(manual)) delete manual[k]; },
    setNeutral(name, value) { if (value) neutral[name] = value; else delete neutral[name]; },
    getNeutral(name) { return neutral[name] ?? 0; },
    setNeutralOffset(map) {
      for (const k of Object.keys(neutral)) delete neutral[k];
      for (const k in map) if (map[k]) neutral[k] = map[k];
    },
    getNeutralOffset() { return { ...neutral }; },
    resetNeutral() { for (const k of Object.keys(neutral)) delete neutral[k]; },

    zeroExpr() { if (ok) fp.expr[0] = newExpr(); },
    setExprComp(comp, w) {
      if (!ok) return;
      const e = newExpr();
      e["expr" + comp] = w;   // name-keyed (renderer looks up morphTargetDictionary[key])
      fp.expr[0] = e;
      viewer.frame = 0;
    },
    setExprPause(on) { exprPaused = on; },
    setBlink(amt) {
      if (!ok) return;
      exprPaused = true;
      const e = newExpr();
      for (let c = 0; c < exprLen; c++) e["expr" + c] = blinkDir[c] * amt;
      fp.expr[0] = e; viewer.frame = 0;
    },
  };
}
