/**
 * FLAME head (v2) — teeth + the SAME living base as the OAC head (v1), for a fair
 * side-by-side (see compare.html). Loads a FLAME-format avatar (man.zip by
 * default, or ?avatar=…) and drives it live through createFlameRig:
 *   - driver.ts (emotion auto-fade + idle: blink/saccade/brow/mouth) and
 *     speech.ts (visemes) are the SAME "brain" v1 uses — we just translate their
 *     ARKit output onto FLAME bones + PCA (see flame-driver.ts).
 *   - jaw, eye-gaze, head sway/cursor, neck, breath are LIVE now (bones/transform).
 *   - blink/brow/emotion ride FLAME-PCA via EXPR_MAP, which must be CALIBRATED on
 *     a real head (FLAME PCA component semantics aren't known a priori). Use the
 *     sweep tools (__flame.sweepComp / .calibBlink) — until filled, expr stays
 *     neutral (face still lives via bones+breath).
 *
 * Renderer note: published gaussian-splat-renderer-for-lam hardcodes
 * useFlame=false and never merges caller options, so the FLAME path is
 * unreachable via the public API. This spike forces it with a gated local
 * node_modules patch honoring window.__FORCE_FLAME (NOT committed). Productionizing
 * needs a forked/patched renderer. See tools/TEETH_AND_SPEECH.md.
 */
import { GaussianSplatRenderer } from "gaussian-splat-renderer-for-lam";
import { createDriver } from "./driver";
import { createSpeech } from "./speech";
import { createFlameRig, createFlameFraming, EXPR_MAP } from "./flame-driver";
import { resolveAvatarPath } from "./avatar";

// Force the FLAME branch (gated node_modules patch) BEFORE getInstance.
(window as { __FORCE_FLAME?: boolean }).__FORCE_FLAME = true;

const AVATAR = resolveAvatarPath("./asset/avatars/man.zip"); // FLAME-format, has teeth
const gsDiv = document.getElementById("gs")!;
const hud = document.getElementById("hud")!;
const boot = document.getElementById("boot");
const jawSlider = document.getElementById("jaw") as HTMLInputElement;
const phrase = document.getElementById("phrase") as HTMLInputElement;
const sayBtn = document.getElementById("say")!;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

const driver = createDriver();   // emotion + idle living base (same as v1)
const speech = createSpeech();   // visemes (same as v1)

async function main() {
  let renderer: Any;
  try {
    renderer = await GaussianSplatRenderer.getInstance(gsDiv, AVATAR, {
      useFlame: true, backgroundColor: "0x000000", alpha: 0,
    } as Any);
  } catch (e) {
    fail(`getInstance(useFlame:true) failed: ${(e as Error).message}`);
    throw e;
  }
  if (!renderer?.viewer) return fail("renderer did not initialise (no viewer) — FLAME load failed");

  // getInstance already awaited loadFlameModel → flame_params + skeleton are set.
  const rig = createFlameRig(renderer);
  if (!rig.ok || !renderer.viewer.flame_params?.jaw_pose) {
    boot?.classList.add("hidden");
    return fail("WALL: flame_params/skeleton not found after load — live-drive can't proceed");
  }
  boot?.classList.add("hidden");
  rig.pinLive();

  // frame the head like v1 (the renderer's default camera misses the FLAME rig)
  const framing = createFlameFraming(renderer);
  framing.apply();
  setTimeout(() => framing.apply(), 400); // re-assert after the renderer settles

  // --- live loop: same brain (driver+speech) → FLAME rig ---
  let last = performance.now() / 1000;
  function tick() {
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.05); last = now;
    driver.update(dt);
    speech.update(dt);
    // compose ARKit frame exactly like v1: emotion/idle, breath jaw, speech via max
    const ark: Record<string, number> = { ...driver.getFrame() };
    const sp = speech.getFrame();
    for (const k in sp) ark[k] = Math.max(ark[k] ?? 0, sp[k] as number);
    // manual jaw slider rides on top (teeth testing)
    const slider = Number(jawSlider.value) || 0;
    if (slider > 0) ark.jawOpen = Math.max(ark.jawOpen ?? 0, slider / 0.55); // slider is rad; ark is 0..1
    rig.breath(now);
    rig.writeFrame(ark);
    setHud(
      `FLAME head (v2) · useFlame:true · ${AVATAR.split("/").pop()}\n` +
      `exprLen ${rig.exprLen} (FLAME-PCA) · EXPR_MAP ${Object.keys(EXPR_MAP).length ? "calibrated" : "EMPTY → no blink/emote yet"}\n` +
      `emotion ${driver.current()} · jaw bone ${rig.jawBoneRad().toFixed(3)} rad\n` +
      `living base: jaw+gaze+head-sway+neck+breath LIVE\n` +
      `calibrate: __flame.sweepComp(n,w) · prove: __flame.proveLive()`,
    );
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // (cursor-follow head removed per request — head keeps its idle micro-sway only)

  sayBtn.addEventListener("click", () => { if (phrase.value.trim()) speech.speak(phrase.value.trim()); });
  phrase.addEventListener("keydown", (e) => { if (e.key === "Enter" && phrase.value.trim()) speech.speak(phrase.value.trim()); });

  // --- make-or-break: drive jaw via the real slider path, read the bone back ---
  async function proveLive() {
    const prev = jawSlider.value;
    jawSlider.value = "0.4"; jawSlider.dispatchEvent(new Event("input"));
    await sleep(250);
    const got = rig.jawBoneRad();
    jawSlider.value = prev; jawSlider.dispatchEvent(new Event("input"));
    const live = !isNaN(got) && Math.abs(got - 0.4) < 0.08;
    const verdict = live
      ? `✅ UNKNOWN 1 = YES: jaw bone followed live value (${got.toFixed(3)} ≈ 0.4). Live FLAME-drive viable.`
      : `❌ jaw bone = ${isNaN(got) ? "n/a" : got.toFixed(3)} (wanted 0.4). Live jaw_pose not honored.`;
    console.log(verdict);
    return { live, jawBoneRad: got, verdict };
  }

  // --- calibration: sweep a single FLAME-PCA component and eyeball the effect ---
  // e.g. for (let n=0;n<rig.exprLen;n++){ __flame.sweepComp(n,1); await ... }
  // When you find the one(s) that close eyes / raise brows / smile, add them to
  // EXPR_MAP in flame-driver.ts (eyeBlinkLeft/Right, browInnerUp, mouthSmile…).
  function sweepComp(comp: number, w = 1) { rig.setExprComp(comp, w); return `expr component ${comp} = ${w}`; }
  function inspectExpr() {
    return { exprLen: rig.exprLen, compIndexSample: rig.compIndex.slice(0, 10),
      exprMapKeys: Object.keys(EXPR_MAP), note: "sweepComp(n,1) for n in 0..exprLen-1 to find blink/brow/smile" };
  }

  (window as Any).__flame = {
    renderer, rig, driver, speech, framing, AVATAR,
    proveLive, sweepComp, inspectExpr,
    zeroExpr: () => rig.zeroExpr(),
    setExpression: (k: string, o?: Any) => driver.setExpression(k, o),
    // tune framing live: __flame.setFrame({ distMul: 1.6, dy: 0.02 })
    setFrame: (p: { distMul?: number; dy?: number }) => framing.setFrame(p),
  };
}

// ---- helpers ----
function setHud(s: string) { hud.textContent = s; }
function fail(s: string) { setHud("✗ " + s); console.error("[flame-spike]", s); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error("flame-spike failed:", e); setHud(`ERROR: ${(e as Error).message}`); });
