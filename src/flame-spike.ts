/**
 * DE-RISKING SPIKE (separate from the working OAC head) — can we get FLAME teeth
 * AND live control?  Loads a FLAME-format teeth avatar (man.zip) with useFlame:true
 * and OVERWRITES the renderer's per-frame flame_params live instead of letting the
 * baked clip play.
 *
 * UNKNOWN 1 (make-or-break): does the renderer re-read live-updated flame_params?
 *   We pin totalFrames=1 and mutate flame_params['jaw_pose'][0] each tick; if the
 *   jaw BONE quaternion then reflects OUR value, the renderer re-reads live → viable.
 *   window.__flame.proveLive() does this check programmatically (no eyes needed).
 * UNKNOWN 2 (viseme→FLAME, minimal): drive jaw_pose from our speech jawOpen so the
 *   mouth opens on speech and teeth show. Finer expr mapping is later.
 */
import { GaussianSplatRenderer } from "gaussian-splat-renderer-for-lam";
import { createSpeech } from "./speech";

const AVATAR = "./asset/avatars/man.zip"; // FLAME-format, has teeth (gitignored, local)
const gsDiv = document.getElementById("gs")!;
const hud = document.getElementById("hud")!;
const boot = document.getElementById("boot");
const jawSlider = document.getElementById("jaw") as HTMLInputElement;
const phrase = document.getElementById("phrase") as HTMLInputElement;
const sayBtn = document.getElementById("say")!;

// The published renderer (every version) hardcodes useFlame="false" in a
// module-internal charactorConfig and never merges caller options — so the FLAME
// path is unreachable via the public API. For this DE-RISK spike only, a local
// node_modules patch honors this window flag to force the FLAME branch. Not
// committed; the OAC head never sets it, so it's unaffected. See TEETH_AND_SPEECH.md.
(window as { __FORCE_FLAME?: boolean }).__FORCE_FLAME = true;

const speech = createSpeech();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** Find whichever object actually holds flame_params (renderer / viewer / nested). */
function findFlameHost(renderer: Any): Any {
  const direct = [renderer, renderer.viewer, renderer.viewer?.splatMesh];
  for (const o of direct) if (o && o.flame_params) return o;
  const v = renderer.viewer;
  if (v) for (const k of Object.keys(v)) {
    const o = v[k];
    if (o && typeof o === "object" && o.flame_params) return o;
  }
  return null;
}

/**
 * Find the jaw bone that ACTUALLY deforms. updateFlameBones() writes to
 * viewer.skeleton.bones[2] — a skeleton built from bone_tree.json via
 * createBonesFromJson, NOT the scene-graph skeleton. Reading the scene "jaw"
 * bone shows 0 forever (it's a different object). Order: [root,neck,jaw,...].
 */
function findJawBone(renderer: Any): Any {
  return renderer.viewer?.skeleton?.bones?.[2] || null;
}

