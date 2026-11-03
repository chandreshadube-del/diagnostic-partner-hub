#!/usr/bin/env python3
"""Generate the original pixel-art avatar sprite sheet.

The character is drawn here from primitives — a rounded CRT head, an antenna,
block eyes, a bar mouth and a chevron torso. Nothing is traced, sampled or
downloaded, so there is no third-party character art in the project.

Every frame is rendered onto an identical CELL x CELL canvas with the same
baseline and the same fixed palette, so the renderer can swap frames without
the avatar shifting or changing colour.

    python tools/make_avatar.py [--out assets/avatar] [--scale 4]
"""
from __future__ import annotations

import argparse
import json
from dataclasses import dataclass
from pathlib import Path

from PIL import Image, ImageDraw

# Logical pixel grid per frame. Everything is authored at this size and scaled
# up with nearest-neighbour, which is what keeps the pixel edges hard.
CELL = 64
#: Baseline every pose is aligned to: the bottom of the torso.
BASELINE_Y = 60

PALETTE: dict[str, tuple[int, int, int, int]] = {
    "none":    (0, 0, 0, 0),
    "outline": (14, 18, 28, 255),
    "shell":   (226, 232, 240, 255),
    "shade":   (148, 163, 184, 255),
    "screen":  (16, 28, 46, 255),
    "glow":    (56, 232, 200, 255),
    "accent":  (255, 122, 89, 255),
    "torso":   (76, 94, 128, 255),
    "torso_hi":(110, 132, 176, 255),
}

POSES = ("idle", "talk", "point", "think", "nod")
MOUTHS = ("closed", "mid", "open")


@dataclass(frozen=True)
class Pose:
    name: str
    head_dy: int          # vertical head offset, for the nod
    left_arm: str         # down | chin
    right_arm: str        # down | up
    eye: str              # open | squint


POSE_SPECS: dict[str, Pose] = {
    "idle":  Pose("idle",  0, "down", "down", "open"),
    "talk":  Pose("talk",  0, "down", "down", "open"),
    "point": Pose("point", 0, "down", "up",   "open"),
    "think": Pose("think", 0, "chin", "down", "squint"),
    "nod":   Pose("nod",   3, "down", "down", "squint"),
}


def px(d: ImageDraw.ImageDraw, x: int, y: int, w: int, h: int, colour: str) -> None:
    d.rectangle([x, y, x + w - 1, y + h - 1], fill=PALETTE[colour])


