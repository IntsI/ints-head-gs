/**
 * GATE 3 — LIVE cursor-follow head rotation.
 *
 * Confirmed viable: the GS avatar is skinned to a 262-bone skeleton; rotating
 * the `head` (and `neckUpper`) bones deforms the splats in real time. The
 * renderer drives blendshapes (morph targets), NOT these bones, in Idle — so the
 * bones are ours to write each frame. We distribute the turn across neck + head
 * so it reads as a look, not a decapitated swivel.
 */

interface Bone {
  name: string;
  isBone?: boolean;
  type?: string;
  rotation: { x: number; y: number; z: number; clone: () => { x: number; y: number; z: number } };
}

export interface PoseHandle {
  /** Pointer in normalized device coords: x left→right −1..1, y top→bottom −1..1. */
  setTarget: (nx: number, ny: number) => void;
  update: (dt: number) => void;
  found: { head: boolean; neck: boolean };
}

const MAX_YAW = 0.5; // rad, total head+neck
const MAX_PITCH = 0.3;
const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));

export function createCursorPose(renderer: unknown): PoseHandle | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const v: any = (renderer as any).viewer;
  const scene = v?.scene || v?.threeScene || v?.splatMesh?.parent;
  if (!scene?.traverse) return null;

  let head: Bone | null = null;
  let neck: Bone | null = null;
  scene.traverse((n: Bone) => {
    if (!(n.isBone || n.type === "Bone")) return;
    if (n.name === "head") head = n;
    else if (n.name === "neckUpper") neck = n;
  });
  if (!head) return null;

  const headBase = (head as Bone).rotation.clone();
  const neckBase = neck ? (neck as Bone).rotation.clone() : null;

  let tx = 0, ty = 0; // target (normalized, eased input)
  let cx = 0, cy = 0; // current eased
  let t = 0;          // clock for idle breath/sway

  return {
    found: { head: !!head, neck: !!neck },
    setTarget(nx, ny) { tx = clamp(nx, -1, 1); ty = clamp(ny, -1, 1); },
    update(dt) {
      t += dt;
      const k = 1 - Math.exp(-dt / 0.12); // smooth, slightly laggy = lifelike
      cx += (tx - cx) * k;
      cy += (ty - cy) * k;

      // pointer-right → face turns toward viewer-right; pointer-up → chin lifts.
      // (signs verified against the sample's bone orientation.)
      const yaw = -cx * MAX_YAW;
      const pitch = -cy * MAX_PITCH;

      // Always-on idle breath/sway so the head never freezes (the thing that
      // made the static pose read as dead). Tiny, non-harmonic frequencies.
      const swayY = Math.sin(t * 0.23) * 0.015;
      const swayX = Math.sin(t * 0.6 + 1.3) * 0.01;
      const tiltZ = Math.sin(t * 0.17) * 0.012;

      const h = head as Bone;
      h.rotation.y = headBase.y + yaw * 0.65 + swayY;
      h.rotation.x = headBase.x + pitch * 0.65 + swayX;
      h.rotation.z = headBase.z + tiltZ;
      if (neck && neckBase) {
        neck.rotation.y = neckBase.y + yaw * 0.35 + swayY * 0.5;
        neck.rotation.x = neckBase.x + pitch * 0.35;
      }
    },
  };
}
