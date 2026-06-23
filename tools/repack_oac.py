#!/usr/bin/env python3
"""
Repack a LAM OAC export zip into the exact structure
`gaussian-splat-renderer-for-lam` loads.

THE REAL REQUIREMENT (verified against the renderer bundle): the loader finds the
avatar's folder by scanning the zip for a **directory entry** (an entry with
`dir == true`, i.e. a name ending in `/`):

    let fileName = '';
    Object.values(zipData.files).forEach(f => { if (f.dir) fileName = f.name.slice(0,-1); });
    if (!fileName) throw new Error('file fold is not found');   // <-- the failure

It then reads `fileName + '/skin.glb'` etc. Python's `zipfile` writes only FILE
entries (no directory entry), so a zip baked by an older `colab_bake_oac.py`
triggers that throw. The `zip` CLI / patoolib (what LAM's own app_lam.py uses)
DO write the directory entry, which is why a Gradio-exported zip loads.

This script rewrites a zip so it contains:
    <name>/                 <-- explicit directory entry (the fix)
    <name>/skin.glb
    <name>/offset.ply
    <name>/animation.glb
    <name>/vertex_order.json
where <name> defaults to the OUTPUT zip's basename. It locates the four files
wherever they currently live (any folder, or flat), so it also normalizes a
mismatched inner-folder name.

Usage:
    python repack_oac.py in.zip [out.zip]   # out defaults to in.zip (in place)
"""
import os
import sys
import zipfile

REQUIRED = ["skin.glb", "offset.ply", "animation.glb", "vertex_order.json"]


def repack(inp: str, out: str) -> None:
    name = os.path.splitext(os.path.basename(out))[0]  # folder/dir-entry == zip name
    with zipfile.ZipFile(inp) as z:
        entries = [n for n in z.namelist()
                   if not n.startswith("__MACOSX") and "/." not in n and not n.endswith("/")]
        data = {}
        for r in REQUIRED:
            hits = [n for n in entries if n == r or n.endswith("/" + r)]
            if not hits:
                raise SystemExit(f"✗ {inp}: required file missing: {r}\n   has: {entries}")
            data[r] = z.read(hits[0])

    tmp = out + ".tmp"
    with zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as z:
        di = zipfile.ZipInfo(name + "/")                 # the directory entry the loader needs
        di.external_attr = (0o40755 << 16) | 0x10        # unix dir bit + MS-DOS dir flag
        z.writestr(di, b"")
        for r in REQUIRED:
            z.writestr(name + "/" + r, data[r])
    os.replace(tmp, out)
    print(f"✓ repacked -> {out}\n  folder '{name}/' (with directory entry) + {', '.join(REQUIRED)}")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    src = sys.argv[1]
    dst = sys.argv[2] if len(sys.argv) > 2 else src
    repack(src, dst)
