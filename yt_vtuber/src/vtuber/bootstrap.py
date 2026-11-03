"""Pin the TTS model revision and record its licence.

``tts.model_revision`` starts empty and ``gates.check_tts_engine`` blocks every
upload while it stays empty. This command is the only thing that fills it in,
and it refuses to do so without reading the licence off the model repository
first — so "which licence are the weights under?" is answered by a fetch, not
by an assumption.
"""
from __future__ import annotations

import logging
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

#: Licences this project is willing to pin without a human decision. Anything
#: else stops and asks, including the Hugging Face variants with use clauses.
PERMISSIVE = {"apache-2.0", "mit", "bsd-3-clause", "bsd-2-clause", "cc0-1.0"}


class BootstrapError(RuntimeError):
    pass


@dataclass(slots=True)
class ModelPin:
    repo_id: str
    revision: str
    license_id: str | None
    license_url: str


def resolve_model(repo_id: str) -> ModelPin:
    try:
        from huggingface_hub import HfApi
    except ImportError as exc:  # pragma: no cover
        raise BootstrapError(
            "huggingface_hub is not installed; it comes with `kokoro` "
            "(`pip install -r requirements.txt` in a Python 3.12 venv)."
        ) from exc
    try:
        info = HfApi().model_info(repo_id, files_metadata=False)
    except Exception as exc:  # noqa: BLE001
        raise BootstrapError(f"could not reach {repo_id} on Hugging Face: {exc}") from exc
    sha = getattr(info, "sha", None)
    if not sha:
        raise BootstrapError(f"{repo_id} returned no commit sha to pin")
    card = getattr(info, "cardData", None) or {}
    license_id = (card.get("license") or getattr(info, "license", None) or "").strip().lower() or None
    return ModelPin(
        repo_id=repo_id,
        revision=sha,
        license_id=license_id,
        license_url=f"https://huggingface.co/{repo_id}/blob/{sha}/LICENSE",
    )


def check_license(pin: ModelPin, *, accept: str | None = None) -> None:
    if accept:
        log.warning("accepting licence %r for %s on explicit instruction", accept, pin.repo_id)
        return
    if pin.license_id is None:
        raise BootstrapError(
            f"{pin.repo_id} declares no licence in its model card. Read "
            f"{pin.license_url} yourself and re-run with --accept-license <id> "
            f"if you are satisfied."
        )
    if pin.license_id not in PERMISSIVE:
        raise BootstrapError(
            f"{pin.repo_id} is licensed {pin.license_id!r}, which this project does not pin "
            f"automatically. Read {pin.license_url} and re-run with "
            f"--accept-license {pin.license_id} if that licence suits your use."
        )


def write_pin(config_path: Path, pin: ModelPin) -> Path:
    """Update only ``[tts].model_revision`` / ``model_repo``, in place."""
    import tomllib

    try:
        import tomli_w
    except ImportError as exc:  # pragma: no cover
        raise BootstrapError("tomli-w is not installed") from exc

    if not config_path.is_file():
        raise BootstrapError(
            f"{config_path} does not exist. Copy config/config.example.toml to it first."
        )
    data = tomllib.loads(config_path.read_text(encoding="utf-8"))
    tts = data.setdefault("tts", {})
    tts["model_repo"] = pin.repo_id
    tts["model_revision"] = pin.revision
    config_path.write_text(tomli_w.dumps(data), encoding="utf-8")
    log.info("pinned %s@%s in %s", pin.repo_id, pin.revision[:12], config_path)
    return config_path
