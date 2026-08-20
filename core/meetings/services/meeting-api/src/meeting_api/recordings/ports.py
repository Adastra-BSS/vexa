"""Ports (Protocols) for the recordings flow — chunk upload + finalize → master in
``meeting.data`` JSONB.

The parent ``recordings.internal_upload_recording`` + ``recording_finalizer`` talk to two
collaborators:

  * **object storage (MinIO/S3 or Azure Blob)** — each chunk is uploaded under a per-(recording,
    session, type) key; finalize concatenates the chunks into a master and uploads that. Expressed as
    a ``Storage`` Protocol: ``upload(key, data, content_type)``, ``list(prefix)``, ``get(key)``.
  * **the meeting store** — resolve the ``MeetingSession`` by ``session_uid`` (the upload arrives
    with the bot's ``connectionId``), and read/modify-under-lock ``meeting.data['recordings']``.
    Expressed as a ``RecordingRepo`` Protocol.

Each is a ``typing.Protocol`` so the app depends on BEHAVIOR, not a concrete client. ``adapters.py``
supplies the production implementations (MinIO + SQLAlchemy); the module's tests supply in-process
fakes (an in-memory blob store + an in-memory meeting store).
"""
from __future__ import annotations

from typing import Optional, Protocol, runtime_checkable


@runtime_checkable
class Storage(Protocol):
    """Object storage for recording chunks + masters (MinIO/S3 or Azure Blob in prod).

    **The missing-key contract.** Every backend spells "no such object" differently — boto3 raises a
    ``ClientError`` carrying a code, the azure SDK raises ``ResourceNotFoundError``. A consumer that
    catches either has to import that backend's package, which couples the app to the very client
    this Protocol exists to hide. So the port names ONE spelling and each adapter translates:

      * ``get`` / ``size`` / ``get_range`` raise ``KeyError(key)`` — the same thing a dict-backed
        store raises, so the in-memory fake and the production adapters agree by construction;
      * ``exists`` returns ``False`` (an absent object is its ANSWER, not an error);
      * ``delete`` is an idempotent no-op — the budget janitor's sweeps run on every replica (#637),
        so racing a key another replica already evicted must not abort the rest of the sweep.

    ``S3Storage`` is the one exception: it surfaces botocore's ``ClientError`` from its read methods.
    That is stated here rather than translated, because the only consumer that would notice is the
    raw media route, and a loud 500 is the honest answer to a JSONB row pointing at bytes that are
    gone — real inconsistency, not a condition to absorb.
    """

    async def upload(self, key: str, data: bytes, *, content_type: str) -> None:
        """Write ``data`` at ``key``, OVERWRITING any object already there (the bot retries chunks)."""
        ...

    async def list(self, prefix: str) -> list[str]:
        """Object keys under ``prefix`` (sorted) — used by finalize to gather a recording's chunks."""
        ...

    async def get(self, key: str) -> bytes:
        """The whole body. Raises ``KeyError(key)`` when the object does not exist."""
        ...

    async def exists(self, key: str) -> bool:
        """Whether the object is there — ``False`` when absent, never an exception."""
        ...

    async def size(self, key: str) -> int:
        """Object byte size WITHOUT fetching the body — lets the raw media route resolve
        ``Content-Range`` / a 416 for an HTTP Range without downloading the whole master. Raises
        ``KeyError(key)`` when the object does not exist."""
        ...

    async def get_range(self, key: str, start: int, end: int) -> bytes:
        """The INCLUSIVE byte slice ``[start, end]`` — S3/MinIO pass the Range through to
        ``get_object`` and Azure takes it as ``offset``/``length``, so seeking fetches only the
        requested window, not the whole object. Raises ``KeyError(key)`` when the object does not
        exist."""
        ...

    async def list_detailed(self, prefix: str) -> list[dict]:
        """``[{key, size, last_modified}]`` under ``prefix`` — key, byte size and mtime in ONE call.

        The captured-signal budget janitor needs all three for every tape to decide what to evict.
        Doing that with ``list`` plus a ``size``/head per key would be one network round-trip per
        object on a sweep that runs on a timer; ``list_objects_v2`` already returns Size and
        LastModified in the listing, so the port exposes what the backend gives away for free.
        """
        ...

    async def delete(self, key: str) -> None:
        """Remove ONE object, IDEMPOTENTLY (an already-absent key is a no-op). The only destructive
        operation on this port, used solely by the captured-signal budget janitor — stated here
        rather than reached for through the concrete client, so the blast radius is visible in the
        interface."""
        ...


@runtime_checkable
class RecordingRepo(Protocol):
    """The DB side of recordings: resolve the session, read/modify ``meeting.data['recordings']``."""

    async def find_session(self, session_uid: str) -> Optional[dict]:
        """The ``MeetingSession`` for ``session_uid`` → ``{meeting_id, session_uid}`` (the bot's
        ``connectionId``), or ``None`` when no session exists yet (upload before spawn)."""
        ...

    async def get_recordings(self, meeting_id: int) -> list[dict]:
        """The current ``meeting.data['recordings']`` list (under the same read the writer locks)."""
        ...

    async def put_recordings(self, meeting_id: int, recordings: list[dict]) -> None:
        """Persist the updated ``meeting.data['recordings']`` list (the row-locked write-back)."""
        ...

    async def mutate_recordings(self, meeting_id: int, mutator):
        """ATOMIC read→modify→write of ``meeting.data['recordings']`` under a SINGLE row lock (G3).
        ``mutator(recordings) -> (new_recordings, result)`` runs while the lock is held — the
        separate ``get_recordings`` + ``put_recordings`` released the lock between read and write, so
        a concurrent chunk-upload / finalize clobbered the other (lost update). Returns ``result``."""
        ...

    async def owner_of(self, meeting_id: int) -> Optional[int]:
        """The ``user_id`` that owns ``meeting_id`` — used to scope ``GET /recordings`` listing."""
        ...

    async def prepare_recording_deletion(
        self, user_id: int, recording_id: int
    ) -> Optional[dict]:
        """Lock and mark one owner-scoped recording deletion-pending while retaining its paths.

        Returns ``None`` for unknown/unowned and ``{"error": "conflict"}`` for a non-terminal
        meeting. The pending marker prevents ``continue_meeting`` from reopening the terminal row
        while object deletion is in flight.
        """
        ...

    async def list_meeting_recordings(self, user_id: int) -> list[dict]:
        """Every recording across the user's meetings (for ``GET /recordings``)."""
        ...
