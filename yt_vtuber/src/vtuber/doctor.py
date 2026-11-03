"""Environment inspection — the input to the feasibility report."""
from __future__ import annotations

import importlib.util
import os
import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass, field, asdict
from pathlib import Path

from .pipeline import total_ram_gb

#: Kokoro and misaki both declare ``python <3.13``; the venv must respect that.
TTS_PY_MIN = (3, 10)
TTS_PY_MAX_EXCLUSIVE = (3, 13)


@dataclass(slots=True)
class Finding:
    name: str
    ok: bool
    detail: str
    blocking: bool = True


@dataclass(slots=True)
class Report:
    platform: str
    python: str
    cpu_count: int | None
    ram_gb: float | None
    findings: list[Finding] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "platform": self.platform,
            "python": self.python,
            "cpu_count": self.cpu_count,
            "ram_gb": self.ram_gb,
            "findings": [asdict(f) for f in self.findings],
        }

    @property
    def blocking(self) -> list[Finding]:
        return [f for f in self.findings if f.blocking and not f.ok]


def _cmd_version(exe: str, *args: str) -> str | None:
    path = shutil.which(exe)
    if not path:
        return None
    try:
        out = subprocess.run([path, *args], capture_output=True, text=True, timeout=30, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return None
    text = (out.stdout or out.stderr).strip().splitlines()
    return text[0] if text else path


def _module(name: str) -> bool:
    return importlib.util.find_spec(name) is not None


def run(project_root: Path | None = None) -> Report:
    rep = Report(
        platform=platform.platform(),
        python=f"{platform.python_version()} ({sys.executable})",
        cpu_count=os.cpu_count(),
        ram_gb=round(total_ram_gb(), 1) if total_ram_gb() else None,
    )
    add = rep.findings.append

    v = sys.version_info[:2]
    add(Finding(
        "python.version",
        TTS_PY_MIN <= v < TTS_PY_MAX_EXCLUSIVE,
        f"{v[0]}.{v[1]} — kokoro and misaki require >=3.10,<3.13; "
        f"create the venv with a 3.12 interpreter",
    ))

    ff = _cmd_version("ffmpeg", "-version")
    add(Finding("ffmpeg", ff is not None, ff or "not found on PATH — install from ffmpeg.org "
                                                "or `winget install Gyan.FFmpeg`"))
    fp = _cmd_version("ffprobe", "-version")
    add(Finding("ffprobe", fp is not None, fp or "not found on PATH (ships with FFmpeg)"))

    for mod, why, blocking in (
        ("playwright", "renders the stage", True),
        ("PIL", "avatar generation and blank-frame checks", True),
        ("numpy", "audio processing", True),
        ("pydantic", "schema validation", True),
        ("httpx", "GitHub API", True),
        ("kokoro", "local TTS", True),
        ("faster_whisper", "local ASR", True),
        ("googleapiclient", "YouTube upload", True),
        ("keyring", "OS credential storage", True),
        ("soundfile", "optional audio IO", False),
    ):
        present = _module(mod)
        add(Finding(f"python.{mod}", present, f"{'present' if present else 'missing'} — {why}", blocking))

    # Chromium: Playwright's own download, or an explicit binary.
    chromium = os.environ.get("VTUBER_CHROMIUM") or ""
    if chromium:
        add(Finding("chromium", Path(chromium).exists(), f"VTUBER_CHROMIUM={chromium}"))
    elif _module("playwright"):
        try:
            from playwright.sync_api import sync_playwright

            with sync_playwright() as pw:
                path = pw.chromium.executable_path
            add(Finding("chromium", Path(path).exists(),
                        f"{path}{'' if Path(path).exists() else ' — run `playwright install chromium`'}"))
        except Exception as exc:  # noqa: BLE001
            add(Finding("chromium", False, f"could not resolve: {exc}"))
    else:
        add(Finding("chromium", False, "playwright not installed"))

    # Ollama: local only, never a hosted endpoint.
    ollama = _cmd_version("ollama", "--version")
    add(Finding("ollama", ollama is not None,
                ollama or "not found on PATH — install from https://ollama.com/download "
                          "(the pipeline talks to it on 127.0.0.1:11434 only)",
                blocking=True))

    free_gb = shutil.disk_usage(project_root or Path.cwd()).free / 1024**3
    add(Finding("disk", free_gb > 25, f"{free_gb:.1f} GB free (models + episodes need ~20 GB)"))

    if rep.ram_gb is not None:
        add(Finding("ram", rep.ram_gb >= 8,
                    f"{rep.ram_gb:.1f} GB — below 12 GB the pipeline downgrades to 3B models",
                    blocking=rep.ram_gb < 8))
    return rep


def format_report(rep: Report) -> str:
    lines = [
        "environment",
        f"  platform   {rep.platform}",
        f"  python     {rep.python}",
        f"  cpu        {rep.cpu_count}",
        f"  ram        {rep.ram_gb} GB",
        "",
        "findings",
    ]
    for f in rep.findings:
        mark = "ok  " if f.ok else ("FAIL" if f.blocking else "warn")
        lines.append(f"  [{mark}] {f.name:22} {f.detail}")
    if rep.blocking:
        lines += ["", f"{len(rep.blocking)} blocking problem(s) must be fixed before a real run."]
    else:
        lines += ["", "no blocking problems."]
    return "\n".join(lines)
