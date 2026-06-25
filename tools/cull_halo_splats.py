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

    if a.mode == 'faint':
        mask = op < a.op
    elif a.mode == 'white':
        mask = (lum > a.lum) & (sat < a.sat)
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
