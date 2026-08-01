#!/usr/bin/env python3
"""
M0 Spike D, part 2 — turn the row-order hypothesis into a confirmed fact.

Three decisive tests, each falsifiable:

  T1  mirror-pair: are rows 1 and 2 the same animation, horizontally flipped?
      If yes they are running-right / running-left and the hypothesised order
      is anchored at rows 1-2.
  T2  v2-superset: are v2 rows 0-8 the same animations as v1 rows 0-8?
      If yes, v2 is v1 plus two appended rows and one loader handles both.
  T3  jump-row: does the hypothesised `jumping` row (4) carry the largest
      vertical centroid excursion of any row?

Also emits per-row filmstrips so a human can read the animations directly.
"""

from __future__ import annotations

import argparse
import json
import statistics
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw

COLS = 8
FRAME_W, FRAME_H = 192, 208
ALPHA_ON = 8

HYPOTHESIS_V1 = [
    "idle", "running-right", "running-left", "waving", "jumping",
    "failed", "waiting", "running", "review",
]


def load(path: Path):
    im = Image.open(path).convert("RGBA")
    rows = {1872: 9, 2288: 11}[im.height]
    return im, rows


def cell(sheet, r, c):
    return sheet.crop((c * FRAME_W, r * FRAME_H, (c + 1) * FRAME_W, (r + 1) * FRAME_H))


def live_frames(sheet, r):
    out = []
    for c in range(COLS):
        im = cell(sheet, r, c)
        a = im.getchannel("A").histogram()
        if sum(a[ALPHA_ON + 1:]) / (FRAME_W * FRAME_H) > 0.001:
            out.append(im)
    return out


def dist(a: Image.Image, b: Image.Image) -> float:
    """Mean absolute difference over the alpha-composited silhouette, 0..1."""
    d = ImageChops.difference(a, b).convert("L").histogram()
    return sum(i * n for i, n in enumerate(d)) / (255.0 * FRAME_W * FRAME_H)


def row_distance(sheet_a, ra, sheet_b, rb, flip=False) -> float | None:
    fa, fb = live_frames(sheet_a, ra), live_frames(sheet_b, rb)
    if not fa or not fb or len(fa) != len(fb):
        return None
    if flip:
        fb = [f.transpose(Image.FLIP_LEFT_RIGHT) for f in fb]
    return statistics.fmean(dist(x, y) for x, y in zip(fa, fb))


def centroid_span_y(sheet, r) -> float:
    ys = []
    for im in live_frames(sheet, r):
        px = im.getchannel("A").load()
        tot = sy = 0
        for y in range(0, FRAME_H, 2):
            for x in range(0, FRAME_W, 2):
                v = px[x, y]
                if v > ALPHA_ON:
                    tot += v
                    sy += y * v
        if tot:
            ys.append(sy / tot / FRAME_H)
    return (max(ys) - min(ys)) if len(ys) >= 2 else 0.0


