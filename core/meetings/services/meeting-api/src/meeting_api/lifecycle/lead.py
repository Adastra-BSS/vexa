"""Join-lead math: how early (or late) was the bot in the lobby, against the scheduled start?

The auto-join sweep spawns AUTO_JOIN_LEAD_S before ``scheduled_at``, but the pod cold start
(node scale-up + image pull) spends that lead on infrastructure — measured ~53s of a 120s lead
on AKS, 2026-08-25 (jana issue #40). Nothing asserted the bot was in the lobby before the
meeting started; a blown lead surfaced as a customer report, not a number.

This module is the pure half of the instrumentation. Both operands already live on the meeting
row's ``data`` JSONB: ``scheduled_at`` survives the planned-row claim (create_meeting_guarded's
2b merge), and the FSM persists the ``status_transition[]`` trail with producer timestamps on
every advance. The callback nexus (``app._apply_lifecycle_event``) calls in here on the advance
to ``awaiting_admission``, stamps ``data.lobby_at``, and logs the ``lobby_lead`` event these
fields feed.

Sign convention: ``lead_s = scheduled_at - lobby_at`` in seconds — positive means the bot was
early, negative means it was late (``late`` is the alertable boolean). A manual "send bot now"
has no ``scheduled_at``: ``lead_s``/``late`` are None but ``lobby_at`` is still recorded, so the
cold-start cost of manual sends stays visible too.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

LOBBY_STATUS = "awaiting_admission"


def _parse_iso(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def lobby_timestamp(status_transition: Optional[List[Dict[str, Any]]]) -> Optional[str]:
    """The producer timestamp of the FIRST ``awaiting_admission`` trail entry.

    First, not last: a re-entered lobby (retry paths) must not overwrite the moment the bot
    originally stood at the door — that first arrival is what the join lead bought."""
    for entry in status_transition or ():
        if isinstance(entry, dict) and entry.get("to") == LOBBY_STATUS:
            ts = entry.get("timestamp")
            return ts if isinstance(ts, str) else None
    return None


def lead_fields(data: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The ``lobby_lead`` log-event fields from a meeting row's ``data`` JSONB.

    None when the trail carries no lobby entry yet (the caller only asks on the
    ``awaiting_admission`` advance, so that is a malformed-trail guard, not a normal path)."""
    data = data if isinstance(data, dict) else {}
    lobby_at = lobby_timestamp(data.get("status_transition"))
    if lobby_at is None:
        return None
    scheduled_at = data.get("scheduled_at")
    lead_s: Optional[float] = None
    scheduled_dt = _parse_iso(scheduled_at)
    lobby_dt = _parse_iso(lobby_at)
    if scheduled_dt is not None and lobby_dt is not None:
        lead_s = (scheduled_dt - lobby_dt).total_seconds()
    return {
        "lobby_at": lobby_at,
        "scheduled_at": scheduled_at if isinstance(scheduled_at, str) else None,
        "lead_s": lead_s,
        "late": (lead_s < 0) if lead_s is not None else None,
    }
