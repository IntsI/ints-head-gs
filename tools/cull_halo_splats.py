#!/usr/bin/env python3
"""
Bake-side halo experiment: zero the opacity of suspected white-glow splats in a
LAM avatar's offset.ply (the file the renderer actually draws — confirmed via
getInstance -> addSplatScene(offset.ply), SH degree 0).

We ZERO opacity (logit -30 -> sigmoid ~0) rather than DELETE rows, so the splat
count stays aligned with skin.glb / vertex_order.json / lbs_weight (FLAME rig).

Usage:
  python3 tools/cull_halo_splats.py <in.zip> <out.zip> [--mode MODE] [args]

Modes (selection of splats to zero):
  faintwhite   lum>LUM, sat<SAT, opacity<OP            (default; the glow suspects)
  faint        opacity<OP                              (diagnostic: any faint splat)
  white        lum>LUM, sat<SAT                         (all whitish, any opacity)
  edgewhite    faintwhite AND on outer shell (r>SHELL pct in XY) — kills the glow
               that bleeds past the silhouette while KEEPING interior strand highlights
"""
import sys, zipfile, io, struct, math, argparse
import numpy as np

C0 = 0.2820948  # SH degree-0 -> rgb = 0.5 + C0*f_dc

def parse_ply(buf):
    he = buf.index(b'end_header\n') + len(b'end_header\n')
    header = buf[:he].decode('ascii', 'replace')
    n = int([l for l in header.splitlines() if l.startswith('element vertex')][0].split()[-1])
    props = [l.split()[-1] for l in header.splitlines() if l.startswith('property float')]
    stride = len(props)
    arr = np.frombuffer(buf[he:he + n * stride * 4], dtype='<f4').reshape(n, stride).copy()
    return buf[:he], arr, props, he

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('inp'); ap.add_argument('out')
    ap.add_argument('--mode', default='faintwhite')
    ap.add_argument('--lum', type=float, default=0.6)
    ap.add_argument('--sat', type=float, default=0.18)
    ap.add_argument('--op', type=float, default=0.3)
    ap.add_argument('--shell', type=float, default=80.0, help='radius percentile for outer shell')
    ap.add_argument('--cap', type=float, default=0.0035, help='shrinkshell: max world scale per axis')
    ap.add_argument('--tint', type=float, nargs=3, default=[0.69, 0.59, 0.55], help='tintshell: target hair rgb')
    ap.add_argument('--strength', type=float, default=0.85, help='tintshell: blend toward tint (0..1)')
    # face-protect box (front-centre skin region kept untinted). nansija defaults; eyes ~y0.022 z0.023
    ap.add_argument('--facez', type=float, default=0.0,   help='tint: protect splats with z > facez (front)')
    ap.add_argument('--facey', type=float, default=0.03,  help='tint: protect splats with y < facey (below hairline)')
    ap.add_argument('--facex', type=float, default=0.075, help='tint: protect |x-cx| < facex (face width)')
    a = ap.parse_args()

    zin = zipfile.ZipFile(a.inp)
    names = zin.namelist()
    ply_name = [x for x in names if x.endswith('offset.ply')][0]
    raw = zin.read(ply_name)
    header, arr, props, he = parse_ply(raw)

    idx = {p: i for i, p in enumerate(props)}
    op = 1 / (1 + np.exp(-arr[:, idx['opacity']]))
    rgb = np.clip(0.5 + C0 * arr[:, [idx['f_dc_0'], idx['f_dc_1'], idx['f_dc_2']]], 0, 1)
    lum = rgb.mean(1)
    sat = rgb.max(1) - rgb.min(1)

    # radius in XY from centroid (silhouette = high radius)
    xy = arr[:, [idx['x'], idx['y']]]
    c = np.median(xy, axis=0)
    r = np.sqrt(((xy - c) ** 2).sum(1))
    shell = r > np.percentile(r, a.shell)

    if a.mode == 'faint':
        mask = op < a.op
    elif a.mode == 'white':
        mask = (lum > a.lum) & (sat < a.sat)
    elif a.mode == 'shell':                 # decisive: the whole outer boundary, any colour/alpha
        mask = shell
    elif a.mode == 'edgewhite':             # faint-white only on the boundary (keep interior)
        mask = (lum > a.lum) & (sat < a.sat) & (op < a.op) & shell
    elif a.mode == 'shrinkshell':
        # THE FIX: don't delete boundary splats — SHRINK them. Clamp each scale axis of the
        # outer-shell splats so exp(scale) <= cap, so they stop spreading past the silhouette
        # (kills the soft glow) while still rendering the hair edge. Keeps the head intact.
        sidx = [idx['scale_0'], idx['scale_1'], idx['scale_2']]
        capln = math.log(a.cap)
        sub = arr[np.ix_(shell, sidx)]
        before = float(np.exp(sub).max())
        sub = np.minimum(sub, capln)
        arr[np.ix_(shell, sidx)] = sub
        print(f"shrank {int(shell.sum())} shell splats ({100*shell.mean():.1f}%): "
              f"max axis {before:.4f} -> cap {a.cap}")
        new_ply = header + arr.tobytes()
        with zipfile.ZipFile(a.out, 'w', zipfile.ZIP_DEFLATED) as zout:
            for nm in names:
                zout.writestr(nm, new_ply if nm == ply_name else zin.read(nm))
        print(f"wrote {a.out}")
        return
    elif a.mode in ('tintshell', 'tintwhite'):
        # THE REAL FIX: a big part of the hair (the crown) is reconstructed WHITE/grey
        # (single-image artifact), not a glow. Recolour the desaturated bright splats toward
        # the warm blonde hair tone. Pure colour edit — geometry/opacity untouched. Because
        # the blonde target ≈ skin tone, any skin caught by the filter stays fine.
        #   tintwhite = white anywhere (the whole crown);  tintshell = white on the outer shell only.
        target = (lum > a.lum) & (sat < a.sat)
        if a.mode == 'tintshell':
            target &= shell
        # Protect the FACE: skin is also bright + desaturated, so exclude the front-centre
        # box (z>facez front, below the hairline y<facey, within face width |x|<facex). Hair
        # lives on the top/back/sides -> still tinted; the face keeps its exact colour.
        cxm = float(np.median(arr[:, idx['x']]))
        face = (arr[:, idx['z']] > a.facez) & (arr[:, idx['y']] < a.facey) & (np.abs(arr[:, idx['x']] - cxm) < a.facex)
        target &= ~face
        print(f"face-protected (excluded {int(face.sum())} front-face splats)")
        hair = np.array(a.tint, dtype=np.float32)
        fidx = [idx['f_dc_0'], idx['f_dc_1'], idx['f_dc_2']]
        cur = rgb[target]
        new = cur * (1 - a.strength) + hair[None, :] * a.strength
        rows = np.where(target)[0]
        arr[np.ix_(rows, fidx)] = (new - 0.5) / C0   # rgb -> f_dc (SH deg 0)
        print(f"tinted {len(rows)} white-edge splats ({100*target.mean():.1f}%) "
              f"toward {a.tint} @ strength {a.strength}")
        new_ply = header + arr.tobytes()
        with zipfile.ZipFile(a.out, 'w', zipfile.ZIP_DEFLATED) as zout:
            for nm in names:
                zout.writestr(nm, new_ply if nm == ply_name else zin.read(nm))
        print(f"wrote {a.out}")
        return
    else:  # faintwhite
        mask = (lum > a.lum) & (sat < a.sat) & (op < a.op)

    print(f"splats: {len(arr)}  zeroing: {int(mask.sum())} ({100*mask.mean():.1f}%)  mode={a.mode}")
    arr[mask, idx['opacity']] = -30.0  # sigmoid(-30) ~ 0 -> invisible, index preserved

    new_ply = header + arr.tobytes()

    with zipfile.ZipFile(a.out, 'w', zipfile.ZIP_DEFLATED) as zout:
        for nm in names:
            zout.writestr(nm, new_ply if nm == ply_name else zin.read(nm))
    print(f"wrote {a.out}")

if __name__ == '__main__':
    main()
