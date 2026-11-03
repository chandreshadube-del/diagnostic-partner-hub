"""A minimal stand-in for the googleapiclient YouTube service.

Enough of the fluent surface to drive publish.py: channels().list(),
videos().insert()/list(), playlistItems().list().
"""
from __future__ import annotations

from dataclasses import dataclass, field


class FakeHttpError(Exception):
    def __init__(self, status: int) -> None:
        super().__init__(f"HTTP {status}")

        class _Resp:
            def __init__(self, s: int) -> None:
                self.status = s

        self.resp = _Resp(status)


@dataclass
class _Call:
    payload: dict

    def execute(self) -> dict:
        return self.payload


@dataclass
class _Insert:
    parent: "FakeYouTube"
    body: dict
    chunks: int = 1
    _done: int = 0

    def next_chunk(self):  # noqa: ANN201
        self._done += 1
        if self.parent.fail_with is not None:
            exc = self.parent.fail_with
            self.parent.fail_with = None
            raise exc
        if self._done < self.chunks:
            return None, None
        vid = f"vid{len(self.parent.store) + 1:03d}"
        status = dict(self.body.get("status") or {})
        status.setdefault("uploadStatus", "uploaded")
        self.parent.store[vid] = {
            "id": vid,
            "status": status,
            "snippet": self.body.get("snippet", {}),
        }
        self.parent.inserts.append(vid)
        return None, self.parent.store[vid]


class _Videos:
    def __init__(self, parent: "FakeYouTube") -> None:
        self.p = parent

    def insert(self, part: str, body: dict, media_body=None):  # noqa: ANN001, ANN201
        self.p.insert_bodies.append(body)
        return _Insert(self.p, body, chunks=self.p.chunks)

    def list(self, part: str, id: str):  # noqa: A002, ANN201
        v = self.p.store.get(id)
        return _Call({"items": [v] if v else []})


class _Channels:
    def __init__(self, parent: "FakeYouTube") -> None:
        self.p = parent

    def list(self, part: str, mine: bool = False):  # noqa: ANN201
        if "contentDetails" in part:
            return _Call({"items": [{"id": self.p.channel_id,
                                     "contentDetails": {"relatedPlaylists": {"uploads": "UU_x"}}}]})
        return _Call({"items": [{"id": c, "snippet": {"title": t}}
                                for c, t in self.p.channel_list]})


class _PlaylistItems:
    def __init__(self, parent: "FakeYouTube") -> None:
        self.p = parent

    def list(self, part: str, playlistId: str, maxResults: int = 25):  # noqa: N803, ANN201
        items = [
            {"snippet": {"title": v["snippet"].get("title", ""),
                         "resourceId": {"videoId": vid}}}
            for vid, v in self.p.store.items()
        ]
        return _Call({"items": items[:maxResults]})


@dataclass
class FakeYouTube:
    channel_id: str = "UC_expected"
    channel_title: str = "Test Channel"
    chunks: int = 1
    fail_with: Exception | None = None
    store: dict = field(default_factory=dict)
    inserts: list = field(default_factory=list)
    insert_bodies: list = field(default_factory=list)
    channel_list: list = field(default_factory=list)

    def __post_init__(self) -> None:
        if not self.channel_list:
            self.channel_list = [(self.channel_id, self.channel_title)]

    def videos(self):  # noqa: ANN201
        return _Videos(self)

    def channels(self):  # noqa: ANN201
        return _Channels(self)

    def playlistItems(self):  # noqa: N802, ANN201
        return _PlaylistItems(self)

    def set_status(self, video_id: str, upload_status: str, **extra: object) -> None:
        self.store[video_id]["status"]["uploadStatus"] = upload_status
        self.store[video_id]["status"].update(extra)
