/**
 * Committed, idempotent patch for gaussian-splat-renderer-for-lam.
 *
 * WHY: every published version of the renderer hardcodes `useFlame="false"` in a
 * module-internal `charactorConfig` and NEVER merges the caller's getInstance
 * options — so the FLAME path (teeth) is unreachable via the public API. The
 * FLAME spike/compare pages need it, so we inject a one-liner that honors a
 * `window.__FORCE_FLAME` flag (the OAC head never sets it → unaffected).
 *
 * node_modules is untracked, so a hand-patch dies on `npm install`. This script
 * re-applies it automatically: it's wired as `postinstall` in package.json, and
 * can be run any time with `npm run patch-renderer` (or `node tools/patch-renderer.mjs`).
 * Idempotent — safe to run repeatedly. Productionizing still needs a forked
 * renderer; this is spike scaffolding (see tools/TEETH_AND_SPEECH.md).
 */
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";

const BUILD = "node_modules/gaussian-splat-renderer-for-lam/build/gaussian-splat-renderer-for-lam.module.js";
const VITE_DEPS = "node_modules/.vite/deps/gaussian-splat-renderer-for-lam.js";

// the exact line the renderer uses to (not) enable FLAME — present in all versions
const ANCHOR = "renderer.useFlame = (charactorConfig.useFlame == \"false\") ? false : true;";
// some builds drop the parens; match loosely on the assignment+ternary tail
const ANCHOR_RE = /renderer\.useFlame = \(?charactorConfig\.useFlame == "false"\)? \? false : true;/;
const INJECT = '\n                if (typeof window !== "undefined" && window.__FORCE_FLAME) { renderer.useFlame = true; } /* SPIKE patch: tools/patch-renderer.mjs */';
const MARKER = "__FORCE_FLAME";

function patchFile(path) {
  if (!existsSync(path)) return `skip (not found): ${path}`;
  let src = readFileSync(path, "utf8");
  if (src.includes(MARKER)) return `already patched: ${path}`;
  const m = src.match(ANCHOR_RE);
  if (!m) return `ANCHOR NOT FOUND in ${path} — renderer changed; patch by hand (add after the useFlame assignment): ${INJECT.trim()}`;
  src = src.replace(m[0], m[0] + INJECT);
  writeFileSync(path, src);
  return `patched: ${path}`;
}

const results = [patchFile(BUILD)];

// the Vite optimized-dep cache is built from the source above; if it exists and
// is unpatched, drop it so Vite re-optimizes from the patched source on next run.
if (existsSync(VITE_DEPS)) {
  const cached = readFileSync(VITE_DEPS, "utf8");
  if (!cached.includes(MARKER)) {
    try { rmSync("node_modules/.vite", { recursive: true, force: true }); results.push("cleared node_modules/.vite (Vite will re-optimize patched)"); }
    catch (e) { results.push("could not clear .vite cache: " + e.message + " — run `vite --force` once"); }
  } else {
    results.push("vite dep cache already patched");
  }
}

console.log("[patch-renderer] " + results.join("\n[patch-renderer] "));
if (results[0].startsWith("ANCHOR NOT FOUND")) process.exitCode = 0; // warn, don't fail install
