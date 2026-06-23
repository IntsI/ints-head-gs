import { GaussianSplatRenderer } from "gaussian-splat-renderer-for-lam";
import { createCursorPose } from "./pose";
import {
  REQUIRED_FILES, inspectAvatarZip, repackZip, registerAvatarSW, cacheUpload,
  resolveAvatarPath,
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

  // Speech is OFF: return a neutral frame (no blendshapes). The head sits quiet;
  // cursor-follow head pose still updates. Re-enable by looping an ARKit clip here.
  function getExpressionData(): Record<string, number> {
    const now = performance.now() / 1000;
    const dt = Math.min(now - lastPoll, 0.05);
    lastPoll = now;
    pose?.update(dt);
    fps.tick();
    return {};
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

  (window as unknown as { __gs: unknown }).__gs = { renderer, pose };

  setInterval(() => {
    hud.textContent =
      `ints-head-gs · idle (speech off)\n` +
      `fps ${fps.value().toFixed(0).padStart(3)} · ${fps.frameMs().toFixed(1)}ms` +
      `${pose ? " · move cursor to look" : ""}`;
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
