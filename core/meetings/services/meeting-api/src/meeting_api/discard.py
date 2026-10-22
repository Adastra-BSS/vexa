"""Erase a meeting the bot discarded on objection.

The bot discards when someone objects - "attend discard" in the Teams chat, or a participant
removing it - and marks its terminal lifecycle event `discarded`. This erases what the meeting left
on the server, in the same order an owner's DELETE /meetings/{id} does: recording objects first
(so a failed storage delete leaves the paths addressable for a retry), then the transcripts and
the artifact keys of meeting.data. It also drops the `tc:meeting:{id}` stream, which that erasure
leaves behind. The meeting row itself stays, carrying `discarded`, so every consumer can see it is
not to be processed.

Signal tapes need no erasure here: the bot uploads them only at teardown, and a discarded bot
uploads none.
"""
from __future__ import annotations

from typing import Any, Awaitable, Callable, Optional


async def erase_discarded_meeting(
    *,
    store: Any,
    delete_recording_objects: Callable[[dict], Awaitable[list]],
    redis: Optional[Any],
    user_id: int,
    meeting_id: int,
) -> dict:
    """Erase the meeting's artifacts. Returns what was done; raises when the erasure did not finish,
    so the caller can report it (the meeting stays marked `discarded` either way)."""
    plan = await store.prepare_completed_artifact_deletion(user_id, meeting_id)
    if plan is None:
        raise LookupError(f"meeting {meeting_id} not found for its owner")
    if plan.get("error") == "conflict":
        raise RuntimeError(f"meeting {meeting_id} is not terminal yet")
    deleted_objects = 0
    for recording in plan.get("recordings") or []:
        deleted_objects += len(await delete_recording_objects(recording))
    finalized = await store.finalize_completed_artifact_deletion(user_id, meeting_id)
    if not finalized:
        raise RuntimeError(f"meeting {meeting_id} artifacts could not be finalized as deleted")
    if redis is not None:
        await redis.delete(f"tc:meeting:{meeting_id}")
    return {"recordings": len(plan.get("recordings") or []), "objects": deleted_objects}
