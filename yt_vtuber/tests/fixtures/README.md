# Test fixtures

`evidence_widgetctl.json` is a **synthetic** evidence packet for a repository
that does not exist (`acme/widgetctl`). It exists so the downstream stages —
script generation, the critic, audio, the timeline, the renderer, the encoder
and every quality gate — can be exercised without hitting the GitHub API.

It is never used by a real run: `vtuber run` always builds its packet from
live primary sources.
