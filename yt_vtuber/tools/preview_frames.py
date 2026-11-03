#!/usr/bin/env python3
"""Screenshot a few moments of an episode's stage, for eyeballing a design change.

Re-uses the staged render directory an episode already produced, so it costs
seconds rather than a full re-render.

    python tools/preview_frames.py episodes/2026-11-03-xxxxxxxx [-t 4 16 28] [-o out.png]
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vtuber import render  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("episode_dir")
    ap.add_argument("-t", "--times", type=float, nargs="+", default=[4, 16, 28, 40, 48])
    ap.add_argument("-o", "--out", default="preview.png")
    ap.add_argument("--scale", type=float, default=0.32)
    args = ap.parse_args()

    ep_dir = Path(args.episode_dir)
    render_dir = ep_dir / "render"
    if not (render_dir / "index.html").is_file():
        print(f"no staged render in {render_dir}", file=sys.stderr)
        return 1
    # Pick up template edits made since the episode was rendered.
    tl = json.loads((render_dir / "timeline.json").read_text())
    render.stage(ROOT / "templates", ROOT / "assets" / "avatar", tl, render_dir)

    from PIL import Image
    from playwright.sync_api import sync_playwright

    shots: list[bytes] = []
    launch = {"args": ["--no-sandbox", "--disable-gpu", "--hide-scrollbars",
                       "--force-color-profile=srgb"]}
    if exe := os.environ.get("VTUBER_CHROMIUM"):
        launch["executable_path"] = exe
    with render.serve(render_dir) as base, sync_playwright() as pw:
        browser = pw.chromium.launch(**launch)
        page = browser.new_page(viewport={"width": 1080, "height": 1920}, device_scale_factor=1)
        page.goto(f"{base}/index.html", wait_until="load")
        page.wait_for_function("() => document.body.dataset.ready === '1'")
        for t in args.times:
            page.evaluate("t => window.seekToTime(t)", t)
            report = page.evaluate("() => window.__layoutReport()")
            if report["problems"]:
                print(f"t={t}: {report['problems']}")
            shots.append(page.screenshot(type="png"))
        browser.close()

    import io

    ims = [Image.open(io.BytesIO(b)) for b in shots]
    w = int(1080 * args.scale)
    h = int(1920 * args.scale)
    ims = [im.resize((w, h), Image.LANCZOS) for im in ims]
    sheet = Image.new("RGB", (w * len(ims) + 10 * (len(ims) - 1), h), (0, 0, 0))
    for i, im in enumerate(ims):
        sheet.paste(im, (i * (w + 10), 0))
    sheet.save(args.out)
    print(f"wrote {args.out} ({sheet.width}x{sheet.height})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