def draw_frame(pose: Pose, mouth: str) -> Image.Image:
    img = Image.new("RGBA", (CELL, CELL), PALETTE["none"])
    d = ImageDraw.Draw(img)

    head_x, head_w = 14, 36
    head_y = 10 + pose.head_dy
    head_h = 28

    # torso (always on the baseline), with shoulders the arms attach to
    torso_x, torso_w = 19, 26
    torso_top = BASELINE_Y - 18
    px(d, torso_x, torso_top, torso_w, 18, "outline")
    px(d, torso_x + 1, torso_top + 1, torso_w - 2, 16, "torso")
    px(d, torso_x + 1, torso_top + 1, torso_w - 2, 4, "torso_hi")
    for i in range(5):  # chevron detail
        px(d, torso_x + 7 + i, torso_top + 7 + i, 2, 1, "glow")
        px(d, torso_x + torso_w - 9 - i, torso_top + 7 + i, 2, 1, "glow")

    def shoulder(x: int) -> None:
        px(d, x, torso_top + 1, 4, 5, "outline")
        px(d, x + 1, torso_top + 2, 2, 3, "shade")

    # right arm (viewer's right)
    rx = torso_x + torso_w - 1
    shoulder(rx)
    if pose.right_arm == "up":
        pass  # drawn after the head so the hand is not occluded by it
    else:
        px(d, rx + 2, torso_top + 4, 4, 10, "outline")
        px(d, rx + 3, torso_top + 5, 2, 8, "shell")
        px(d, rx + 2, torso_top + 13, 4, 3, "outline")
        px(d, rx + 3, torso_top + 14, 2, 1, "shade")

    # left arm (viewer's left)
    lx = torso_x - 3
    shoulder(lx)
    if pose.left_arm == "chin":
        px(d, lx - 1, torso_top - 2, 4, 8, "outline")          # upper arm, raised
        px(d, lx, torso_top - 1, 2, 6, "shell")
        px(d, lx - 1, head_y + head_h + 1, 12, 4, "outline")   # forearm to the chin
        px(d, lx, head_y + head_h + 2, 10, 2, "shell")
        px(d, lx + 10, head_y + head_h - 2, 5, 6, "outline")   # hand under the jaw
        px(d, lx + 11, head_y + head_h - 1, 3, 4, "shade")
    else:
        px(d, lx - 2, torso_top + 4, 4, 10, "outline")
        px(d, lx - 1, torso_top + 5, 2, 8, "shell")
        px(d, lx - 2, torso_top + 13, 4, 3, "outline")
        px(d, lx - 1, torso_top + 14, 2, 1, "shade")

    # neck
    px(d, 29, head_y + head_h - 1, 6, 5 - pose.head_dy, "outline")
    px(d, 30, head_y + head_h, 4, 4 - pose.head_dy, "shade")

    # head shell with cut corners (the "rounded" CRT look on a pixel grid)
    px(d, head_x, head_y, head_w, head_h, "outline")
    px(d, head_x, head_y, 2, 2, "none")
    px(d, head_x + head_w - 2, head_y, 2, 2, "none")
    px(d, head_x, head_y + head_h - 2, 2, 2, "none")
    px(d, head_x + head_w - 2, head_y + head_h - 2, 2, 2, "none")
    px(d, head_x + 1, head_y + 1, head_w - 2, head_h - 2, "shell")
    px(d, head_x + 1, head_y + head_h - 4, head_w - 2, 3, "shade")

    # antenna
    px(d, head_x + head_w // 2 - 1, head_y - 5, 2, 5, "outline")
    px(d, head_x + head_w // 2 - 2, head_y - 8, 4, 4, "outline")
    px(d, head_x + head_w // 2 - 1, head_y - 7, 2, 2, "accent")

    # screen
    sx, sy, sw, sh = head_x + 4, head_y + 5, head_w - 8, head_h - 12
    px(d, sx, sy, sw, sh, "outline")
    px(d, sx + 1, sy + 1, sw - 2, sh - 2, "screen")
    # scanlines
    for yy in range(sy + 2, sy + sh - 2, 3):
        px(d, sx + 1, yy, sw - 2, 1, "shade")

    # eyes
    eye_y = sy + 3
    if pose.eye == "open":
        px(d, sx + 4, eye_y, 4, 5, "glow")
        px(d, sx + sw - 8, eye_y, 4, 5, "glow")
    else:
        px(d, sx + 4, eye_y + 2, 4, 2, "glow")
        px(d, sx + sw - 8, eye_y + 2, 4, 2, "glow")

    # mouth: one bar whose height encodes the viseme
    mw = {"closed": 8, "mid": 10, "open": 12}[mouth]
    mh = {"closed": 1, "mid": 3, "open": 5}[mouth]
    mx = sx + (sw - mw) // 2
    my = sy + sh - 3 - mh
    px(d, mx, my, mw, mh, "glow")
    if mouth == "open":
        px(d, mx + 1, my + 1, mw - 2, mh - 2, "accent")

    # the raised arm sits in front of the head, so the hand stays readable
    if pose.right_arm == "up":
        rx = 19 + 26 - 1
        px(d, rx + 2, head_y + 14, 4, torso_top - head_y - 10, "outline")
        px(d, rx + 3, head_y + 15, 2, torso_top - head_y - 12, "shell")
        px(d, rx + 1, head_y + 8, 6, 7, "outline")             # hand
        px(d, rx + 2, head_y + 9, 4, 5, "shell")
        px(d, rx + 3, head_y + 5, 2, 5, "accent")              # pointing finger

    return img


def build_sheet(scale: int) -> tuple[Image.Image, dict]:
    cell = CELL * scale
    sheet = Image.new("RGBA", (cell * len(MOUTHS), cell * len(POSES)), PALETTE["none"])
    frames: dict[str, dict[str, list[int]]] = {}
    for row, pose_name in enumerate(POSES):
        frames[pose_name] = {}
        for col, mouth in enumerate(MOUTHS):
            frame = draw_frame(POSE_SPECS[pose_name], mouth)
            frame = frame.resize((cell, cell), Image.NEAREST)
            sheet.paste(frame, (col * cell, row * cell))
            frames[pose_name][mouth] = [col * cell, row * cell, cell, cell]
    meta = {
        "cell": cell,
        "logical_cell": CELL,
        "scale": scale,
        "baseline_y": BASELINE_Y * scale,
        "poses": list(POSES),
        "mouths": list(MOUTHS),
        "frames": frames,
        "palette": {k: list(v) for k, v in PALETTE.items()},
        "generator": "tools/make_avatar.py",
        "note": "Original art generated from primitives; no third-party character assets.",
    }
    return sheet, meta


def verify(sheet: Image.Image, meta: dict) -> list[str]:
    """Normalisation checks: identical cell size, aligned baseline, fixed palette."""
    problems: list[str] = []
    cell = meta["cell"]
    allowed = {tuple(v) for v in meta["palette"].values()}
    for pose, by_mouth in meta["frames"].items():
        for mouth, (x, y, w, h) in by_mouth.items():
            if (w, h) != (cell, cell):
                problems.append(f"{pose}/{mouth}: cell {w}x{h} != {cell}x{cell}")
            crop = sheet.crop((x, y, x + w, y + h))
            bbox = crop.getbbox()
            if bbox is None:
                problems.append(f"{pose}/{mouth}: empty frame")
                continue
            if bbox[3] > meta["baseline_y"] + meta["scale"] * 2:
                problems.append(f"{pose}/{mouth}: content below baseline ({bbox[3]})")
            for colour in crop.getcolors(maxcolors=1 << 16) or []:
                if tuple(colour[1]) not in allowed:
                    problems.append(f"{pose}/{mouth}: off-palette colour {colour[1]}")
                    break
    return problems


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[1] / "assets" / "avatar"))
    ap.add_argument("--scale", type=int, default=4)
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    sheet, meta = build_sheet(args.scale)
    problems = verify(sheet, meta)

    sheet.save(out / "avatar.png")
    (out / "avatar.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
    for pose in POSES:  # individual frames, handy for inspection
        for mouth in MOUTHS:
            x, y, w, h = meta["frames"][pose][mouth]
            sheet.crop((x, y, x + w, y + h)).save(out / f"{pose}-{mouth}.png")

    print(f"wrote {out/'avatar.png'} ({sheet.width}x{sheet.height}), {len(POSES)*len(MOUTHS)} frames")
    if problems:
        print("NORMALISATION PROBLEMS:")
        for p in problems:
            print("  -", p)
        return 1
    print("normalisation checks passed: uniform cells, aligned baseline, fixed palette")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
