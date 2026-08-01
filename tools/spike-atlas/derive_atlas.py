#!/usr/bin/env python3
"""
M0 Spike D — derive the Petdex/Codex pet atlas layout empirically.

PET_PROJECT_SPEC.md §12.1 states the row names but explicitly forbids hardcoding
row *order* and per-row frame counts from the spec, because neither is documented
anywhere upstream. This script derives both from real sheets and reports whether
the layout is stable across pets.

It never writes third-party art into the repository (D11): sheets are downloaded
to a scratch directory and only the derived numbers are committed.

Usage:
    python3 derive_atlas.py --out ../../artifacts/spike-d --work /tmp/spike-d
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path

from PIL import Image, ImageChops

MANIFEST_URL = "https://petdex.dev/api/manifest"

# Geometry the upstream CLI validates against. Integer scales of either are legal.
FRAME_W, FRAME_H = 192, 208
COLS = 8
GEOMETRIES = {
    (1536, 1872): ("v1", 9),
    (1536, 2288): ("v2", 11),
}

# Row names published in the upstream state viewer. Order here is the JSON key
# order, which is a HYPOTHESIS to be tested, not a fact.
HYPOTHESIS_V1 = [
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
]

ALPHA_ON = 8  # alpha value above which a pixel counts as ink


@dataclass
class RowStats:
    row: int
    frames: int  # non-empty, left-packed
    unique_frames: int  # after collapsing consecutive duplicates
    activity: float  # mean per-frame pixel change, 0..1
    drift_x: float  # signed centroid travel, first -> last, in frame widths
    span_x: float  # centroid horizontal range, in frame widths
    span_y: float  # centroid vertical range, in frame heights
    ink: float  # mean alpha coverage, 0..1


@dataclass
class SheetReport:
    slug: str
    size: tuple[int, int]
    version: str
    rows: int
    scale: float
    frame: tuple[int, int]
    row_stats: list[RowStats]


def fetch(url: str, dest: Path) -> Path:
    if dest.exists() and dest.stat().st_size > 0:
        return dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "agent-pet-spike-d/1.0"})
    with urllib.request.urlopen(req, timeout=60) as r, dest.open("wb") as f:
        f.write(r.read())
    return dest


def classify_geometry(size: tuple[int, int]) -> tuple[str, int, float]:
    """Return (version, rows, scale). Accepts clean integer scales of either grid."""
    w, h = size
    for (bw, bh), (version, rows) in GEOMETRIES.items():
        if w == bw and h == bh:
            return version, rows, 1.0
        if w % bw == 0 and h % bh == 0 and (w // bw) == (h // bh):
            return version, rows, float(w // bw)
    raise ValueError(f"unrecognised grid {w}x{h}")


def cell(sheet: Image.Image, row: int, col: int, fw: int, fh: int) -> Image.Image:
    return sheet.crop((col * fw, row * fh, (col + 1) * fw, (row + 1) * fh))


def ink_coverage(img: Image.Image) -> float:
    a = img.getchannel("A")
    hist = a.histogram()
    on = sum(hist[ALPHA_ON + 1 :])
    return on / float(img.width * img.height)


def centroid(img: Image.Image) -> tuple[float, float] | None:
    """Alpha-weighted centroid, normalised to 0..1 within the frame."""
    a = img.getchannel("A")
    px = a.load()
    tot = sx = sy = 0
    step = 2  # 2px sampling: 4x faster, no measurable effect on the centroid
    for y in range(0, img.height, step):
        for x in range(0, img.width, step):
            v = px[x, y]
            if v > ALPHA_ON:
                tot += v
                sx += x * v
                sy += y * v
    if tot == 0:
        return None
    return (sx / tot / img.width, sy / tot / img.height)


def frame_delta(a: Image.Image, b: Image.Image) -> float:
    """Mean absolute RGBA difference, 0..1."""
    diff = ImageChops.difference(a, b)
    stats = diff.convert("L").histogram()
    total = sum(i * n for i, n in enumerate(stats))
    return total / (255.0 * a.width * a.height)


def analyse_row(sheet, row, fw, fh) -> RowStats:
    cells = [cell(sheet, row, c, fw, fh) for c in range(COLS)]
    inks = [ink_coverage(c) for c in cells]

    # Frames are left-packed; trailing empties are padding.
    last = -1
    for i, v in enumerate(inks):
        if v > 0.001:
            last = i
    frames = last + 1
    live = cells[:frames] if frames > 0 else []

    uniq = 0
    prev = None
    for c in live:
        if prev is None or frame_delta(prev, c) > 0.0005:
            uniq += 1
        prev = c

    cents = [centroid(c) for c in live]
    cents = [c for c in cents if c is not None]
    if len(cents) >= 2:
        xs = [c[0] for c in cents]
        ys = [c[1] for c in cents]
        drift_x = xs[-1] - xs[0]
        span_x = max(xs) - min(xs)
        span_y = max(ys) - min(ys)
    else:
        drift_x = span_x = span_y = 0.0

    deltas = [frame_delta(live[i], live[i + 1]) for i in range(len(live) - 1)]
    activity = statistics.fmean(deltas) if deltas else 0.0

    return RowStats(
        row=row,
        frames=frames,
        unique_frames=uniq,
        activity=round(activity, 5),
        drift_x=round(drift_x, 4),
        span_x=round(span_x, 4),
        span_y=round(span_y, 4),
        ink=round(statistics.fmean(inks[:frames]) if frames else 0.0, 4),
    )


def analyse_sheet(slug: str, path: Path) -> SheetReport:
    sheet = Image.open(path).convert("RGBA")
    version, rows, scale = classify_geometry(sheet.size)
    fw, fh = int(FRAME_W * scale), int(FRAME_H * scale)
    stats = [analyse_row(sheet, r, fw, fh) for r in range(rows)]
    return SheetReport(slug, sheet.size, version, rows, scale, (fw, fh), stats)


def contact_sheet(path: Path, out: Path, label: str) -> None:
    """Downscaled grid with row indices burned in, for human verification."""
    src = Image.open(path).convert("RGBA")
    thumb = src.resize((src.width // 4, src.height // 4), Image.NEAREST)
    canvas = Image.new("RGBA", (thumb.width + 28, thumb.height), (24, 24, 27, 255))
    canvas.alpha_composite(thumb, (28, 0))
    from PIL import ImageDraw

    d = ImageDraw.Draw(canvas)
    rows = classify_geometry(src.size)[1]
    rh = thumb.height / rows
    for r in range(rows):
        y = int(r * rh)
        d.line([(28, y), (canvas.width, y)], fill=(80, 80, 90, 255))
        d.text((6, y + rh / 2 - 6), str(r), fill=(230, 230, 235, 255))
    out.parent.mkdir(parents=True, exist_ok=True)
    canvas.convert("RGB").save(out, "PNG")
    print(f"  contact sheet -> {out}  ({label})")


def infer_identity(s: RowStats, rank_activity: int, n_rows: int) -> str:
    """Heuristic label from motion signature alone. Reported as a hint, not truth."""
    hints = []
    if s.frames == 0:
        return "EMPTY"
    if abs(s.drift_x) > 0.04:
        hints.append("locomotion-right" if s.drift_x > 0 else "locomotion-left")
    if s.span_y > 0.05:
        hints.append("vertical-excursion(jump?)")
    if s.activity < 0.004:
        hints.append("near-static(idle/waiting?)")
    elif rank_activity < 3:
        hints.append("high-motion(run?)")
    if not hints:
        hints.append("moderate-motion")
    return ", ".join(hints)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    ap.add_argument("--work", required=True, type=Path)
    ap.add_argument("--pets", nargs="*", default=["boba", "ghost", "cactus", "slime", "frog"])
    args = ap.parse_args()

    args.work.mkdir(parents=True, exist_ok=True)
    args.out.mkdir(parents=True, exist_ok=True)

    manifest_path = fetch(MANIFEST_URL, args.work / "manifest.json")
    manifest = json.loads(manifest_path.read_text())
    by_slug = {p["slug"]: p for p in manifest["pets"]}
    print(f"manifest: {manifest['total']} pets, generated {manifest.get('generatedAt')}")

    reports: list[SheetReport] = []
    for slug in args.pets:
        pet = by_slug.get(slug)
        if not pet:
            print(f"! {slug}: not in manifest, skipped")
            continue
        url = pet["spritesheetUrl"]
        ext = ".webp" if url.endswith(".webp") else ".png"
        local = fetch(url, args.work / f"{slug}{ext}")
        try:
            rep = analyse_sheet(slug, local)
        except ValueError as e:
            print(f"! {slug}: {e}")
            continue
        reports.append(rep)
        print(f"\n=== {slug} — {rep.size[0]}x{rep.size[1]} {rep.version} "
              f"({rep.rows} rows, frame {rep.frame[0]}x{rep.frame[1]}, scale {rep.scale:g})")
        order = sorted(range(len(rep.row_stats)),
                       key=lambda i: -rep.row_stats[i].activity)
        rank = {r: i for i, r in enumerate(order)}
        print(f"{'row':>3} {'frames':>6} {'uniq':>5} {'activity':>9} {'driftX':>8} "
              f"{'spanX':>7} {'spanY':>7}  signature")
        for s in rep.row_stats:
            print(f"{s.row:>3} {s.frames:>6} {s.unique_frames:>5} {s.activity:>9.5f} "
                  f"{s.drift_x:>8.3f} {s.span_x:>7.3f} {s.span_y:>7.3f}  "
                  f"{infer_identity(s, rank[s.row], rep.rows)}")
        contact_sheet(local, args.out / f"contact-{slug}.png", slug)

    # The question the spike exists to answer: is the layout stable across pets?
    print("\n=== cross-pet stability ===")
    v1 = [r for r in reports if r.version == "v1"]
    if len(v1) >= 2:
        vectors = {r.slug: [s.frames for s in r.row_stats] for r in v1}
        for slug, v in vectors.items():
            print(f"  {slug:<10} frames/row = {v}")
        uniq = {tuple(v) for v in vectors.values()}
        print(f"  -> {'STABLE' if len(uniq) == 1 else 'VARIES'} "
              f"across {len(v1)} v1 sheets ({len(uniq)} distinct vectors)")
    else:
        print("  not enough v1 sheets to compare")

    out_json = args.out / "atlas-findings.json"
    out_json.write_text(json.dumps(
        {"manifestTotal": manifest["total"],
         "hypothesisV1RowOrder": HYPOTHESIS_V1,
         "sheets": [asdict(r) for r in reports]},
        indent=2))
    print(f"\nfindings -> {out_json}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
