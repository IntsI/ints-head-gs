import { GaussianSplatRenderer } from "gaussian-splat-renderer-for-lam";
import { createDriver, RECIPES } from "./driver";
import { createCursorPose } from "./pose";
import {
  REQUIRED_FILES, inspectAvatarZip, registerAvatarSW, cacheUpload,
  resolveAvatarPath,
} from "./avatar";

/**
 * Boot.
 *   GATE 2: semantic driver feeds the renderer's pull-model getExpressionData.
 *   GATE 3: keyboard triggers (same mapping as ints-head) + LIVE cursor-follow
 *           head rotation via the skeleton's head/neck bones.
 *   Custom avatar: ?avatar=<url> / DEFAULT_AVATAR, or drop a LAM OAC zip.
 *
 * Drive it from the console:  __gs.setExpression("smug")  ·  __gs.keys
 */

// Re-point this (or use ?avatar=…) to load a different head.
const DEFAULT_AVATAR = "./asset/arkit/p2-1.zip";

// keyboard → expression — IDENTICAL mapping to ints-head/src/main.ts.
const KEY_MAP: Record<string, string> = {
  Digit0: "neutral", KeyN: "neutral",
  Digit1: "smile", Digit2: "suspicious", Digit3: "smug", Digit4: "shock",
  Digit5: "unimpressed", Digit6: "angry", Digit7: "sad", Digit8: "wink",
  Digit9: "tongue", KeyB: "beam", KeyC: "crazy", KeyD: "disgust", KeyK: "kiss",
};

const gsDiv = document.getElementById("gs")!;
const hud = document.getElementById("hud")!;
const boot = document.getElementById("boot");
const upStatus = document.getElementById("upStatus")!;

const driver = createDriver();
const fps = makeFpsMeter();
let lastPoll = performance.now() / 1000;
let pose: ReturnType<typeof createCursorPose> = null;

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
    const buf = await file.arrayBuffer();
    const check = await inspectAvatarZip(buf);
    if (!check.ok || !check.folder) {
      setStatus(
        `✗ ${file.name} is not loadable\n` +
          `  folder: ${check.folder ?? "—"}\n` +
          `  missing: ${check.missing.join(", ") || "—"}\n` +
          `  needs (in folder==zipname): ${REQUIRED_FILES.join(", ")}` +
          (check.notes.length ? `\n  ${check.notes.join("\n  ")}` : ""),
        "err",
      );
      return;
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
  // The renderer polls this every rendered frame. We advance the driver + pose
  // here (dt from wall clock) and hand back the current ARKit coefficients.
  function getExpressionData(): Record<string, number> {
    const now = performance.now() / 1000;
    const dt = Math.min(now - lastPoll, 0.05); // clamp tab-switch spikes
    lastPoll = now;
    driver.update(dt);
    pose?.update(dt);
    fps.tick();
    return driver.getFrame();
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
  // that here with a clear message instead of letting it cascade into
  // createCursorPose as "Cannot read properties of undefined (reading 'viewer')".
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

  // GATE 3 — cursor-follow head rotation (live bone drive).
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

  // GATE 3 — keyboard expression triggers.
  window.addEventListener("keydown", (e) => {
    const name = KEY_MAP[e.code];
    if (name) driver.setExpression(name);
  });

  (window as unknown as { __gs: unknown }).__gs = {
    renderer,
    driver,
    pose,
    setExpression: (k: string) => driver.setExpression(k),
    keys: Object.keys(RECIPES),
  };

  setInterval(() => {
    hud.textContent =
      `ints-head-gs · GATE 3 (driver + cursor-follow)\n` +
      `fps ${fps.value().toFixed(0).padStart(3)} · ${fps.frameMs().toFixed(1)}ms` +
      ` · expr: ${driver.current()}\n` +
      `keys 0-9 N B C D K · move cursor to look` +
      `${pose ? "" : " · (pose OFF)"}`;
  }, 200);
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
