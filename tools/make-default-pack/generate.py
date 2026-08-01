#!/usr/bin/env python3
"""
Draw the built-in pet.

Original art, generated from primitives, so the repository ships nothing it does
not own (D11). It is a placeholder in quality, not in structure: the atlas has
the real geometry and the real row layout, so replacing it later means dropping
in a different `spritesheet.png` and nothing else.

Layout comes from M0 Spike D — see artifacts/spike-d/FINDINGS.md.

Usage:
    python3 generate.py --out ../../packages/pet-core/src/packs/default
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

from PIL import Image, ImageDraw

FRAME_W, FRAME_H = 192, 208
COLS = 8
ROWS = 9

# Row order is fixed by the format (Spike D · F1). Frame counts are the modal
# vector; the loader measures them per-sheet anyway and does not trust this.
ROW_NAMES = [
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
FRAME_COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6]

BODY_TOP = (0x7C, 0x5C, 0xFF)
BODY_BOTTOM = (0x3D, 0xDC, 0x97)
INK = (0x1A, 0x1A, 0x22)
WHITE = (0xFF, 0xFF, 0xFF)
DEVICE = (0x2A, 0x2A, 0x36)


def lerp(a: tuple[int, int, int], b: tuple[int, int, int], t: float) -> tuple[int, int, int]:
    return tuple(int(x + (y - x) * t) for x, y in zip(a, b))  # type: ignore[return-value]


def body(draw: ImageDraw.ImageDraw, cx: float, cy: float, w: float, h: float) -> None:
    """A rounded blob, drawn as horizontal bands so it carries the gradient."""
    top = cy - h / 2
    steps = int(h)
    for i in range(steps):
        t = i / max(steps - 1, 1)
        y = top + i
        # Ellipse half-width at this height, softened at the base so it sits.
        dy = (y - cy) / (h / 2)
        half = w / 2 * math.sqrt(max(0.0, 1 - dy * dy)) if abs(dy) <= 1 else 0
        half = max(half, w * 0.30 if dy > 0.55 else 0)
        if half <= 0:
            continue
        draw.line([(cx - half, y), (cx + half, y)], fill=lerp(BODY_TOP, BODY_BOTTOM, t))


def eyes(draw: ImageDraw.ImageDraw, cx: float, cy: float, *, blink=False, sad=False, wide=False):
    dx, r = 15, (9 if wide else 7)
    for side in (-1, 1):
        ex = cx + side * dx
        if blink:
            draw.line([(ex - r, cy), (ex + r, cy)], fill=INK, width=3)
            continue
        draw.ellipse([ex - r, cy - r, ex + r, cy + r], fill=WHITE)
        pupil = 4
        py = cy + (2 if sad else 0)
        draw.ellipse([ex - pupil, py - pupil, ex + pupil, py + pupil], fill=INK)
    if sad:
        for side in (-1, 1):
            ex = cx + side * dx
            draw.line([(ex - r - 2, cy - r - 3), (ex + r * side, cy - r + 3)], fill=INK, width=3)


def mouth(draw: ImageDraw.ImageDraw, cx: float, cy: float, *, curve: float = 1.0) -> None:
    w = 16
    if abs(curve) < 0.15:
        draw.line([(cx - w / 2, cy), (cx + w / 2, cy)], fill=INK, width=3)
        return
    box = [cx - w / 2, cy - 8 * curve, cx + w / 2, cy + 8 * curve]
    if curve > 0:
        draw.arc(box, 0, 180, fill=INK, width=3)
    else:
        draw.arc([box[0], box[3], box[2], box[1]], 180, 360, fill=INK, width=3)


def feet(draw: ImageDraw.ImageDraw, cx: float, base: float, offset: float) -> None:
    for side, o in ((-1, offset), (1, -offset)):
        fx = cx + side * 22
        draw.ellipse([fx - 13, base + o - 7, fx + 13, base + o + 7], fill=lerp(BODY_TOP, BODY_BOTTOM, 1.0))


def arm(draw: ImageDraw.ImageDraw, x: float, y: float, angle: float, length: float = 34) -> None:
    ex = x + math.cos(angle) * length
    ey = y - math.sin(angle) * length
    draw.line([(x, y), (ex, ey)], fill=lerp(BODY_TOP, BODY_BOTTOM, 0.5), width=11)
    draw.ellipse([ex - 8, ey - 8, ex + 8, ey + 8], fill=lerp(BODY_TOP, BODY_BOTTOM, 0.7))


def draw_frame(row: str, i: int, n: int) -> Image.Image:
    im = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, base = FRAME_W / 2, FRAME_H - 34
    phase = i / max(n - 1, 1)
    wave = math.sin(phase * math.tau)

    w, h = 118, 122

    if row == "idle":
        cy = base - h / 2 + wave * 3
        body(d, cx, cy, w, h)
        feet(d, cx, base, 0)
        eyes(d, cx, cy - 10, blink=(i == n - 2))
        mouth(d, cx, cy + 22, curve=0.5)

    elif row == "running-left":
        # Spike D · F3: rows 1 and 2 are a mirror pair on real sheets, so ours
        # is an actual flip rather than a second hand-drawn cycle.
        return draw_frame("running-right", i, n).transpose(Image.FLIP_LEFT_RIGHT)

    elif row == "running-right":
        lean = 10
        cy = base - h / 2 - abs(wave) * 6
        body(d, cx + lean, cy, w * 0.96, h)
        feet(d, cx + lean, base, wave * 12)
        arm(d, cx + lean + 34, cy + 6, -0.5 - wave * 0.7)
        eyes(d, cx + lean + 6, cy - 12)
        mouth(d, cx + lean + 6, cy + 20, curve=0.2)

    elif row == "waving":
        cy = base - h / 2
        body(d, cx, cy, w, h)
        feet(d, cx, base, 0)
        eyes(d, cx, cy - 10, wide=True)
        mouth(d, cx, cy + 22, curve=0.9)
        # The wave has to read at thumbnail size, so the arm is long and swings
        # wide. This row is `waiting_approval` — the one state where the pet is
        # asking for something, and the one that must never be missed.
        arm(d, cx + 46, cy - 6, 0.75 + math.sin(phase * math.pi) * 0.75, 56)

    elif row == "jumping":
        arc = math.sin(phase * math.pi)
        squash = 1 - 0.22 * (1 - arc) if phase in (0.0, 1.0) else 1
        cy = base - h / 2 - arc * 46
        body(d, cx, cy, w / squash, h * squash)
        feet(d, cx, base - arc * 46, -arc * 8)
        eyes(d, cx, cy - 12, wide=True)
        mouth(d, cx, cy + 20, curve=1.0)

    elif row == "failed":
        droop = min(1.0, i / max(n - 2, 1))
        cy = base - h / 2 + droop * 12
        body(d, cx, cy, w * (1 + droop * 0.12), h * (1 - droop * 0.16))
        feet(d, cx, base, 0)
        eyes(d, cx, cy - 6, sad=True)
        mouth(d, cx, cy + 24, curve=-0.8)
        if droop > 0.35:  # a tear, so the row reads at a glance
            ty = cy + 2 + (droop - 0.35) * 26
            d.ellipse([cx + 18, ty, cx + 27, ty + 13], fill=(0x7F, 0xC8, 0xFF))

    elif row == "waiting":
        cy = base - h / 2 + wave * 1.5
        body(d, cx, cy, w, h)
        feet(d, cx, base, 0)
        eyes(d, cx + wave * 3, cy - 10)
        mouth(d, cx, cy + 22, curve=0.05)

    elif row == "running":
        # Spike D · F5: authors who interpreted this row drew working-at-a-
        # laptop, so ours does too, and stateMap points `typing` here.
        cy = base - h / 2 - 6
        body(d, cx, cy, w, h)
        eyes(d, cx, cy - 14)
        mouth(d, cx, cy + 16, curve=0.15)
        d.polygon([(cx - 52, base + 6), (cx + 52, base + 6), (cx + 40, base - 26), (cx - 40, base - 26)], fill=DEVICE)
        d.rectangle([cx - 42, base - 62, cx + 42, base - 26], fill=DEVICE)
        d.rectangle([cx - 36, base - 57, cx + 36, base - 31], fill=(0x53, 0xE0, 0xB4) if i % 2 else (0x35, 0xA8, 0x86))
        for side, o in ((-1, 1), (1, -1)):
            arm(d, cx + side * 40, cy + 18, side * -0.6 + o * wave * 0.2, 26)

    elif row == "review":
        cy = base - h / 2
        body(d, cx, cy, w, h)
        feet(d, cx, base, 0)
        eyes(d, cx - 4, cy - 10)
        mouth(d, cx - 4, cy + 22, curve=0.1)
        gx, gy = cx + 44 + wave * 5, cy - 18 + wave * 4
        arm(d, cx + 34, cy + 8, 0.5, 26)
        d.ellipse([gx - 20, gy - 20, gx + 20, gy + 20], outline=DEVICE, width=7)
        d.ellipse([gx - 14, gy - 14, gx + 14, gy + 14], fill=(0xCF, 0xF3, 0xFF, 0x66))
        d.line([(gx - 15, gy + 15), (gx - 30, gy + 30)], fill=DEVICE, width=8)

    return im


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True, type=Path)
    args = ap.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)

    sheet = Image.new("RGBA", (FRAME_W * COLS, FRAME_H * ROWS), (0, 0, 0, 0))
    for r, (name, count) in enumerate(zip(ROW_NAMES, FRAME_COUNTS)):
        for c in range(count):
            sheet.alpha_composite(draw_frame(name, c, count), (c * FRAME_W, r * FRAME_H))

    sheet_path = args.out / "spritesheet.png"
    sheet.save(sheet_path)

    (args.out / "pet.json").write_text(
        json.dumps(
            {
                "id": "default",
                "displayName": "Pebble",
                "description": "The built-in pet. Original placeholder art, generated by tools/make-default-pack.",
                "spritesheetPath": "spritesheet.png",
            },
            indent=2,
        )
        + "\n"
    )

    print(f"{sheet_path}  {sheet.width}x{sheet.height}  rows={ROWS} frames={FRAME_COUNTS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
