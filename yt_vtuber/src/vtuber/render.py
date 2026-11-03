"""Deterministic frame rendering with Playwright/Chromium.

The stage is served over loopback HTTP (``fetch`` of the timeline is blocked
under ``file://``), seeked frame by frame through ``window.seekToTime`` and
screenshotted. Nothing in the page animates on its own, so frame *n* is a pure
function of ``n / fps``.
"""
from __future__ import annotations

import contextlib
import functools
import http.server
import json
import logging
import shutil
import socketserver
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterator

log = logging.getLogger(__name__)


class RenderError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# local static server
# --------------------------------------------------------------------------- #


class _QuietHandler(http.server.SimpleHTTPRequestHandler):
    def log_message(self, fmt: str, *args: object) -> None:  # noqa: A003
        log.debug("http %s", fmt % args)


@contextlib.contextmanager
def serve(directory: Path):
    handler = functools.partial(_QuietHandler, directory=str(directory))
    with socketserver.TCPServer(("127.0.0.1", 0), handler) as httpd:
        port = httpd.server_address[1]
        thread = threading.Thread(target=httpd.serve_forever, daemon=True)
        thread.start()
        try:
            yield f"http://127.0.0.1:{port}"
        finally:
            httpd.shutdown()
            thread.join(timeout=5)


# --------------------------------------------------------------------------- #
# staging
# --------------------------------------------------------------------------- #


def stage(
    templates_dir: Path,
    avatar_dir: Path,
    timeline: dict,
    out_dir: Path,
) -> Path:
    """Assemble a self-contained render directory."""
    out_dir.mkdir(parents=True, exist_ok=True)
    for item in templates_dir.iterdir():
        dest = out_dir / item.name
        if item.is_dir():
            shutil.copytree(item, dest, dirs_exist_ok=True)
        else:
            shutil.copy2(item, dest)
    sheet = avatar_dir / "avatar.png"
    if not sheet.is_file():
        raise RenderError(f"avatar sprite sheet missing: {sheet} (run tools/make_avatar.py)")
    shutil.copy2(sheet, out_dir / "avatar.png")
    tl = dict(timeline)
    tl["avatar"] = dict(tl["avatar"])
    tl["avatar"]["sheet"] = "avatar.png"
    (out_dir / "timeline.json").write_text(json.dumps(tl, indent=1), encoding="utf-8")
    return out_dir


# --------------------------------------------------------------------------- #
# rendering
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class RenderResult:
    frame_count: int
    chromium_version: str
    layout_problems: list[str] = field(default_factory=list)
    blank_frames: list[int] = field(default_factory=list)


#: A frame whose PNG/JPEG payload is smaller than this is almost certainly a
#: flat colour — a blank stage. Checked on sampled frames, not all of them.
MIN_FRAME_BYTES = 12_000


def frames(
    render_dir: Path,
    duration_s: float,
    fps: int,
    *,
    width: int = 1080,
    height: int = 1920,
    executable_path: str | None = None,
    image_format: str = "png",
    jpeg_quality: int = 92,
    timeout_ms: int = 15000,
    result: RenderResult | None = None,
    sample_layout_every: int = 30,
    progress_every: int = 150,
) -> Iterator[bytes]:
    """Yield encoded frame bytes, in order, for ``duration_s`` at ``fps``."""
    try:
        from playwright.sync_api import sync_playwright
    except ImportError as exc:  # pragma: no cover
        raise RenderError("playwright is not installed (`pip install -r requirements.txt`)") from exc

    total = max(int(round(duration_s * fps)), 1)
    launch: dict = {"args": ["--no-sandbox", "--disable-lcd-text", "--force-color-profile=srgb",
                            "--hide-scrollbars", "--disable-gpu"]}
    if executable_path:
        launch["executable_path"] = executable_path

    with serve(render_dir) as base_url, sync_playwright() as pw:
        browser = pw.chromium.launch(**launch)
        try:
            version = browser.version
            if result is not None:
                result.chromium_version = version
            page = browser.new_page(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
                reduced_motion="reduce",
            )
            page.set_default_timeout(timeout_ms)
            errors: list[str] = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"{base_url}/index.html", wait_until="load")
            page.wait_for_function("() => document.body.dataset.ready === '1'", timeout=timeout_ms)
            if errors:
                raise RenderError(f"page errors before rendering: {errors[:3]}")

            screenshot_kwargs: dict = {"type": image_format}
            if image_format == "jpeg":
                screenshot_kwargs["quality"] = jpeg_quality

            # Warm-up: the very first composite after load can land a frame
            # late (fonts, first layout), which made frame 0 differ between
            # otherwise identical runs. This screenshot is discarded.
            page.evaluate("() => window.seekToTime(0)")
            page.screenshot(**screenshot_kwargs)

            for i in range(total):
                t = i / fps
                page.evaluate("t => window.seekToTime(t)", t)
                if i % sample_layout_every == 0 and result is not None:
                    report = page.evaluate("() => window.__layoutReport()")
                    for p in report.get("problems", []):
                        entry = f"t={t:.2f}s: {p}"
                        if entry not in result.layout_problems:
                            result.layout_problems.append(entry)
                buf = page.screenshot(**screenshot_kwargs)
                if result is not None:
                    if i % sample_layout_every == 0 and len(buf) < MIN_FRAME_BYTES:
                        result.blank_frames.append(i)
                    result.frame_count = i + 1
                if progress_every and i % progress_every == 0:
                    log.info("rendered %d/%d frames (t=%.1fs)", i, total, t)
                yield buf

            if errors:
                raise RenderError(f"page errors during rendering: {errors[:3]}")
        finally:
            browser.close()
    log.info("rendered %d frames", total)
