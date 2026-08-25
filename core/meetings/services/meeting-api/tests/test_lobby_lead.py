"""Join-lead instrumentation (jana issue #40): was the bot in the lobby before the meeting start?

The auto-join sweep spawns with a lead (AUTO_JOIN_LEAD_S before ``scheduled_at``), but nothing ever
measured whether the lead survived the pod cold start (node scale-up + image pull ate ~53s of it,
measured 2026-08-25). These tests pin the two halves of the fix:

* the pure math (``lifecycle.lead``): first ``awaiting_admission`` trail entry vs ``scheduled_at``;
* the callback nexus (``_apply_lifecycle_event``): a real advance to ``awaiting_admission`` persists
  ``data.lobby_at`` on the meeting row and emits ONE ``lobby_lead`` log event with the computed
  lead — including the manual-send case, where there is no ``scheduled_at`` and the lead is null
  but the lobby timestamp is still recorded.
"""
from __future__ import annotations

import asyncio

from fastapi.testclient import TestClient

from meeting_api.bot_spawn.fakes import InMemoryMeetingRepo
from meeting_api.lifecycle.lead import lead_fields, lobby_timestamp

ENDPOINT = "/bots/internal/callback/lifecycle"

LOBBY_TS = "2026-07-28T10:00:30.000Z"
SCHEDULED_TS = "2026-07-28T10:02:00.000Z"


# ── the pure math ─────────────────────────────────────────────────────────────────────────────

def _trail(*entries):
    return [{"to": to, "timestamp": ts, "timestamp_source": "producer", "source": "bot_callback"}
            for to, ts in entries]


def test_lobby_timestamp_is_first_awaiting_admission_entry():
    trail = _trail(("joining", "2026-07-28T10:00:00.000Z"),
                   ("awaiting_admission", LOBBY_TS),
                   ("awaiting_admission", "2026-07-28T10:09:00.000Z"))
    assert lobby_timestamp(trail) == LOBBY_TS


def test_lobby_timestamp_none_without_lobby_entry():
    assert lobby_timestamp(_trail(("joining", "2026-07-28T10:00:00.000Z"))) is None
    assert lobby_timestamp([]) is None


def test_lead_fields_scheduled_meeting_early():
    data = {"scheduled_at": SCHEDULED_TS,
            "status_transition": _trail(("awaiting_admission", LOBBY_TS))}
    fields = lead_fields(data)
    assert fields == {
        "lobby_at": LOBBY_TS,
        "scheduled_at": SCHEDULED_TS,
        "lead_s": 90.0,
        "late": False,
    }


def test_lead_fields_scheduled_meeting_late_is_negative():
    data = {"scheduled_at": "2026-07-28T10:00:00.000Z",
            "status_transition": _trail(("awaiting_admission", LOBBY_TS))}
    fields = lead_fields(data)
    assert fields["lead_s"] == -30.0
    assert fields["late"] is True


def test_lead_fields_manual_send_has_lobby_but_no_lead():
    data = {"status_transition": _trail(("awaiting_admission", LOBBY_TS))}
    fields = lead_fields(data)
    assert fields == {
        "lobby_at": LOBBY_TS,
        "scheduled_at": None,
        "lead_s": None,
        "late": None,
    }


def test_lead_fields_none_before_lobby():
    assert lead_fields({"scheduled_at": SCHEDULED_TS, "status_transition": []}) is None
    assert lead_fields({}) is None


# ── the callback nexus ────────────────────────────────────────────────────────────────────────

def _seed_meeting(repo: InMemoryMeetingRepo, *, data: dict, session_uid: str = "sess-uid") -> dict:
    m = asyncio.run(repo.create_meeting(
        user_id=1, platform="google_meet", native_meeting_id="m1", data=data))
    asyncio.run(repo.create_session(meeting_id=m["id"], session_uid=session_uid))
    return m


def _capture_log_events(monkeypatch) -> list:
    """Patch obs.log_event BEFORE create_app so _mount_lifecycle binds the recording stub."""
    import meeting_api.obs as obs
    events: list = []
    real = obs.log_event

    def recording(event, **kw):
        events.append((event, kw))
        return real(event, **kw)

    monkeypatch.setattr(obs, "log_event", recording)
    return events


def _drive_to_lobby(client: TestClient):
    r = client.post(ENDPOINT, json={
        "connection_id": "sess-uid", "status": "joining",
        "timestamp": "2026-07-28T10:00:00.000Z"})
    assert r.status_code == 200, r.text
    r = client.post(ENDPOINT, json={
        "connection_id": "sess-uid", "status": "awaiting_admission",
        "timestamp": LOBBY_TS})
    assert r.status_code == 200, r.text


def test_lobby_advance_persists_lobby_at_and_logs_lead(monkeypatch):
    from meeting_api import create_app

    repo = InMemoryMeetingRepo()
    m = _seed_meeting(repo, data={"scheduled_at": SCHEDULED_TS})
    events = _capture_log_events(monkeypatch)
    client = TestClient(create_app(meeting_repo=repo))

    _drive_to_lobby(client)

    row = repo._meetings[m["id"]]
    assert row["data"]["lobby_at"] == LOBBY_TS
    lead_events = [kw for ev, kw in events if ev == "lobby_lead"]
    assert len(lead_events) == 1
    fields = lead_events[0]["fields"]
    assert fields["lead_s"] == 90.0
    assert fields["late"] is False
    assert fields["scheduled_at"] == SCHEDULED_TS


def test_manual_send_logs_lobby_without_lead(monkeypatch):
    from meeting_api import create_app

    repo = InMemoryMeetingRepo()
    m = _seed_meeting(repo, data={})
    events = _capture_log_events(monkeypatch)
    client = TestClient(create_app(meeting_repo=repo))

    _drive_to_lobby(client)

    row = repo._meetings[m["id"]]
    assert row["data"]["lobby_at"] == LOBBY_TS
    lead_events = [kw for ev, kw in events if ev == "lobby_lead"]
    assert len(lead_events) == 1
    fields = lead_events[0]["fields"]
    assert fields["lobby_at"] == LOBBY_TS
    assert fields["lead_s"] is None


def test_lobby_replay_is_noop_and_does_not_double_log(monkeypatch):
    from meeting_api import create_app

    repo = InMemoryMeetingRepo()
    _seed_meeting(repo, data={"scheduled_at": SCHEDULED_TS})
    events = _capture_log_events(monkeypatch)
    client = TestClient(create_app(meeting_repo=repo))

    _drive_to_lobby(client)
    # The bot's redelivery of the same status is an idempotent 200 no-op — one lead per join.
    r = client.post(ENDPOINT, json={
        "connection_id": "sess-uid", "status": "awaiting_admission",
        "timestamp": "2026-07-28T10:00:45.000Z"})
    assert r.status_code == 200, r.text

    assert len([1 for ev, _ in events if ev == "lobby_lead"]) == 1
