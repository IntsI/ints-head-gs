import { GaussianSplatRenderer } from "gaussian-splat-renderer-for-lam";
import { createDriver } from "./driver";
import { createCursorPose } from "./pose";
import {
  REQUIRED_FILES, inspectAvatarZip, repackZip, registerAvatarSW, cacheUpload,
  resolveAvatarPath, listCachedAvatars,
} from "./avatar";

/**
 * Boot.
 *   Behaviour: the head just SPEAKS — it loops LAM's sample ARKit talk clip
 *   (asset/test_expression_1s.json), exactly like the original model. The old
 *   keyboard-driven expression system was removed: it disturbed the natural look.
 *   Plus live cursor-follow head rotation (doesn't touch the face).
 *   Custom avatar: ?avatar=<url> / DEFAULT_AVATAR, or drop a LAM OAC zip.
 */

// Re-point this (or use ?avatar=…) to load a different head.
const DEFAULT_AVATAR = "./asset/arkit/p2-1.zip";

const gsDiv = document.getElementById("gs")!;
const hud = document.getElementById("hud")!;
const boot = document.getElementById("boot");
const upStatus = document.getElementById("upStatus")!;

const fps = makeFpsMeter();
let lastPoll = performance.now() / 1000;
let pose: ReturnType<typeof createCursorPose> = null;
let breathe: ((t: number) => Record<string, number>) | null = null;
// Idle living base only: blink + micro brow/mouth drift + eye saccades + soft
// breath, held at neutral (no expression keys, no speech clip). Feels alive.
const driver = createDriver();

const AVATAR = resolveAvatarPath(DEFAULT_AVATAR);

function setStatus(msg: string, cls: "" | "ok" | "err" = "") {
  upStatus.textContent = msg;
  upStatus.className = cls;
}

// --- custom-avatar upload (drag-drop / file-input) ------------------------
async function handleUpload(file: File) {
  if (!file.name.toLowerCase().endsWith(".zip")) {
    setStatus(`"${file.name}" is not a .zip`, "err");
    return;
  }
  setStatus(`inspecting ${file.name}…`);
  try {
    let buf = await file.arrayBuffer();
    const check = await inspectAvatarZip(buf);
    if (!check.ok || !check.folder) {
      setStatus(
        `✗ ${file.name} is not loadable\n` +
          `  folder: ${check.folder ?? "—"}\n` +
          `  missing: ${check.missing.join(", ") || "—"}\n` +
          `  needs: ${REQUIRED_FILES.join(", ")}` +
          (check.notes.length ? `\n  ${check.notes.join("\n  ")}` : ""),
        "err",
      );
      return;
    }
    // Auto-repack if the zip lacks the directory entry the renderer needs.
    if (!check.hasDirEntry) {
      setStatus(`✓ "${check.folder}" — adding directory entry…`, "ok");
      buf = await repackZip(buf, check.folder);
    }
    setStatus(`✓ valid OAC avatar "${check.folder}" — loading…`, "ok");
    const url = await cacheUpload(buf, check.folder);
    // Reload pointed at the cached copy; SW serves it, regex sees <folder>.zip.
    location.search = `?avatar=${encodeURIComponent(url)}`;
  } catch (e) {
    setStatus(`✗ failed to read ${file.name}: ${(e as Error).message}`, "err");
  }
}

function wireUploadUI() {
  const input = document.getElementById("file") as HTMLInputElement;
  input.addEventListener("change", () => {
    if (input.files?.[0]) handleUpload(input.files[0]);
  });
  // whole-window drag-drop
  window.addEventListener("dragover", (e) => {
    e.preventDefault();
    document.body.classList.add("dragging");
  });
  window.addEventListener("dragleave", (e) => {
    if (e.relatedTarget === null) document.body.classList.remove("dragging");
  });
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    document.body.classList.remove("dragging");
    const f = e.dataTransfer?.files?.[0];
    if (f) handleUpload(f);
  });
}

