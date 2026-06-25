/**
 * Committed, idempotent patches for gaussian-splat-renderer-for-lam.
 *
 * node_modules is untracked, so hand-patches die on `npm install`. This script
 * re-applies them (wired as `postinstall` in package.json; run any time with
 * `npm run patch-renderer`). Idempotent — safe to run repeatedly. Spike
 * scaffolding (see tools/TEETH_AND_SPEECH.md); productionizing needs a fork.
 *
 * Patch 1 — __FORCE_FLAME: every published version hardcodes useFlame="false" and
 *   never merges caller options, so the FLAME (teeth) path is unreachable. Inject a
 *   window.__FORCE_FLAME honoring line (the OAC head never sets it → unaffected).
 *
 * Patch 2 — splat halo control: the hair silhouette glows (low-opacity edge
 *   gaussians fringing over the dark bg). The default shader branch is NON-
 *   antialiased — it does NO alpha attenuation/discard, so big spread-out edge
 *   splats keep their faint alpha and glow. We force the ANTIALIASED branch on (it
 *   attenuates LARGE splats' alpha by detOrig/detBlur — surgical for the halo) and
 *   turn its minAlpha cutoff + kernel2DSize dilation into UNIFORMS (uMinAlpha,
 *   uKernel2D) so they can be dialed LIVE (flame-spike drives them from
 *   window.__SPLAT_MINALPHA / window.__SPLAT_KERNEL). Defaults: minAlpha 0.04,
 *   kernel 0.3.
 *
 *   The halo turned out to be the GIANT edge splats, which the antialiased
 *   attenuation barely touches (for a big splat detOrig/detBlur ≈ 1). The lever is
 *   SIZE — but a hard DISCARD of big splats gutted the whole head (lots of body
 *   splats are big too → holes/spikes). Instead we CLAMP: the stock shader already
 *   caps splat screen-size via min(extent, maxScreenSpaceSplatSize); we point that
 *   cap at the uMaxSize uniform. Lowering uMaxSize SHRINKS the over-spread hair-edge
 *   splats so their glow tightens to the silhouette, while coverage is preserved
 *   (overlapping neighbours fill in — no holes). Default uMaxSize 1024 (= the stock
 *   cap, so no-op until dialed down via window.__SPLAT_MAXSIZE).
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";

const BUILD = "node_modules/gaussian-splat-renderer-for-lam/build/gaussian-splat-renderer-for-lam.module.js";
const VITE_DEPS = "node_modules/.vite/deps/gaussian-splat-renderer-for-lam.js";

// Each patch: { marker (skip if present), apply(src) -> src|null (null = anchor missing) }
const PATCHES = [
  {
    name: "__FORCE_FLAME",
    marker: "__FORCE_FLAME",
    apply(src) {
      const re = /renderer\.useFlame = \(?charactorConfig\.useFlame == "false"\)? \? false : true;/;
      const m = src.match(re);
      if (!m) return null;
      return src.replace(m[0], m[0] + '\n                if (typeof window !== "undefined" && window.__FORCE_FLAME) { renderer.useFlame = true; } /* SPIKE patch */');
    },
  },
  {
    name: "splat-halo: force antialiased branch (attenuate large edge splats)",
    marker: "__SPLAT_AA__",
    apply(src) {
      if (!src.includes("if (antialiased) {")) return null;
      return src.replace("if (antialiased) {", "if (true) { /*__SPLAT_AA__*/");
    },
  },
  {
    name: "splat-halo: kernel2DSize → uKernel2D uniform",
    marker: "uKernel2D",
    apply(src) {
      if (!src.includes("${kernel2DSize}")) return null;
      return src.split("${kernel2DSize}").join("uKernel2D");
    },
  },
  {
    name: "splat-halo: minAlpha cutoff → uMinAlpha uniform",
    marker: "vColor.a < uMinAlpha",
    apply(src) {
      if (!src.includes("if (vColor.a < minAlpha) return;")) return null;
      return src.replace("if (vColor.a < minAlpha) return;", "if (vColor.a < uMinAlpha) return;");
    },
  },
  {
    name: "splat-halo: declare uMinAlpha/uKernel2D in the shader",
    marker: "uniform float uMinAlpha;",
    apply(src) {
      if (!src.includes("uniform int bsCount;")) return null;
      return src.replace("uniform int bsCount;", "uniform int bsCount;\n        uniform float uMinAlpha;\n        uniform float uKernel2D;");
    },
  },
  {
    name: "splat-halo: declare uMaxSize/uTraceCut in the shader",
    marker: "uniform float uMaxSize;",
    apply(src) {
      if (!src.includes("uniform float uKernel2D;")) return null;
      return src.replace("uniform float uKernel2D;", "uniform float uKernel2D;\n        uniform float uMaxSize;");
    },
  },
  {
    name: "splat-halo: declare uTraceCut in the shader",
    marker: "uniform float uTraceCut;",
    apply(src) {
      if (!src.includes("uniform float uMaxSize;")) return null;
      return src.replace("uniform float uMaxSize;", "uniform float uMaxSize;\n        uniform float uTraceCut;");
    },
  },
  {
    name: "splat-halo: trace-gated clamp of giant EDGE splats only (face core untouched)",
    marker: "__SPLAT_MAXSIZE__",
    apply(src) {
      // The stock shader clamps splat screen-size via min(extent, maxScreenSpaceSplatSize).
      // We make it surgical: only the BIG splats (3D covariance trace > uTraceCut — the hair-edge
      // shell, measured ~5x the face core) get clamped to uMaxSize; everything else uses a huge cap
      // (no clamp). So lowering uMaxSize SHRINKS only the over-spread edge splats that form the white
      // glow, while the face core never dots out. trace = M11+M22+M33 of Vrk (rotation/depth-invariant).
      if (!src.includes("min(sqrt8 * sqrt(eigenValue1), ${parseInt(maxScreenSpaceSplatSize)}.0)")) return null;
      const gate =
        "float cov3Trace = cov3D_M11_M12_M13.x + cov3D_M22_M23_M33.x + cov3D_M22_M23_M33.z; /*__SPLAT_TRACEGATE__*/\n" +
        "            float effCap = (cov3Trace > uTraceCut) ? uMaxSize : 100000.0;\n            ";
      return src
        .replace("vec2 basisVector1 = eigenVector1 * splatScale * min(sqrt8 * sqrt(eigenValue1), ${parseInt(maxScreenSpaceSplatSize)}.0)",
                 gate + "vec2 basisVector1 = eigenVector1 * splatScale * min(sqrt8 * sqrt(eigenValue1), effCap) /*__SPLAT_MAXSIZE__*/")
        .replace("min(sqrt8 * sqrt(eigenValue2), ${parseInt(maxScreenSpaceSplatSize)}.0)", "min(sqrt8 * sqrt(eigenValue2), effCap)");
    },
  },
  {
    name: "splat-halo: add uMinAlpha/uKernel2D to the splat material uniforms",
    marker: "'uMinAlpha':",
    apply(src) {
      const re = /('headBoneIndex':\s*\{[^}]*\})(\s*\};)/;
      const m = src.match(re);
      if (!m) return null;
      return src.replace(re, `$1,\n            'uMinAlpha': { 'type': 'f', 'value': 0.04 },\n            'uKernel2D': { 'type': 'f', 'value': 0.3 }$2`);
    },
  },
  {
    name: "splat-halo: add uMaxSize to the splat material uniforms",
    marker: "'uMaxSize':",
    apply(src) {
      const re = /('uKernel2D':\s*\{[^}]*\})(\s*\};)/;
      const m = src.match(re);
      if (!m) return null;
      return src.replace(re, `$1,\n            'uMaxSize': { 'type': 'f', 'value': 1024.0 }$2`);
    },
  },
  {
    name: "splat-halo: add uTraceCut to the splat material uniforms",
    marker: "'uTraceCut':",
    apply(src) {
      const re = /('uMaxSize':\s*\{[^}]*\})(\s*\};)/;
      const m = src.match(re);
      if (!m) return null;
      return src.replace(re, `$1,\n            'uTraceCut': { 'type': 'f', 'value': 0.0001 }$2`);
    },
  },
];