async function main() {
  let renderer: Any;
  try {
    renderer = await GaussianSplatRenderer.getInstance(gsDiv, AVATAR, {
      useFlame: true,
      backgroundColor: "0x000000",
      alpha: 0,
    } as Any);
  } catch (e) {
    setHud(`✗ getInstance(useFlame:true) failed: ${(e as Error).message}`);
    if (boot) boot.textContent = "load failed — see console / HUD";
    throw e;
  }
  if (!renderer || !renderer.viewer) {
    setHud("✗ renderer did not initialise (no viewer) — FLAME load likely failed");
    return;
  }

  // wait for flame_params to be loaded by loadFlameModel
  let host: Any = null;
  for (let i = 0; i < 60 && !host; i++) {
    host = findFlameHost(renderer);
    if (host && host.flame_params && host.flame_params["jaw_pose"]) break;
    await sleep(250);
  }
  if (!host || !host.flame_params || !host.flame_params["jaw_pose"]) {
    setHud("⚠️ WALL: couldn't find flame_params on the renderer after load.\n" +
      "FLAME host not discoverable — Option-1 live-drive can't proceed as-is.");
    boot?.classList.add("hidden");
    return;
  }
  boot?.classList.add("hidden");

  const fp = host.flame_params;
  const exprLen = Array.isArray(fp.expr?.[0]) ? fp.expr[0].length : 0;
  const neutralExpr = Array.isArray(fp.expr?.[0]) ? fp.expr[0].slice() : new Array(exprLen).fill(0);

  // --- PIN to a single live frame: replace the clip with 1-frame buffers ---
  fp.expr = [neutralExpr];
  fp.jaw_pose = [[0, 0, 0]];
  fp.rotation = [[0, 0, 0]];
  // force frame 0 everywhere a totalFrames/frame counter lives
  for (const o of [host, renderer, renderer.viewer]) {
    if (o && "totalFrames" in o) o.totalFrames = 1;
    if (o && "frame" in o) o.frame = 0;
  }

  const jawBone = findJawBone(renderer);

  // --- live drive loop: jaw from slider OR speech, written into fp[0] each tick ---
  let last = performance.now() / 1000;
  function tick() {
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.05); last = now;
    speech.update(dt);
    // keep frame pinned in case the renderer advanced it
    for (const o of [host, renderer, renderer.viewer]) if (o && "frame" in o) o.frame = 0;
    const fromSpeech = (speech.getFrame().jawOpen ?? 0) * 0.7; // ARKit jawOpen → ~rad
    const fromSlider = Number(jawSlider.value) || 0;
    const jaw = Math.max(fromSpeech, fromSlider);
    fp.jaw_pose[0] = [jaw, 0, 0]; // axis-angle: x ≈ jaw open
    fp.expr[0] = neutralExpr;     // hold neutral expr for now (UNKNOWN 2: jaw-only proof)
    const ja = jawBone ? quatAngle(jawBone.quaternion) : NaN;
    setHud(
      `FLAME teeth spike · useFlame:true · man.zip\n` +
      `flame host: ${hostLabel(renderer, host)} · exprLen ${exprLen}\n` +
      `jaw target ${jaw.toFixed(3)} rad  →  jaw bone ${isNaN(ja) ? "?" : ja.toFixed(3)} rad\n` +
      `drag jaw slider or click speak — teeth should show as it opens\n` +
      `make-or-break: __flame.proveLive() in console`,
    );
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  // --- programmatic make-or-break (no eyes): drive jaw via the real slider
  // path (tick() owns jaw_pose[0], so push through the slider it reads), then
  // read the deforming bone (viewer.skeleton.bones[2]) back. ---
  async function proveLive() {
    const set = 0.4;
    const prev = jawSlider.value;
    jawSlider.value = String(set);
    jawSlider.dispatchEvent(new Event("input"));
    await sleep(250); // let several rAF ticks apply it through tick()→updateFlameBones
    const got = jawBone ? quatAngle(jawBone.quaternion) : NaN;
    jawSlider.value = prev;
    jawSlider.dispatchEvent(new Event("input"));
    const live = !isNaN(got) && Math.abs(got - set) < 0.08;
    const verdict = live
      ? `✅ UNKNOWN 1 = YES: jaw bone followed our live value (${got.toFixed(3)} ≈ ${set}). Live FLAME-drive viable.`
      : `❌ jaw bone = ${isNaN(got) ? "n/a" : got.toFixed(3)} (wanted ${set}). Renderer not honoring live jaw_pose — Option 1 blocked.`;
    console.log(verdict);
    return { live, jawBoneRad: got, target: set, verdict };
  }

  (window as Any).__flame = { renderer, host, fp, jawBone, proveLive, AVATAR };

  sayBtn.addEventListener("click", () => { if (phrase.value.trim()) speech.speak(phrase.value.trim()); });
  phrase.addEventListener("keydown", (e) => { if (e.key === "Enter" && phrase.value.trim()) speech.speak(phrase.value.trim()); });
}

// ---- helpers ----
function setHud(s: string) { hud.textContent = s; }
function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function hostLabel(renderer: Any, host: Any) {
  if (host === renderer) return "renderer";
  if (host === renderer.viewer) return "viewer";
  if (host === renderer.viewer?.splatMesh) return "splatMesh";
  return "viewer.<key>";
}
/** angle (rad) of a THREE.Quaternion-like {x,y,z,w}. */
function quatAngle(q: Any) { return 2 * Math.acos(Math.min(1, Math.abs(q.w))); }

main().catch((e) => { console.error("flame-spike failed:", e); setHud(`ERROR: ${(e as Error).message}`); });