async function main() {
  await registerAvatarSW();
  wireUploadUI();
  if (AVATAR !== DEFAULT_AVATAR) {
    const name = AVATAR.split("/").pop() ?? AVATAR;
    setStatus(`loading ${name}…`);
  }

  // Auto-repack on the ?avatar= path too: a zip that lacks the directory entry
  // would make the renderer throw 'file fold is not found'. We pre-fetch a
  // not-yet-cached avatar, and if it's missing the entry, repack → cache →
  // reload through the SW. The bundled default and already-cached uploads skip this.
  if (AVATAR !== DEFAULT_AVATAR && !AVATAR.startsWith("/__avatar__/")) {
    try {
      const resp = await fetch(AVATAR);
      if (resp.ok) {
        const buf = await resp.arrayBuffer();
        const check = await inspectAvatarZip(buf);
        if (check.ok && check.folder && !check.hasDirEntry) {
          const name = AVATAR.split("/").pop() ?? AVATAR;
          setStatus(`fixing ${name} (no directory entry)…`);
          const fixed = await repackZip(buf, check.folder);
          const url = await cacheUpload(fixed, check.folder);
          location.search = `?avatar=${encodeURIComponent(url)}`;
          return; // reload into the repacked, cached copy
        }
      }
    } catch {
      // network/parse hiccup — fall through and let the renderer try directly.
    }
  }

  // Speech OFF, but ALIVE: the driver holds neutral and layers the idle living
  // base (blink, micro brow/mouth drift, eye saccades, soft breath). Plus
  // cursor-follow head pose. No expression keys, no talk clip.
  function getExpressionData(): Record<string, number> {
    const now = performance.now() / 1000;
    const dt = Math.min(now - lastPoll, 0.05);
    lastPoll = now;
    driver.update(dt);
    pose?.update(dt);
    fps.tick();
    const frame = driver.getFrame();
    // breathe() moves the bust (chest rise + slight lean) AND returns breath-synced
    // blendshape deltas (nostrils + a touch of mouth) to merge on top.
    const bd = breathe?.(now);
    if (bd) for (const k in bd) frame[k] = Math.min(1, (frame[k] ?? 0) + bd[k]);
    return frame;
  }

  let renderer;
  try {
    renderer = await GaussianSplatRenderer.getInstance(gsDiv, AVATAR, {
      getExpressionData,
      getChatState: () => "Idle",
      backgroundColor: "0x000000",
      alpha: 0,
    });
  } catch (err) {
    const name = AVATAR.split("/").pop() ?? AVATAR;
    setStatus(`✗ renderer failed to load ${name}: ${(err as Error).message}`, "err");
    throw err;
  }

  // getInstance can swallow internal errors and resolve undefined (e.g. it throws
  // 'file fold is not found' when the zip has no top-level directory entry). Catch
  // that here with a clear message instead of letting it cascade.
  if (!renderer || !(renderer as { viewer?: unknown }).viewer) {
    const name = AVATAR.split("/").pop() ?? AVATAR;
    const msg =
      `✗ renderer did not initialise for ${name}. Most likely the avatar zip is ` +
      `missing its top-level directory entry — repack it with tools/repack_oac.py ` +
      `(see docs/AVATAR_FORMAT.md). Check the console for the renderer's own error.`;
    setStatus(msg, "err");
    throw new Error(msg);
  }

  boot?.classList.add("hidden");
  {
    const name = AVATAR.split("/").pop() ?? AVATAR;
    setStatus(
      AVATAR === DEFAULT_AVATAR ? "using bundled p2-1.zip" : `loaded ${name}`,
      "ok",
    );
  }

  // cursor-follow head rotation (live bone drive; doesn't touch the face).
  pose = createCursorPose(renderer);
  if (pose) {
    window.addEventListener("pointermove", (e) => {
      pose!.setTarget(
        (e.clientX / window.innerWidth) * 2 - 1,
        (e.clientY / window.innerHeight) * 2 - 1,
      );
    });
  } else {
    console.warn("[pose] head bone not found — cursor-follow disabled");
  }

  // Persistent framing: the renderer defaults to a target ABOVE the head (y≈1.8
  // vs head≈1.62) at distance 1.0 → head small + low. Re-aim at head level, closer,
  // and persist the choice so every upload looks the same. Tune live with
  // __gs.setFrame({ dist, dy }) — it saves to localStorage and reapplies on load.
  const framing = createFraming(renderer);
  framing.apply();
  setTimeout(() => framing.apply(), 400); // re-assert after the renderer settles

  breathe = createBreath(renderer); // calm, slight breathing on the bust

  (window as unknown as { __gs: unknown }).__gs = {
    renderer, pose, framing,
    setFrame: (p: { dist?: number; dy?: number }) => framing.setFrame(p),
  };

  void buildVariantSwitcher();

  setInterval(() => {
    hud.textContent =
      `ints-head-gs · idle — alive (blink + micro motion)\n` +
      `fps ${fps.value().toFixed(0).padStart(3)} · ${fps.frameMs().toFixed(1)}ms` +
      `${pose ? " · move cursor to look" : ""}`;
  }, 200);
}

