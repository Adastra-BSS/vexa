"""A discarded meeting leaves nothing behind.

The bot discards on objection - "attend discard" in the Teams chat, or a participant removing it -
and says so on its terminal lifecycle event (`discarded`). The lifecycle callback then erases what
the meeting left on the server, the same erasure an owner's DELETE /meetings/{id} performs
(recording objects first, then transcripts and the artifact keys of meeting.data), plus the
`tc:meeting:{id}` stream that erasure does not touch. It never finalizes the transcript first:
writing a discarded meeting's words to durable storage only to delete them is the wrong order.

A meeting that ended any other way is untouched: finalized as before, nothing erased.
"""
from __future__ import annotations

from datetime import datetime, timezone

import fakeredis.aioredis
import pytest
from fastapi.testclient import TestClient

from meeting_api.collector.fakes import InMemoryTranscriptStore

USER = 7
NATIVE = "abc-defg-hij"
RECORDING = {"id": 501, "user_id": USER, "session_uid": "sess-uid"}
PREFIX = f"recordings/{USER}/501/sess-uid/"

JOINING = {"connection_id": "sess-uid", "container_id": "mtg-1-bot", "status": "joining"}
ACTIVE = {"connection_id": "sess-uid", "status": "active"}


@pytest.fixture
async def redis_c():
    client = fakeredis.aioredis.FakeRedis()
    yield client
    await client.aclose()


async def _app(redis_c):
    from meeting_api import create_app
    from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo
    from meeting_api.recordings.fakes import InMemoryStorage

    store = InMemoryTranscriptStore(redis_client=redis_c)
    store.seed_meeting(user_id=USER, platform="teams", native_meeting_id=NATIVE, meeting_id=1)
    store._meetings[1]["data"] = {"recordings": [dict(RECORDING)], "speaker_events": [{"name": "P"}]}
    await store.append_segment(1, {"segment_id": "s1", "start": 1.0, "end": 2.0, "text": "secret words",
                                   "language": "en", "speaker": "P", "completed": True,
                                   "updated_at": datetime.now(timezone.utc).isoformat()})
    repo = InMemoryMeetingRepo()
    meeting = await repo.create_meeting(user_id=USER, platform="teams", native_meeting_id=NATIVE, data={})
    assert meeting["id"] == 1
    await repo.create_session(meeting_id=1, session_uid="sess-uid")
    storage = InMemoryStorage()
    await storage.upload(PREFIX + "chunk-0.webm", b"audio", content_type="audio/webm")
    await storage.upload(PREFIX + "chunk-1.webm", b"audio", content_type="audio/webm")
    await redis_c.xadd("tc:meeting:1", {"payload": "segment"})

    finalized: list[int] = []

    async def finalizer(meeting_id: int) -> int:
        finalized.append(meeting_id)
        return 0

    client = TestClient(create_app(transcript_store=store, meeting_repo=repo, storage=storage,
                                   redis=redis_c, transcript_finalizer=finalizer))
    return client, store, storage, finalized


def _end(client, store, terminal: dict) -> None:
    for event in (JOINING, ACTIVE):
        assert client.post("/bots/internal/callback/lifecycle", json=event).status_code == 200
    # In production the meeting repo and the transcript store are one database row.
    store._meetings[1]["status"] = "completed"
    assert client.post("/bots/internal/callback/lifecycle", json=terminal).status_code == 200


@pytest.mark.parametrize("trigger,reason", [("command", "stopped"), ("removed", "evicted")])
async def test_a_discarded_meeting_is_erased(redis_c, trigger, reason):
    client, store, storage, finalized = await _app(redis_c)
    _end(client, store, {
        "connection_id": "sess-uid", "status": "completed", "exit_code": 0, "completion_reason": reason,
        "discarded": {"at": "2026-10-22T12:00:00.000Z", "trigger": trigger},
    })

    assert await storage.list(PREFIX) == []
    assert store._meetings[1]["segments"] == {}
    assert await redis_c.exists("meeting:1:segments") == 0
    data = store._meetings[1]["data"]
    assert "recordings" not in data and "speaker_events" not in data
    assert data["artifact_deletion"]["state"] == "completed"
    # The transcript feed is gone; what follows it is the lifecycle's copilot-reap control marker,
    # which carries no meeting content.
    feed = await redis_c.xrange("tc:meeting:1")
    assert [entry for _, entry in feed if entry.get(b"type") != b"session_end"] == []
    assert finalized == []


async def test_a_meeting_that_simply_ended_is_kept(redis_c):
    client, store, storage, finalized = await _app(redis_c)
    _end(client, store, {"connection_id": "sess-uid", "status": "completed", "exit_code": 0,
                         "completion_reason": "evicted"})

    assert len(await storage.list(PREFIX)) == 2
    assert store._meetings[1]["data"]["recordings"]
    assert "artifact_deletion" not in store._meetings[1]["data"]
    assert await redis_c.exists("tc:meeting:1") == 1
    assert finalized == [1]
