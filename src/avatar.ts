import JSZip from "jszip";

/**
 * Custom-avatar plumbing.
 *
 * Two ways to load a head other than the bundled p2-1.zip:
 *   1. `?avatar=<url>` query param (or DEFAULT_AVATAR in main.ts) — any
 *      same-origin zip whose URL ends in `<name>.zip`. The primary path.
 *   2. Drag-drop / file-input — validated client-side, stashed in a SW-backed
 *      cache under `/__avatar__/<folder>.zip`, then loaded via a reload.
 *
 * Both feed the SAME renderer entrypoint, so the driver / idle / cursor-follow /
 * keyboard all work unchanged on the new head.
 *
 * The format contract (see docs/AVATAR_FORMAT.md): a zip with a single top
 * folder == the zip name, containing skin.glb, offset.ply, animation.glb,
 * vertex_order.json. This is exactly LAM's OpenAvatarChat (OAC) export.
 */

export const REQUIRED_FILES = [
  "skin.glb",
  "offset.ply",
  "animation.glb",
  "vertex_order.json",
] as const;

const CACHE = "avatars";

export interface ZipCheck {
  ok: boolean;
  folder: string | null;
  present: string[];
  missing: string[];
  notes: string[];
}

/**
 * Inspect an avatar zip against the renderer's contract WITHOUT loading it, so
 * we can give a precise pass/fail before handing bytes to the GPU path.
 */
export async function inspectAvatarZip(data: ArrayBuffer): Promise<ZipCheck> {
  const notes: string[] = [];
  const zip = await JSZip.loadAsync(data);

  // top-level folders, ignoring macOS junk
  const tops = new Set<string>();
  zip.forEach((path) => {
    if (path.startsWith("__MACOSX/") || path.includes("/.")) return;
    const seg = path.split("/")[0];
    if (seg) tops.add(seg);
  });
  const folders = [...tops];

  if (folders.length === 0) {
    return { ok: false, folder: null, present: [], missing: [...REQUIRED_FILES],
      notes: ["zip is empty or has no top-level folder"] };
  }
  if (folders.length > 1) {
    notes.push(`multiple top-level entries (${folders.join(", ")}); using "${folders[0]}"`);
  }
  const folder = folders[0];

  const present: string[] = [];
  const missing: string[] = [];
  for (const f of REQUIRED_FILES) {
    if (zip.file(`${folder}/${f}`)) present.push(f);
    else missing.push(f);
  }

  // The renderer discovers the folder from an explicit DIRECTORY ENTRY (a member
  // whose name ends in "/"). A zip written by Python's zipfile has file entries
  // only -> the renderer throws 'file fold is not found'. Catch it here.
  const hasDirEntry = Object.values(zip.files).some(
    (f) => f.dir && !f.name.startsWith("__MACOSX"),
  );
  if (!hasDirEntry) {
    notes.push(
      "no directory entry in zip — renderer would throw 'file fold is not found'. " +
        "Repack with tools/repack_oac.py.",
    );
  }

  return { ok: missing.length === 0 && hasDirEntry, folder, present, missing, notes };
}

/** Register the SW that serves cached uploads. No-op if unsupported. */
export async function registerAvatarSW(): Promise<void> {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js");
    await navigator.serviceWorker.ready;
  } catch (e) {
    console.warn("[avatar] SW registration failed; uploads disabled:", e);
  }
}

/**
 * Stash an uploaded zip in the SW cache under `/__avatar__/<folder>.zip` and
 * return that URL (regex-matchable + fetchable + survives reload).
 */
export async function cacheUpload(data: ArrayBuffer, folder: string): Promise<string> {
  const url = `/__avatar__/${folder}.zip`;
  const cache = await caches.open(CACHE);
  await cache.put(
    url,
    new Response(data, { headers: { "Content-Type": "application/zip" } }),
  );
  return url;
}

/** Resolve which avatar to load this page-load. */
export function resolveAvatarPath(defaultPath: string): string {
  const p = new URLSearchParams(location.search).get("avatar");
  return p && p.trim() ? p : defaultPath;
}
