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
  const panel = buildPanel(rig, framing);

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
    // neutral-offset correction (per-avatar; save the returned recipe):
    //   __flame.setNeutralOffset({ mouthClose: 0.2, jawForward: -0.1, … })
    setNeutralOffset: (map: Record<string, number>) => panel.setNeutralOffset(map),
    getNeutralOffset: () => panel.getNeutralOffset(),
  };
}

// ---- live control panel ----------------------------------------------------
// Sliders for every ARKit morph (grouped), emotion presets, and a two-layer model:
//   • NEUTRAL mode → sliders edit the STATIC neutral-offset (resting correction:
//     sculpt the baked mouth/chin toward the real face). Persists at rest.
//   • LIVE mode    → sliders edit transient manual bias (emotion experimentation).
// Both compose OVER the living base (breath/blink/gaze) and speech. Negatives
// allowed (sliders -1..1) for sculpting. ARKit heads only.
const GROUPS: [string, RegExp][] = [
  // custom identity-sculpt morphs (lipFullness/chinSoften/…) — bake-added, not ARKit
  ["Sculpt (identity)", /^(lip|chin|upperLip|lowerLip)/],
  ["Eyes", /^eye/], ["Brows", /^brow/], ["Cheeks", /^cheek/],
  ["Nose", /^nose/], ["Jaw", /^jaw/], ["Mouth", /^mouth/], ["Tongue", /^tongue/],
];
const groupOf = (n: string) => GROUPS.find(([, re]) => re.test(n))?.[0] ?? "Other";
const clampW = (v: number) => (v < -1 ? -1 : v > 1 ? 1 : v);

type PanelApi = {
  setMorph(n: string, v: number): void;
  preset(n: string, intensity?: number): void;
  reset(): void;
  setNeutralOffset(map: Record<string, number>): void;
  getNeutralOffset(): Record<string, number>;
};

