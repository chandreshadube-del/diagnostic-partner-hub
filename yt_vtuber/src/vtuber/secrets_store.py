"""OS-protected secret storage.

On Windows ``keyring`` resolves to the Windows Credential Manager. Nothing
secret is ever written to the repository, to a manifest, or to a log: the only
things persisted in the project are non-secret identifiers such as the channel
id the pipeline is pinned to.
"""
from __future__ import annotations

import logging
import os
from pathlib import Path

log = logging.getLogger(__name__)

SERVICE = "vtuber-shorts"
KEY_OAUTH_TOKEN = "youtube-oauth-token"
KEY_GITHUB_TOKEN = "github-token"


class SecretsError(RuntimeError):
    pass


def _keyring():  # noqa: ANN202
    try:
        import keyring
    except ImportError as exc:  # pragma: no cover
        raise SecretsError(
            "keyring is not installed; secrets cannot be stored safely "
            "(`pip install -r requirements.txt`)"
        ) from exc
    return keyring


def set_secret(key: str, value: str) -> None:
    _keyring().set_password(SERVICE, key, value)
    log.info("stored secret %r in the OS credential store", key)


def get_secret(key: str) -> str | None:
    env = os.environ.get(f"VTUBER_{key.upper().replace('-', '_')}")
    if env:
        return env
    try:
        return _keyring().get_password(SERVICE, key)
    except SecretsError:
        return None


def delete_secret(key: str) -> None:
    try:
        _keyring().delete_password(SERVICE, key)
    except Exception as exc:  # noqa: BLE001 - backend-specific "not found"
        log.info("could not delete secret %r: %s", key, exc)


def client_secrets_path() -> Path:
    """Where the OAuth *client* configuration lives — outside the repository.

    The client secret for an installed app is not a password, but it still has
    no business in version control.
    """
    env = os.environ.get("VTUBER_CLIENT_SECRETS")
    if env:
        return Path(env)
    base = Path(os.environ.get("APPDATA") or Path.home() / ".config")
    return base / "vtuber-shorts" / "client_secrets.json"


def assert_not_in_repo(path: Path, repo_root: Path) -> None:
    try:
        path.resolve().relative_to(repo_root.resolve())
    except ValueError:
        return
    raise SecretsError(
        f"{path} is inside the repository. Move OAuth client secrets outside the project "
        f"(default location: {client_secrets_path()})."
    )