// Calm, slight breathing. The mixer clobbers every bone, so we breathe via the
// splatMesh transform (it holds): a small chest rise + a slight forward lean, plus
// breath-synced nostril flare and a touch of mouth (ARKit blendshapes, returned to
// be merged into the frame). ~13 breaths/min.
function createBreath(renderer: unknown): ((t: number) => Record<string, number>) | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sm: any = (renderer as any).viewer?.splatMesh;
  if (!sm) return null;
  const baseY = sm.position.y, baseZ = sm.position.z;
  const sx = sm.scale.x, sy = sm.scale.y, sz = sm.scale.z;
  const PERIOD = 4.6; // seconds per breath (~13/min, calm)
  const BOB = 0.005;  // vertical chest rise (world units, slight)
  const LEAN = 0.004; // back/forth micro-lean
  const SWELL = 0.004; // uniform swell (chest filling), 0.4%
  return (t: number) => {
    const s = Math.sin((t % PERIOD) / PERIOD * Math.PI * 2); // -1..1
    const inhale = (s + 1) / 2; // 0..1, peak at full inhale
    sm.position.y = baseY + s * BOB;
    sm.position.z = baseZ + s * LEAN;
    const k = 1 + inhale * SWELL;
    sm.scale.set(sx * k, sy * k, sz * k);
    // nostrils flare + mouth eases on the inhale — slight
    return {
      noseSneerLeft: inhale * 0.05,
      noseSneerRight: inhale * 0.05,
      jawOpen: inhale * 0.015,
    };
  };
}

// Persistent, tunable camera framing. Aims the renderer's OrbitControls at the
// head bone (not the default target ~0.18 above it) and pulls closer. Choice is
// saved to localStorage so every avatar/upload frames identically.
interface FrameCfg { dist: number; dy: number }
function createFraming(renderer: unknown) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = (renderer as any).viewer;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cam: any = (renderer as any).getCamera?.();
  // active OrbitControls = the one whose .object is the live camera
  let ctrl: any = null; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (v) {
    for (const k of Object.keys(v)) {
      const o = v[k];
      if (o && o.target && typeof o.update === "function" && o.object === cam) { ctrl = o; break; }
    }
    if (!ctrl) for (const k of Object.keys(v)) {
      const o = v[k];
      if (o && o.target && typeof o.update === "function") { ctrl = o; break; }
    }
  }
  // head height (per-avatar; LAM rigs sit ~1.62). Fallback to current target.
  let headY = ctrl ? ctrl.target.y : 1.62;
  const scene = v?.scene || v?.threeScene || v?.splatMesh?.parent;
  scene?.traverse?.((n: any) => { // eslint-disable-line @typescript-eslint/no-explicit-any
    if ((n.isBone || n.type === "Bone") && n.name === "head") {
      n.updateWorldMatrix(true, false); headY = n.matrixWorld.elements[13];
    }
  });

  const DEF: FrameCfg = { dist: 0.72, dy: 0.0 };
  function load(): FrameCfg {
    try { return { ...DEF, ...JSON.parse(localStorage.getItem("gsFrame") || "{}") }; }
    catch { return { ...DEF }; }
  }
  let cfg = load();

  function apply() {
    if (!ctrl || !cam) return;
    const ty = headY + cfg.dy;
    ctrl.target.set(0, ty, 0);
    cam.position.set(0, ty, cfg.dist);
    cam.updateProjectionMatrix?.();
    ctrl.update();
  }
  return {
    apply,
    setFrame(p: Partial<FrameCfg>) {
      cfg = { ...cfg, ...p };
      localStorage.setItem("gsFrame", JSON.stringify({ dist: cfg.dist, dy: cfg.dy }));
      apply();
      return cfg;
    },
    get cfg() { return cfg; },
  };
}

// Variant switcher: list every avatar in the SW cache as a clickable chip so you
// can flip between baked shape variants. [ / ] cycle. Selecting reloads via SW.
async function buildVariantSwitcher() {
  const el = document.getElementById("variants");
  if (!el) return;
  const list = await listCachedAvatars();
  if (list.length === 0) return; // nothing cached yet — drop a few variants first
  const curName = (AVATAR.split("/").pop() ?? AVATAR).replace(/\.zip$/, "");
  el.innerHTML = "";
  for (const a of list) {
    const chip = document.createElement("span");
    chip.className = "chip" + (a.name === curName ? " active" : "");
    chip.textContent = a.name;
    chip.title = `load ${a.name}`;
    chip.addEventListener("click", () => {
      location.search = `?avatar=${encodeURIComponent(a.url)}`;
    });
    el.appendChild(chip);
  }
  window.addEventListener("keydown", (e) => {
    if (e.key !== "[" && e.key !== "]") return;
    const i = list.findIndex((a) => a.name === curName);
    const n = list.length;
    const next = e.key === "]" ? (i + 1 + n) % n : (i - 1 + n) % n;
    location.search = `?avatar=${encodeURIComponent(list[next].url)}`;
  });
}

function makeFpsMeter() {
  let last = performance.now();
  let ema = 16.7;
  return {
    tick() {
      const now = performance.now();
      const dt = now - last;
      last = now;
      if (dt > 0 && dt < 500) ema += (dt - ema) * 0.1;
    },
    value: () => 1000 / ema,
    frameMs: () => ema,
  };
}

main().catch((err) => {
  console.error("GS spike failed to boot:", err);
  if (boot) boot.textContent = "failed to load — check console";
  hud.textContent = "ERROR — see console";
});
