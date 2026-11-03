#!/usr/bin/env python3
"""End-to-end prototype run WITHOUT model weights.

What is real here: GitHub discovery and evidence collection over the live API,
schema validation, the mechanical critic, every quality gate, the Chromium
render, the FFmpeg encode and the video QC.

What is substituted: the writer/critic models (deterministic stub), the voice
(tone stub) and the transcription (synthetic stand-in). An episode produced
this way is barred from upload by the publish gates — that is the point.

    python tools/e2e_prototype.py [--repo owner/name] [--offline]
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from vtuber import gates, pipeline  # noqa: E402
from vtuber.asr import SyntheticASR  # noqa: E402
from vtuber.config import load_config  # noqa: E402
from vtuber.ledger import Ledger  # noqa: E402
from vtuber.logging_setup import setup  # noqa: E402
from vtuber.state import EpisodeStore  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", help="force a repository instead of discovery")
    ap.add_argument("--evidence", help="skip discovery and load a stored evidence packet")
    ap.add_argument("--out", default=str(ROOT / "episodes"))
    ap.add_argument("--image-format", choices=["png", "jpeg"], default="png")
    args = ap.parse_args()

    cfg = load_config()
    cfg.llm.backend = "stub"
    cfg.tts.engine = "stub"
    cfg.render.try_hwaccel = True   # detection is real; it falls back on this box
    cfg.episodes_dir = Path(args.out)
    setup(cfg.logs_dir, logging.INFO)

    store = EpisodeStore(cfg.episodes_dir)
    ledger = Ledger(cfg.state_dir / "ledger.sqlite3")
    ctx = pipeline.RunContext(cfg=cfg, store=store, ledger=ledger)

    t0 = time.monotonic()
    if args.evidence:
        from vtuber.models import Episode, EvidencePacket, State, utcnow
        from vtuber.state import episode_id_for

        packet = EvidencePacket.model_validate_json(Path(args.evidence).read_text())
        episode = Episode(
            episode_id=episode_id_for(packet.repo_full_name),
            created_at=utcnow(), topic=packet.topic[:200],
            repo_full_name=packet.repo_full_name,
            source_refs=packet.source_refs, facts=packet.facts, state=State.DISCOVERED,
        )
        store.save(episode)
    else:
        episode, packet = pipeline.stage_discover(ctx, force_repo=args.repo)
    print(f"[1/5] discovered {episode.repo_full_name} "
          f"({len(packet.source_refs)} refs, {len(packet.facts)} facts) "
          f"in {time.monotonic()-t0:.1f}s")

    t = time.monotonic()
    pipeline.stage_script(ctx, episode, packet)
    assert episode.script is not None
    print(f"[2/5] script: {episode.script.word_count} words, "
          f"templates={[s.template for s in episode.script.scenes]} "
          f"in {time.monotonic()-t:.1f}s")

    t = time.monotonic()
    pipeline.stage_audio(ctx, episode, asr_engine=SyntheticASR(episode.script.narration))
    print(f"[3/5] audio: {episode.audio_duration_s:.2f}s, "
          f"{len(episode.word_timestamps)} word timestamps in {time.monotonic()-t:.1f}s")

    t = time.monotonic()
    pipeline.stage_render(ctx, episode, image_format=args.image_format)
    rs = episode.render_settings
    print(f"[4/5] render: {rs.video_codec} hwaccel={rs.hwaccel} "
          f"chromium={rs.chromium_version} in {time.monotonic()-t:.1f}s")

    t = time.monotonic()
    try:
        pipeline.stage_validate(ctx, episode, packet)
        print(f"[5/5] gates: PASS in {time.monotonic()-t:.1f}s")
    except pipeline.PipelineFailed as exc:
        print(f"[5/5] gates: FAIL — {exc}")

    print()
    print(pipeline.summarise(episode))
    print()
    print("publish preconditions (expected to block for a stub run):")
    for c in (gates.check_generator(episode), gates.check_tts_engine(episode),
              *gates.check_publish_preconditions(cfg, ledger.canary_confirmed())):
        print(f"  [{'ok  ' if c.passed else 'BLOCK'}] {c.name:26} {c.detail}")
    print(f"\ntotal {time.monotonic()-t0:.1f}s")
    print(f"manifest: {store.path_for(episode.episode_id)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
