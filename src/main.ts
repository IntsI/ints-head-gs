import { GaussianSplatRenderer } from "gaussian-splat-renderer-for-lam";
import { createDriver, RECIPES } from "./driver";
import { createCursorPose } from "./pose";

/**
 * Boot.
 *   GATE 2: semantic driver feeds the renderer's pull-model getExpressionData.
 *   GATE 3: keyboard triggers (same mapping as ints-head) + LIVE cursor-follow
 *           head rotation via the skeleton's head/neck bones.
 *
 * Drive it from the console:  __gs.setExpression("smug")  ·  __gs.keys
 */

// keyboard → expression — IDENTICAL mapping to ints-head/src/main.ts.
const KEY_MAP: Record<string, string> = {
  Digit0: "neutral", KeyN: "neutral",
  Digit1: "smile", Digit2: "suspicious", Digit3: "smug", Digit4: "shock",
  Digit5: "unimpressed", Digit6: "angry", Digit7: "sad", Digit8: "wink",
  Digit9: "tongue", KeyB: "beam", KeyC: "crazy", KeyD: "disgust", KeyK: "kiss",
};

const ASSET = "./asset/arkit/p2-1.zip";

const gsDiv = document.getElementById("gs")!;
const hud = document.getElementById("hud")!;
const boot = document.getElementById("boot");

const driver = createDriver();
const fps = makeFpsMeter();
let lastPoll = performance.now() / 1000;
let pose: ReturnType<typeof createCursorPose> = null;

async function main() {
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

  const renderer = await GaussianSplatRenderer.getInstance(gsDiv, ASSET, {
    getExpressionData,
    getChatState: () => "Idle",
    backgroundColor: "0x000000",
    alpha: 0,
  });

  boot?.classList.add("hidden");

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
