"""Command line entry point: `vtuber <command>` (or `python -m vtuber`)."""
from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from . import bootstrap, doctor, gates, pipeline, publish, scheduling, youtube
from .config import load_config
from .ledger import Ledger
from .logging_setup import episode_handler, setup
from .models import State
from .state import EpisodeStore

log = logging.getLogger("vtuber.cli")


def _cfg(args: argparse.Namespace):  # noqa: ANN202
    cfg = load_config(getattr(args, "config", None))
    setup(cfg.logs_dir, logging.DEBUG if args.verbose else logging.INFO)
    return cfg


# --------------------------------------------------------------------------- #


def cmd_doctor(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    rep = doctor.run(cfg.project_root)
    if args.json:
        print(json.dumps(rep.as_dict(), indent=2))
    else:
        print(doctor.format_report(rep))
    return 1 if rep.blocking else 0


def cmd_avatar(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    import subprocess

    script = cfg.project_root / "tools" / "make_avatar.py"
    return subprocess.run(
        [sys.executable, str(script), "--out", str(cfg.assets_dir / "avatar")], check=False
    ).returncode


def cmd_bootstrap(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    pin = bootstrap.resolve_model(args.model_repo or cfg.tts.model_repo)
    print(f"repo     {pin.repo_id}")
    print(f"revision {pin.revision}")
    print(f"licence  {pin.license_id or 'not declared'}  ({pin.license_url})")
    bootstrap.check_license(pin, accept=args.accept_license)
    path = Path(args.config) if args.config else cfg.project_root / "config" / "config.toml"
    bootstrap.write_pin(path, pin)
    print(f"\npinned in {path}. Uploads stay blocked until this is set, so this is "
          f"the point at which you have read the licence.")
    return 0


def cmd_token(args: argparse.Namespace) -> int:
    """Store a GitHub read-only token so discovery is not capped at 60/hour."""
    import getpass

    from .github_api import GitHub
    from .secrets_store import KEY_GITHUB_TOKEN, delete_secret, set_secret

    _cfg(args)
    if args.delete:
        delete_secret(KEY_GITHUB_TOKEN)
        print("GitHub token removed from the credential store")
        return 0
    if args.stdin:
        # For terminals where a hidden prompt will not accept a paste:
        #   Get-Clipboard | python -m vtuber token --stdin
        token = sys.stdin.read().strip()
    elif args.from_env:
        token = (os.environ.get(args.from_env) or "").strip()
        if not token:
            print(f"environment variable {args.from_env} is empty or unset", file=sys.stderr)
            return 1
    else:
        token = getpass.getpass("GitHub token (input hidden): ").strip()
    if not token:
        print("nothing entered", file=sys.stderr)
        return 1
    with GitHub(token=token) as gh:
        try:
            core, search = gh.remaining()
        except Exception as exc:  # noqa: BLE001
            print(f"token rejected by GitHub: {exc}", file=sys.stderr)
            return 1
    set_secret(KEY_GITHUB_TOKEN, token)
    print(f"stored. quota now {core} core / {search} search per hour")
    return 0


def cmd_auth(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    svc = youtube.service(interactive=True)
    ident = youtube.whoami(svc)
    print(f"authorised channel id    : {ident.channel_id}")
    print(f"authorised channel title : {ident.title}")
    if cfg.upload.expected_channel_id and cfg.upload.expected_channel_id != ident.channel_id:
        print(
            f"\nWARNING: config pins {cfg.upload.expected_channel_id}, which does not match.\n"
            "Nothing will upload until these agree.",
            file=sys.stderr,
        )
        return 2
    if not cfg.upload.expected_channel_id:
        print(
            "\nAdd this to config/config.toml before enabling uploads:\n"
            "\n[upload]\n"
            f'expected_channel_id = "{ident.channel_id}"\n'
            f'expected_channel_title = "{ident.title}"'
        )
    return 0


def cmd_run(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    try:
        episode, _ctx = pipeline.run(
            cfg,
            force_repo=args.repo,
            image_format=args.image_format,
            stop_after=args.stop_after,
        )
    except pipeline.PipelineSkip as exc:
        log.warning("skipped: %s", exc)
        print(f"skipped: {exc}")
        return 3
    except pipeline.PipelineFailed as exc:
        log.error("failed: %s", exc)
        print(f"failed: {exc}", file=sys.stderr)
        return 1
    print(pipeline.summarise(episode))
    return 0


def _latest(store: EpisodeStore, state: State | None = None):  # noqa: ANN202
    for ep in store.recent(limit=60):
        if state is None or ep.state is state:
            return ep
    return None


def cmd_canary(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    store = EpisodeStore(cfg.episodes_dir)
    ledger = Ledger(cfg.state_dir / "ledger.sqlite3")
    ep = store.load(args.episode) if args.episode else _latest(store, State.VALIDATED)
    if ep is None:
        print("no validated episode available for a canary", file=sys.stderr)
        return 1
    handler = episode_handler(cfg.logs_dir, ep.episode_id)
    try:
        outcome = publish.upload_episode(ep, cfg, ledger, canary=True)
        store.save(ep)
        print(f"uploaded privately as {outcome.video_id} ({outcome.detail})")
        status, payload = publish.confirm_processing(ep, ledger, timeout_s=args.timeout)
        store.save(ep)
        print(f"processing status: {status}")
        if status in youtube.TERMINAL_OK:
            store.advance(ep, State.CANARY_PASSED)
            print(
                "\nCanary processed successfully. Set `canary_passed = true` under [upload] in "
                "config/config.toml to allow public scheduling."
            )
            return 0
        print(json.dumps(payload.get("status", {}), indent=2), file=sys.stderr)
        return 1
    finally:
        logging.getLogger().removeHandler(handler)


def cmd_schedule(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    if not cfg.upload.enabled:
        print("upload.enabled is false in config; refusing to schedule", file=sys.stderr)
        return 2
    store = EpisodeStore(cfg.episodes_dir)
    ledger = Ledger(cfg.state_dir / "ledger.sqlite3")
    ep = store.load(args.episode) if args.episode else _latest(store, State.VALIDATED)
    if ep is None:
        print("no validated episode to schedule", file=sys.stderr)
        return 1

    pre = [
        c for c in gates.check_publish_preconditions(cfg, ledger.canary_confirmed())
        if not c.passed
    ]
    if pre:
        for c in pre:
            print(f"blocked: {c.name}: {c.detail}", file=sys.stderr)
        return 2
    try:
        target = scheduling.next_publish_at(cfg.upload.publish_local_time, cfg.upload.timezone)
    except scheduling.MissedWindow as exc:
        print(f"skipped: {exc}")
        return 3
    outcome = publish.upload_episode(ep, cfg, ledger, canary=False, publish_at=target)
    ep.publish_time = target
    store.save(ep)
    store.advance(ep, State.SCHEDULED)
    print(f"scheduled {outcome.video_id} for {scheduling.describe(target, cfg.upload.timezone)}")
    return 0


def cmd_daily(args: argparse.Namespace) -> int:
    """Generate, validate and schedule in one pass — what the scheduler calls."""
    rc = cmd_run(args)
    if rc != 0:
        return rc
    if not args.publish:
        print("\n--publish not set: generated only, nothing uploaded.")
        return 0
    return cmd_schedule(args)


def cmd_status(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    store = EpisodeStore(cfg.episodes_dir)
    ledger = Ledger(cfg.state_dir / "ledger.sqlite3")
    rows = store.recent(limit=args.limit)
    if not rows:
        print("no episodes yet")
        return 0
    for ep in rows:
        vid = ep.upload.video_id if ep.upload else ""
        print(f"{ep.episode_id}  {ep.state.value:14} {ep.repo_full_name:38} {vid or ''}")
        if ep.failure_reason:
            print(f"    ! {ep.failure_reason[:160]}")
    unresolved = list(ledger.unresolved_claims())
    if unresolved:
        print(f"\n{len(unresolved)} unresolved upload claim(s); run `vtuber reconcile`")
    print(f"\ncanary confirmed: {ledger.canary_confirmed()}")
    return 0


def cmd_reconcile(args: argparse.Namespace) -> int:
    cfg = _cfg(args)
    store = EpisodeStore(cfg.episodes_dir)
    ledger = Ledger(cfg.state_dir / "ledger.sqlite3")
    claims = list(ledger.unresolved_claims())
    if not claims:
        print("nothing to reconcile")
        return 0
    svc = youtube.service()
    for claim in claims:
        ep = store.try_load(claim["episode_id"])
        if ep is None:
            print(f"{claim['episode_id']}: manifest gone; marking abandoned")
            ledger.set_upload(claim["episode_id"], video_id=None, status="abandoned",
                              note="manifest missing")
            continue
        if claim["video_id"]:
            status = youtube.get_status(svc, claim["video_id"])
            up = (status.get("status") or {}).get("uploadStatus", "unknown")
            ledger.set_upload(claim["episode_id"], video_id=claim["video_id"],
                              status="confirmed" if up in youtube.TERMINAL_OK else "uploaded",
                              note=f"reconciled uploadStatus={up}")
            print(f"{claim['episode_id']}: {claim['video_id']} -> {up}")
            continue
        found = youtube.find_by_title(svc, ep.title or "")
        if found:
            ledger.set_upload(claim["episode_id"], video_id=found[0], status="uploaded",
                              note="recovered by title")
            print(f"{claim['episode_id']}: recovered as {found[0]}")
        else:
            ledger.set_upload(claim["episode_id"], video_id=None, status="abandoned",
                              note="no matching upload found")
            print(f"{claim['episode_id']}: no upload found; claim released")

    # Close the loop: a scheduled episode whose video has gone public is
    # 'published'. Nothing else advances it, because nothing else watches.
    for ep in store.recent(limit=60):
        if ep.state is not State.SCHEDULED or not (ep.upload and ep.upload.video_id):
            continue
        payload = youtube.get_status(svc, ep.upload.video_id)
        privacy = (payload.get("status") or {}).get("privacyStatus")
        if privacy == "public":
            ep.upload.privacy_status = privacy
            store.save(ep)
            store.advance(ep, State.PUBLISHED)
            print(f"{ep.episode_id}: now public ({ep.upload.video_id})")
    return 0


def cmd_timeline(args: argparse.Namespace) -> int:
    """Re-render an existing episode without regenerating script or audio."""
    cfg = _cfg(args)
    store = EpisodeStore(cfg.episodes_dir)
    ledger = Ledger(cfg.state_dir / "ledger.sqlite3")
    ep = store.load(args.episode)
    ctx = pipeline.RunContext(cfg=cfg, store=store, ledger=ledger)
    ep.state = State.AUDIO_READY
    pipeline.stage_render(ctx, ep, image_format=args.image_format)
    print(pipeline.summarise(ep))
    return 0


# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="vtuber", description=__doc__)
    p.add_argument("--config", help="path to config.toml")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="command", required=True)

    d = sub.add_parser("doctor", help="inspect this machine and report blockers")
    d.add_argument("--json", action="store_true")
    d.set_defaults(func=cmd_doctor)

    a = sub.add_parser("avatar", help="regenerate the avatar sprite sheet")
    a.set_defaults(func=cmd_avatar)

    b = sub.add_parser("bootstrap", help="pin the TTS model revision after reading its licence")
    b.add_argument("--model-repo")
    b.add_argument("--accept-license", help="licence id you have read and accept")
    b.set_defaults(func=cmd_bootstrap)

    t = sub.add_parser("token", help="store a GitHub read-only token (raises 60/hr to 5000/hr)")
    t.add_argument("--delete", action="store_true", help="remove the stored token")
    t.add_argument("--stdin", action="store_true",
                   help="read the token from stdin instead of a hidden prompt")
    t.add_argument("--from-env", metavar="VAR",
                   help="read the token from this environment variable")
    t.set_defaults(func=cmd_token)

    au = sub.add_parser("auth", help="run the YouTube OAuth flow and print the channel")
    au.set_defaults(func=cmd_auth)

    r = sub.add_parser("run", help="generate one episode (no upload)")
    r.add_argument("--repo", help="force a specific owner/name instead of discovery")
    r.add_argument("--image-format", choices=["png", "jpeg"], default="png")
    r.add_argument("--stop-after", choices=["discover", "script", "audio", "render"])
    r.set_defaults(func=cmd_run)

    c = sub.add_parser("canary", help="private canary upload + processing poll")
    c.add_argument("--episode")
    c.add_argument("--timeout", type=float, default=1800.0)
    c.set_defaults(func=cmd_canary)

    s = sub.add_parser("schedule", help="upload private with publishAt at the configured slot")
    s.add_argument("--episode")
    s.set_defaults(func=cmd_schedule)

    dy = sub.add_parser("daily", help="what Task Scheduler runs: generate, then optionally schedule")
    dy.add_argument("--publish", action="store_true")
    dy.add_argument("--repo")
    dy.add_argument("--image-format", choices=["png", "jpeg"], default="png")
    dy.add_argument("--stop-after", choices=["discover", "script", "audio", "render"])
    dy.add_argument("--episode")
    dy.set_defaults(func=cmd_daily)

    st = sub.add_parser("status", help="recent episodes and ledger state")
    st.add_argument("--limit", type=int, default=15)
    st.set_defaults(func=cmd_status)

    rc = sub.add_parser("reconcile", help="resolve ambiguous upload claims against YouTube")
    rc.set_defaults(func=cmd_reconcile)

    tl = sub.add_parser("rerender", help="re-render an existing episode")
    tl.add_argument("episode")
    tl.add_argument("--image-format", choices=["png", "jpeg"], default="png")
    tl.set_defaults(func=cmd_timeline)
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except KeyboardInterrupt:
        return 130
    except Exception as exc:  # noqa: BLE001
        logging.getLogger("vtuber").exception("unhandled error")
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