def filmstrip(sheet, rows, out: Path, labels):
    scale = 3
    fw, fh = FRAME_W // scale, FRAME_H // scale
    pad, gutter = 108, 4
    canvas = Image.new("RGBA", (pad + COLS * (fw + gutter), rows * (fh + gutter)), (20, 20, 24, 255))
    d = ImageDraw.Draw(canvas)
    for r in range(rows):
        y = r * (fh + gutter)
        name = labels[r] if r < len(labels) else f"v2-extra-{r}"
        d.text((6, y + fh // 2 - 6), f"{r}  {name}", fill=(235, 235, 240, 255))
        for c in range(COLS):
            im = cell(sheet, r, c).resize((fw, fh), Image.NEAREST)
            canvas.alpha_composite(im, (pad + c * (fw + gutter), y))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out, "PNG")
    print(f"  filmstrip -> {out}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()

    sheets = {}
    for p in sorted(args.work.glob("*.webp")):
        try:
            sheets[p.stem] = load(p)
        except KeyError:
            print(f"! {p.stem}: unexpected height, skipped")

    v1 = {k: v for k, v in sheets.items() if v[1] == 9}
    v2 = {k: v for k, v in sheets.items() if v[1] == 11}
    results = {}

    print("=== T1  mirror-pair test: row 1 vs row 2 flipped ===")
    t1 = {}
    for slug, (sh, _) in sheets.items():
        same = row_distance(sh, 1, sh, 2, flip=False)
        flipped = row_distance(sh, 1, sh, 2, flip=True)
        # control: an unrelated pair should be far apart under either transform
        control = row_distance(sh, 1, sh, 5, flip=True)
        verdict = "MIRROR" if (flipped is not None and same is not None
                               and flipped < same * 0.6) else "not-mirror"
        t1[slug] = {"same": same, "flipped": flipped, "control_1v5": control, "verdict": verdict}
        print(f"  {slug:<8} d(1,2)={same:.4f}  d(1,flip 2)={flipped:.4f}  "
              f"d(1,flip 5)={control if control is None else f'{control:.4f}'}  -> {verdict}")
    results["T1_mirror_pair"] = t1

    print("\n=== T2  v2 superset test: v2 rows 0-8 vs v1 rows 0-8 ===")
    t2 = {}
    if v1 and v2:
        # Reference must be a MODAL v1 sheet, not an arbitrary one: some pets
        # (e.g. cactus) pad every row to 8 by repeating frames, which would make
        # any comparison against them meaningless.
        from collections import Counter
        vectors = {s: tuple(len(live_frames(sh, r)) for r in range(9))
                   for s, (sh, _) in v1.items()}
        modal = Counter(vectors.values()).most_common(1)[0][0]
        v1_slug = next(s for s, v in vectors.items() if v == modal)
        v1_sheet = v1[v1_slug][0]
        print(f"  reference = {v1_slug} (modal frame vector {list(modal)}; "
              f"outliers: {[s for s, v in vectors.items() if v != modal]})")
        for slug, (sh, _) in v2.items():
            per_row = {}
            for r in range(9):
                fa, fb = live_frames(sh, r), live_frames(v1_sheet, r)
                per_row[r] = {"v2_frames": len(fa), "v1_frames": len(fb),
                              "match": len(fa) == len(fb)}
            agree = sum(1 for v in per_row.values() if v["match"])
            print(f"  {slug} vs {v1_slug}: {agree}/9 rows share a frame count")
            for r, v in per_row.items():
                flag = "ok " if v["match"] else "DIFF"
                print(f"    row {r} {flag} v2={v['v2_frames']} v1={v['v1_frames']}"
                      f"  ({HYPOTHESIS_V1[r]})")
            t2[slug] = {"reference": v1_slug, "agree": agree, "rows": per_row}
    results["T2_v2_superset"] = t2

    print("\n=== T3  jump-row test: which row has the largest vertical excursion? ===")
    t3 = {}
    for slug, (sh, rows) in sheets.items():
        spans = {r: round(centroid_span_y(sh, r), 4) for r in range(rows)}
        top = max(spans, key=spans.get)
        t3[slug] = {"spans": spans, "argmax": top, "hypothesis_row": 4,
                    "hit": top == 4}
        print(f"  {slug:<8} argmax row={top} (span {spans[top]:.3f})  "
              f"row4 span={spans[4]:.3f}  -> {'HIT' if top == 4 else 'miss'}")
    results["T3_jump_row"] = t3

    print("\n=== filmstrips for visual confirmation ===")
    for slug, (sh, rows) in sheets.items():
        filmstrip(sh, rows, args.out / f"filmstrip-{slug}.png", HYPOTHESIS_V1)

    (args.out / "row-verification.json").write_text(json.dumps(results, indent=2))
    print(f"\nresults -> {args.out / 'row-verification.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