function buildPanel(rig: FlameRig, framing: { setPanelWidth(px: number): void }): PanelApi {
  const $ = (id: string) => document.getElementById(id)!;
  const slidersEl = $("sliders"), presetsEl = $("presets");
  const intensityEl = $("intensity") as HTMLInputElement, intensityVal = $("intensityVal");
  const panelEl = $("panel"), toggle = $("panelToggle");
  const PANEL_W = panelEl.offsetWidth || 320;
  const setOpen = (open: boolean) => {
    panelEl.classList.toggle("hidden", !open);
    toggle.textContent = open ? "panel ⟨" : "panel ⟩";
    framing.setPanelWidth(open ? PANEL_W : 0); // re-frame head into the clear area
  };
  toggle.addEventListener("click", () => setOpen(panelEl.classList.contains("hidden")));
  // standalone (not inside compare's iframe) = the v2 EDITOR → open the panel + frame
  // for it. Inside compare's iframe → stay hidden (clean side-by-side, head centred).
  const standalone = (() => { try { return window.top === window.self; } catch { return true; } })();
  setOpen(standalone);

  const morphs = rig.morphList();
  if (!rig.arkitMode || morphs.length === 0) {
    slidersEl.innerHTML = '<div class="hint">No ARKit morphs on this head (PCA expr basis). ' +
      'Bake with <code>--arkit</code> to get the 52 named blendshapes + this panel.</div>';
    const noop = () => console.warn("[panel] not an ARKit head — no morphs to drive");
    return { setMorph: noop, preset: noop, reset: noop, setNeutralOffset: noop, getNeutralOffset: () => ({}) };
  }

  // ---- mode: which layer the sliders edit (default NEUTRAL — the primary goal) ----
  let mode: "neutral" | "live" = "neutral";
  const layerGet = (n: string) => (mode === "neutral" ? rig.getNeutral(n) : rig.getMorph(n));
  const layerSet = (n: string, v: number) => (mode === "neutral" ? rig.setNeutral(n, v) : rig.setMorph(n, v));

  // mode bar (inserted at the top of the panel)
  const modeBar = document.createElement("div"); modeBar.id = "modebar";
  modeBar.style.cssText = "display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:2px 0 10px";
  const modeLabel = document.createElement("span"); modeLabel.className = "hint"; modeLabel.textContent = "sliders edit →";
  const bNeutral = document.createElement("button"); bNeutral.textContent = "neutral offset";
  const bLive = document.createElement("button"); bLive.textContent = "live bias";
  const modeHint = document.createElement("span"); modeHint.className = "hint"; modeHint.style.flexBasis = "100%";
  modeBar.append(modeLabel, bNeutral, bLive, modeHint);
  presetsEl.parentElement!.insertBefore(modeBar, presetsEl);
  // active mode = yellow, inactive = gray (mode buttons aren't presets, so style explicitly)
  const styleMode = (b: HTMLButtonElement, on: boolean) => {
    b.style.background = on ? "#fcd34d" : "#334155";
    b.style.color = on ? "#0a0c10" : "#e2e8f0";
    b.style.outline = on ? "2px solid #fde68a" : "none";
  };

  // build grouped sliders (range -1..1)
  const byGroup: Record<string, string[]> = {};
  for (const n of morphs) (byGroup[groupOf(n)] ??= []).push(n);
  const order = ["Sculpt (identity)", "Eyes", "Brows", "Cheeks", "Nose", "Jaw", "Mouth", "Tongue", "Other"];
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
      rng.type = "range"; rng.min = "-1"; rng.max = "1"; rng.step = "0.01"; rng.value = "0";
      const val = document.createElement("span"); val.className = "val"; val.textContent = "0.00";
      rng.addEventListener("input", () => {
        const v = +rng.value; layerSet(name, v); val.textContent = v.toFixed(2);
        if (mode === "live") clearActive();
      });
      row.append(lab, rng, val); slidersEl.appendChild(row);
      els[name] = { rng, val };
    }
  }
  const sync = () => { for (const n in els) { const v = layerGet(n); els[n].rng.value = String(v); els[n].val.textContent = v.toFixed(2); } };

  function setMode(m: "neutral" | "live") {
    mode = m;
    styleMode(bNeutral, m === "neutral");
    styleMode(bLive, m === "live");
    modeHint.textContent = m === "neutral"
      ? "↳ NEUTRAL: sliders sculpt the resting face (static, persists under blink/breath/speech)"
      : "↳ LIVE: sliders = transient emotion bias over the living base";
    $("resetBtn").textContent = m === "neutral" ? "reset neutral offset" : "reset live bias";
    sync();
  }
  bNeutral.addEventListener("click", () => setMode("neutral"));
  bLive.addEventListener("click", () => setMode("live"));

  // emotion presets → always LIVE bias (transient); clicking one flips to live mode
  function applyPreset(name: string, intensity: number) {
    setMode("live");
    rig.resetMorphs();
    const recipe = (RECIPES as Record<string, Record<string, number>>)[name] ?? {};
    for (const k in recipe) rig.setMorph(k, clampW(recipe[k] * intensity));
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
  $("resetBtn").addEventListener("click", () => {
    if (mode === "neutral") rig.resetNeutral(); else { rig.resetMorphs(); clearActive(); }
    sync();
  });
  setMode("neutral"); // default

  const reflect = (n: string, v: number) => { if (els[n]) { els[n].rng.value = String(v); els[n].val.textContent = (+v).toFixed(2); } };
  return {
    setMorph: (n, v) => { setMode("live"); rig.setMorph(n, v); reflect(n, v); clearActive(); },
    preset: (n, intensity = 1) => applyPreset(n, intensity),
    reset: () => { if (mode === "neutral") rig.resetNeutral(); else { rig.resetMorphs(); clearActive(); } sync(); },
    setNeutralOffset: (map) => { rig.setNeutralOffset(map); if (mode === "neutral") sync(); console.log("[panel] neutral offset set:", map); },
    getNeutralOffset: () => rig.getNeutralOffset(),
  };
}

// ---- helpers ----
function setHud(s: string) { hud.textContent = s; }
function fail(s: string) { setHud("✗ " + s); console.error("[flame-spike]", s); }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

main().catch((e) => { console.error("flame-spike failed:", e); setHud(`ERROR: ${(e as Error).message}`); });
