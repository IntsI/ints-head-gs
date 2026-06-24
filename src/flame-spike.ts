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
import { createDriver, RECIPES } from "./driver";
import { createSpeech } from "./speech";
import { createFlameRig, createFlameFraming, EXPR_MAP, type FlameRig } from "./flame-driver";
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
      (rig.arkitMode
        ? `exprLen ${rig.exprLen} · ARKit-morph head → blink+emotion+visemes BY NAME ✓\n`
        : `exprLen ${rig.exprLen} (FLAME-PCA) · no clean blink on this head (re-bake --arkit)\n`) +
      `emotion ${driver.current()} · jaw bone ${rig.jawBoneRad().toFixed(3)} rad\n` +
      `living base: ${rig.arkitMode ? "blink+emotion+" : ""}jaw+gaze+head-glances+neck+breath LIVE\n` +
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
  function sweepComp(comp: number, w = 2.5) { rig.setExprPause(true); rig.setExprComp(comp, w); return `expr[${comp}] = ${w} (paused; call __flame.resumeExpr() to un-pause)`; }
  function resumeExpr() { rig.setExprPause(false); rig.zeroExpr(); return "expr resumed (EXPR_MAP live)"; }
  function inspectExpr() {
    return { exprLen: rig.exprLen, compIndexSample: rig.compIndex.slice(0, 10),
      exprMapKeys: Object.keys(EXPR_MAP), note: "sweepComp(n,1) for n in 0..exprLen-1 to find blink/brow/smile" };
  }

  // --- live control panel (ARKit morphs): sliders + emotion presets ---
  const panel = buildPanel(rig);

  (window as Any).__flame = {
    renderer, rig, driver, speech, framing, AVATAR,
    proveLive, sweepComp, resumeExpr, inspectExpr,
    setBlink: (a: number) => rig.setBlink(a),
    zeroExpr: () => rig.zeroExpr(),
    setExpression: (k: string, o?: Any) => driver.setExpression(k, o),
    // tune framing live: __flame.setFrame({ distMul: 1.6, dy: 0.02 })
    setFrame: (p: { distMul?: number; dy?: number }) => framing.setFrame(p),
    // control panel from console:
    setMorph: (n: string, v: number) => panel.setMorph(n, v),
    preset: (n: string, intensity = 1) => panel.preset(n, intensity),
    reset: () => panel.reset(),
    morphs: () => rig.morphList(),
    presets: () => Object.keys(RECIPES),
  };
}

// ---- live control panel ----------------------------------------------------
// Sliders for every ARKit morph the head carries (grouped) + emotion presets
// (RECIPES from driver.ts) with an intensity scale. All compose as manual BIAS
// over the living base (breath/blink/gaze) via rig.setMorph. ARKit heads only.
const GROUPS: [string, RegExp][] = [
  ["Eyes", /^eye/], ["Brows", /^brow/], ["Cheeks", /^cheek/],
  ["Nose", /^nose/], ["Jaw", /^jaw/], ["Mouth", /^mouth/], ["Tongue", /^tongue/],
];
const groupOf = (n: string) => GROUPS.find(([, re]) => re.test(n))?.[0] ?? "Other";
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

function buildPanel(rig: FlameRig) {
  const $ = (id: string) => document.getElementById(id)!;
  const slidersEl = $("sliders"), presetsEl = $("presets");
  const intensityEl = $("intensity") as HTMLInputElement, intensityVal = $("intensityVal");
  // panel show/hide toggle (works regardless of mode)
  const panelEl = $("panel"), toggle = $("panelToggle");
  toggle.addEventListener("click", () => {
    const hidden = panelEl.classList.toggle("hidden");
    toggle.textContent = hidden ? "panel ⟩" : "panel ⟨";
  });

  const morphs = rig.morphList();
  if (!rig.arkitMode || morphs.length === 0) {
    slidersEl.innerHTML = '<div class="hint">No ARKit morphs on this head (PCA expr basis). ' +
      'Bake with <code>--arkit</code> to get the 52 named blendshapes + this panel.</div>';
    const noop = () => console.warn("[panel] not an ARKit head — no morphs to drive");
    return { setMorph: noop, preset: noop, reset: noop };
  }

  // build grouped sliders
  const byGroup: Record<string, string[]> = {};
  for (const n of morphs) (byGroup[groupOf(n)] ??= []).push(n);
  const order = ["Eyes", "Brows", "Cheeks", "Nose", "Jaw", "Mouth", "Tongue", "Other"];
  const els: Record<string, { rng: HTMLInputElement; val: HTMLElement }> = {};
  let currentPreset = "";
  const clearActive = () => { currentPreset = ""; [...presetsEl.children].forEach((b) => b.classList.remove("active")); };

  slidersEl.innerHTML = "";
  for (const g of order) {
    if (!byGroup[g]) continue;
    const h = document.createElement("div"); h.className = "grp"; h.textContent = g;
    slidersEl.appendChild(h);
    for (const name of byGroup[g]) {
      const row = document.createElement("div"); row.className = "row";
      const lab = document.createElement("label"); lab.textContent = name; lab.title = name;
      const rng = document.createElement("input");
      rng.type = "range"; rng.min = "0"; rng.max = "1"; rng.step = "0.01"; rng.value = "0";
      const val = document.createElement("span"); val.className = "val"; val.textContent = "0.00";
      rng.addEventListener("input", () => {
        const v = +rng.value; rig.setMorph(name, v); val.textContent = v.toFixed(2); clearActive();
      });
      row.append(lab, rng, val); slidersEl.appendChild(row);
      els[name] = { rng, val };
    }
  }
  const sync = () => { for (const n in els) { const v = rig.getMorph(n); els[n].rng.value = String(v); els[n].val.textContent = v.toFixed(2); } };

  // emotion presets (RECIPES = the v1 ARKit vocabulary), scaled by intensity
  function applyPreset(name: string, intensity: number) {
    rig.resetMorphs();
    const recipe = (RECIPES as Record<string, Record<string, number>>)[name] ?? {};
    for (const k in recipe) rig.setMorph(k, clamp01(recipe[k] * intensity));
    currentPreset = name; sync();
    [...presetsEl.children].forEach((b) => b.classList.toggle("active", (b as HTMLElement).dataset.name === name));
  }
  presetsEl.innerHTML = "";
  for (const name of Object.keys(RECIPES)) {
    const b = document.createElement("button"); b.textContent = name; b.dataset.name = name;
    b.addEventListener("click", () => applyPreset(name, +intensityEl.value));
    presetsEl.appendChild(b);
  }
  intensityEl.addEventListener("input", () => {
    intensityVal.textContent = (+intensityEl.value).toFixed(2);
    if (currentPreset) applyPreset(currentPreset, +intensityEl.value);
  });
  $("resetBtn").addEventListener("click", () => { rig.resetMorphs(); clearActive(); sync(); });

  return {
    setMorph: (n: string, v: number) => { rig.setMorph(n, v); if (els[n]) { els[n].rng.value = String(v); els[n].val.textContent = (+v).toFixed(2); } clearActive(); },
    preset: (n: string, intensity = 1) => applyPreset(n, intensity),
    reset: () => { rig.resetMorphs(); clearActive(); sync(); },
  };
}

// ---- helpers ----
function setHud(s: string) { hud.textContent = s; }
function fail(s: string) { setHud("✗ " + s); console.error("[flame-spike]", s); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error("flame-spike failed:", e); setHud(`ERROR: ${(e as Error).message}`); });
