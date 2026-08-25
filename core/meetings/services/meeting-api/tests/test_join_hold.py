"""Spawn-early-join-late (jana #40) — the sweep passes the bot a join window, not just a spawn.

The auto-join sweep dispatches ``AUTO_JOIN_LEAD_S`` before ``scheduled_at`` so the pod cold start
(node scale-up + image pull, ~150s measured 2026-08-25) happens while the bot is invisible. The
bot must NOT then loiter in the lobby for the whole lead: the dispatch hands it
``VEXA_JOIN_NOT_BEFORE = scheduled_at - lobby_lead_s`` via the workload spec env (NOT invocation.v1,
which is sealed), and the bot's join-hold waits until then before starting the join flow.

Manual sends carry no window at all — they join immediately, as before.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from meeting_api.bot_spawn.auto_join import (
    DEFAULT_LOBBY_LEAD_S,
    auto_join_tick,
    join_not_before,
)
from meeting_api.bot_spawn.fakes import FakeRuntimeClient, InMemoryMeetingRepo
from meeting_api.bot_spawn.service import request_bot

USER = 7
PLAT, NID = "google_meet", "abc-defg-hij"
NOW = datetime(2026, 7, 10, 15, 0, 0, tzinfo=timezone.utc)
SECRET = "test-secret"
JOIN_ENV = "VEXA_JOIN_NOT_BEFORE"


def _seed_scheduled(repo, *, mid=1, at=NOW):
    repo._meetings[mid] = {
        "id": mid, "user_id": USER, "platform": PLAT,
        "native_meeting_id": NID, "platform_specific_id": NID,
        "status": "scheduled", "bot_container_id": None, "start_time": None, "end_time": None,
        "data": {"title": "t", "auto_join": True, "scheduled_at": at.isoformat()},
        "created_at": "2026-07-08T09:00:00Z", "updated_at": "2026-07-08T09:00:00Z",
    }
    return mid


async def _tick(repo, runtime, **kw):
    kw.setdefault("transcribe_gate", lambda: None)
    kw.setdefault("now", NOW)
    kw.setdefault("token_secret", SECRET)
    kw.setdefault("redis_url", "redis://r")
    kw.setdefault("allow_uncapped", True)
    return await auto_join_tick(repo, runtime, **kw)


# ── the pure window math ─────────────────────────────────────────────────────────────────────

def test_join_not_before_subtracts_lobby_lead():
    assert join_not_before({"scheduled_at": "2026-07-10T15:02:00+00:00"}, lobby_lead_s=60) \
        == "2026-07-10T15:01:00+00:00"


def test_join_not_before_none_without_scheduled_at():
    assert join_not_before({}, lobby_lead_s=60) is None
    assert join_not_before({"scheduled_at": "garbage"}, lobby_lead_s=60) is None


# ── the sweep hands the window to the workload ───────────────────────────────────────────────

async def test_auto_join_dispatch_carries_join_not_before(monkeypatch):
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.vexa.ai")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_TOKEN", "tok-test")
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    start = NOW + timedelta(seconds=90)  # inside the lead window → due now
    _seed_scheduled(repo, at=start)

    out = await _tick(repo, runtime)

    assert out["spawned"] == 1
    env = runtime.specs[0]["env"]
    expected = (start - timedelta(seconds=DEFAULT_LOBBY_LEAD_S)).isoformat()
    assert env[JOIN_ENV] == expected
    # The sealed invocation is untouched: the window rides ONLY the spec env.
    assert JOIN_ENV not in json.loads(env["VEXA_BOT_CONFIG"])


async def test_auto_join_lobby_lead_is_tunable(monkeypatch):
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.vexa.ai")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_TOKEN", "tok-test")
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()
    start = NOW + timedelta(seconds=90)
    _seed_scheduled(repo, at=start)

    await _tick(repo, runtime, lobby_lead_s=30)

    expected = (start - timedelta(seconds=30)).isoformat()
    assert runtime.specs[0]["env"][JOIN_ENV] == expected


# ── manual sends join immediately, as before ─────────────────────────────────────────────────

async def test_manual_request_bot_has_no_join_window(monkeypatch):
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_URL", "https://stt.vexa.ai")
    monkeypatch.setenv("TRANSCRIPTION_SERVICE_TOKEN", "tok-test")
    repo, runtime = InMemoryMeetingRepo(), FakeRuntimeClient()

    await request_bot(
        repo, runtime, user_id=USER, platform=PLAT, native_meeting_id=NID,
        bot_name="Jana Notetaker", redis_url="redis://r",
        meeting_api_url="http://meeting-api:8080", token_secret=SECRET,
    )

    assert JOIN_ENV not in runtime.specs[0]["env"]