function patchFile(path) {
  if (!existsSync(path)) return { msg: `skip (not found): ${path}`, changed: false };
  let src = readFileSync(path, "utf8");
  const log = [];
  let changed = false;
  for (const p of PATCHES) {
    if (src.includes(p.marker)) { log.push(`  ✓ ${p.name} (already)`); continue; }
    const out = p.apply(src);
    if (out == null) { log.push(`  ⚠ ${p.name} — ANCHOR NOT FOUND (renderer changed?)`); continue; }
    src = out; changed = true; log.push(`  + ${p.name}`);
  }
  if (changed) writeFileSync(path, src);
  return { msg: `${changed ? "patched" : "up to date"}: ${path}\n${log.join("\n")}`, changed };
}

const r = patchFile(BUILD);
const results = [r.msg];

// drop the Vite optimized-dep cache so it re-optimizes from the patched source
if (existsSync(VITE_DEPS)) {
  const cached = readFileSync(VITE_DEPS, "utf8");
  const allMarkers = PATCHES.every((p) => cached.includes(p.marker));
  if (!allMarkers) {
    try { rmSync("node_modules/.vite", { recursive: true, force: true }); results.push("cleared node_modules/.vite (Vite re-optimizes patched)"); }
    catch (e) { results.push("could not clear .vite: " + e.message + " — run `vite --force` once"); }
  } else results.push("vite dep cache already patched");
}

console.log("[patch-renderer]\n" + results.join("\n"));
