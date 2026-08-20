"""Production adapters — the real ``Storage`` (MinIO/S3 · Azure Blob) + ``RecordingRepo`` (SQLAlchemy).

Thin translations of the ports to the concrete clients, as the parent's
``recordings.internal_upload_recording`` (storage upload + the ``SELECT ... FOR UPDATE`` row lock on
``meeting.data``) and ``recording_finalizer`` (master build + upload) do. They carry NO test logic.

``build_storage_from_env`` is the ONE seam that picks a storage backend from ``STORAGE_BACKEND``;
every entry point (``__main__`` and ``build_production_router``) goes through it, so a deployment's
storage cannot depend on which entry point booted it.

Heavy imports (boto3, azure-storage-blob, SQLAlchemy) are LAZY (inside the methods / the builders) so
the package imports + unit-tests with the in-memory fakes without those runtime deps in the gate venv
— which is why ``pyproject.toml`` needs no extra pins. It also means a MinIO deployment never has to
install the azure SDK, and vice versa: the factory RESOLVES a backend without constructing a client.
"""
from __future__ import annotations

import os
from contextlib import contextmanager
from typing import Optional


class S3Storage:
    """``Storage`` over an S3/MinIO bucket (boto3). Lazy client so the package imports without boto3."""

    def __init__(self, *, bucket: str, endpoint_url: Optional[str] = None,
                 access_key: Optional[str] = None, secret_key: Optional[str] = None):
        self._bucket = bucket
        self._endpoint = endpoint_url
        self._access_key = access_key
        self._secret_key = secret_key
        self._client = None

    def _c(self):
        if self._client is None:
            import boto3

            self._client = boto3.client(
                "s3", endpoint_url=self._endpoint,
                aws_access_key_id=self._access_key, aws_secret_access_key=self._secret_key,
            )
        return self._client

    async def _run(self, fn, *args, **kwargs):
        """Run a BLOCKING boto3 call off the event loop (G4). boto3 is synchronous; calling it directly
        inside an async method stalls the whole control plane (a multi-MB master finalize fetches many
        objects). ``asyncio.to_thread`` offloads it to the default thread pool so the loop keeps serving
        lifecycle/webhook/ws traffic. Overridable in tests."""
        import asyncio

        return await asyncio.to_thread(fn, *args, **kwargs)

    async def upload(self, key: str, data: bytes, *, content_type: str) -> None:
        await self._run(self._c().put_object, Bucket=self._bucket, Key=key, Body=data, ContentType=content_type)

    async def list(self, prefix: str) -> list[str]:
        # S3 (and every S3-compatible backend) caps a single list_objects_v2 response at 1000 keys and
        # signals more via IsTruncated + NextContinuationToken (#769). Loop to exhaustion — a single
        # unpaginated call silently drops every chunk past the first page, so a >1000-chunk recording
        # would assemble a master from only its first 1000 objects.
        keys: list[str] = []
        token: Optional[str] = None
        while True:
            kw = {"Bucket": self._bucket, "Prefix": prefix}
            if token is not None:
                kw["ContinuationToken"] = token
            resp = await self._run(self._c().list_objects_v2, **kw)
            keys.extend(o["Key"] for o in resp.get("Contents", []))
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")
            if not token:
                # Truncated but no continuation token — the backend contract is broken; stop rather
                # than loop forever, but do NOT swallow it silently.
                raise RuntimeError(
                    f"list_objects_v2 reported IsTruncated with no NextContinuationToken "
                    f"(prefix={prefix!r}); chunk listing may be incomplete"
                )
        return sorted(keys)

    async def get(self, key: str) -> bytes:
        obj = await self._run(self._c().get_object, Bucket=self._bucket, Key=key)
        return await self._run(obj["Body"].read)

    async def size(self, key: str) -> int:
        head = await self._run(self._c().head_object, Bucket=self._bucket, Key=key)
        return int(head["ContentLength"])

    async def get_range(self, key: str, start: int, end: int) -> bytes:
        # Pass the byte range through to S3 (inclusive offsets) so we fetch only the requested window.
        resp = await self._run(self._c().get_object, Bucket=self._bucket, Key=key, Range=f"bytes={start}-{end}")
        return await self._run(resp["Body"].read)

    async def exists(self, key: str) -> bool:
        from botocore.exceptions import ClientError

        try:
            await self._run(self._c().head_object, Bucket=self._bucket, Key=key)
            return True
        except ClientError:
            return False

    async def list_detailed(self, prefix: str) -> list[dict]:
        """Key + Size + LastModified per object, paginated to exhaustion like ``list``.

        Size and LastModified ride the SAME response as the keys, so the janitor's whole sweep costs
        one paginated listing instead of a head_object per tape.
        """
        out: list[dict] = []
        token: Optional[str] = None
        while True:
            kw = {"Bucket": self._bucket, "Prefix": prefix}
            if token is not None:
                kw["ContinuationToken"] = token
            resp = await self._run(self._c().list_objects_v2, **kw)
            for o in resp.get("Contents", []):
                lm = o.get("LastModified")
                out.append({
                    "key": o["Key"],
                    "size": int(o.get("Size") or 0),
                    # boto3 hands back a tz-aware datetime; normalize to epoch seconds here so the
                    # janitor's ordering never depends on a backend's datetime flavour.
                    "last_modified": lm.timestamp() if lm is not None else 0.0,
                })
            if not resp.get("IsTruncated"):
                break
            token = resp.get("NextContinuationToken")
            if not token:
                raise RuntimeError(
                    f"list_objects_v2 reported IsTruncated with no NextContinuationToken "
                    f"(prefix={prefix!r}); object listing may be incomplete"
                )
        return sorted(out, key=lambda o: o["key"])

    async def delete(self, key: str) -> None:
        await self._run(self._c().delete_object, Bucket=self._bucket, Key=key)


class AzureBlobStorage:
    """``Storage`` over an Azure Blob container. Lazy client so the package imports without
    azure-storage-blob (a MinIO deployment never installs it).

    The SYNCHRONOUS SDK, offloaded through the same ``_run`` seam as ``S3Storage`` — not the ``.aio``
    variant. The sync client keeps ONE thread-offload story for both backends (so ``_c()`` stays
    stubbable in a plain unit test), needs no aiohttp, and has no async close to thread through the
    app lifespan. Blob I/O here is a handful of large calls per recording, not a high-QPS path, so a
    thread pool is the right shape.

    Paging matters: ``list_blobs`` returns a LAZY ``ItemPaged`` that fetches each page over the
    network as it is consumed, so both listing methods drain it INSIDE the worker thread. Returning
    the iterator and looping on the event loop would put the per-page round-trips right back on the
    loop the offload exists to protect.
    """

    def __init__(self, *, container: str, connection_string: str):
        self._container = container
        self._conn = connection_string
        self._client = None

    def _c(self):
        if self._client is None:
            from azure.storage.blob import BlobServiceClient

            self._client = BlobServiceClient.from_connection_string(
                self._conn
            ).get_container_client(self._container)
        return self._client

    async def _run(self, fn, *args, **kwargs):
        """Run a BLOCKING azure-sdk call off the event loop (G4) — see ``S3Storage._run`` for why.
        Overridable in tests."""
        import asyncio

        return await asyncio.to_thread(fn, *args, **kwargs)

    async def upload(self, key: str, data: bytes, *, content_type: str) -> None:
        from azure.storage.blob import ContentSettings

        # overwrite=True: a real container answers 409 BlobAlreadyExists by default, and the bot
        # legitimately re-uploads a chunk it is not sure landed.
        await self._run(
            self._c().upload_blob, name=key, data=data, overwrite=True,
            content_settings=ContentSettings(content_type=content_type),
        )

    async def list(self, prefix: str) -> list[str]:
        def _list() -> list[str]:
            return sorted(b.name for b in self._c().list_blobs(name_starts_with=prefix))

        return await self._run(_list)

    async def list_detailed(self, prefix: str) -> list[dict]:
        """Key + size + mtime per blob, all from the ONE listing response (see the port's rationale)."""
        def _list() -> list[dict]:
            out = []
            for b in self._c().list_blobs(name_starts_with=prefix):
                lm = b.last_modified
                out.append({
                    "key": b.name,
                    "size": int(b.size or 0),
                    # The SDK hands back a tz-aware datetime; normalize to epoch seconds so the
                    # janitor's ordering never depends on a backend's datetime flavour.
                    "last_modified": lm.timestamp() if lm is not None else 0.0,
                })
            return sorted(out, key=lambda o: o["key"])

        return await self._run(_list)

    async def get(self, key: str) -> bytes:
        def _get() -> bytes:
            with _as_key_error(key):
                return self._c().download_blob(key).readall()

        return await self._run(_get)

    async def get_range(self, key: str, start: int, end: int) -> bytes:
        # The port is INCLUSIVE [start, end]; the SDK takes offset + length.
        def _get() -> bytes:
            with _as_key_error(key):
                return self._c().download_blob(key, offset=start, length=end - start + 1).readall()

        return await self._run(_get)

    async def size(self, key: str) -> int:
        def _size() -> int:
            with _as_key_error(key):
                return int(self._c().get_blob_client(key).get_blob_properties().size)

        return await self._run(_size)

    async def exists(self, key: str) -> bool:
        from azure.core.exceptions import ResourceNotFoundError

        def _exists() -> bool:
            try:
                self._c().get_blob_client(key).get_blob_properties()
                return True
            except ResourceNotFoundError:
                return False

        return await self._run(_exists)

    async def delete(self, key: str) -> None:
        from azure.core.exceptions import ResourceNotFoundError

        def _delete() -> None:
            try:
                self._c().delete_blob(key)
            except ResourceNotFoundError:
                pass  # idempotent per the port; the janitor's sweeps race other replicas (#637)

        await self._run(_delete)


@contextmanager
def _as_key_error(key: str):
    """Translate the azure SDK's ``ResourceNotFoundError`` into the port's ``KeyError(key)``, so no
    ``Storage`` consumer has to import azure to recognize a missing object."""
    from azure.core.exceptions import ResourceNotFoundError

    try:
        yield
    except ResourceNotFoundError as exc:
        raise KeyError(key) from exc


def _minio_endpoint_url() -> str:
    """Build an http(s) MinIO URL from MINIO_ENDPOINT (host:port) + MINIO_SECURE, mirroring 0.11."""
    endpoint = os.getenv("MINIO_ENDPOINT", "minio:9000")
    if endpoint.startswith("http://") or endpoint.startswith("https://"):
        return endpoint
    scheme = "https" if os.getenv("MINIO_SECURE", "false").lower() == "true" else "http"
    return f"{scheme}://{endpoint}"


def build_storage_from_env():
    """The ONE place a recordings ``Storage`` backend is chosen — ``STORAGE_BACKEND`` selects it.

    That is the SAME var stamped into each recording's ``storage_backend`` JSONB field (``jsonb.py``),
    deliberately: the label an operator reads to find a tape and the dispatch that decided where the
    bytes went cannot drift apart while they are one value.

    Unset means ``minio``, with the endpoint/bucket/credential fallback chains 0.11 shipped — so an
    operator rolling back to the previous image with unchanged env keeps a working deployment. A
    configured-but-unsatisfiable backend raises HERE, at boot, naming the missing key; the
    alternative is a service that starts clean and then 500s the first chunk upload of every meeting.
    """
    backend = (os.getenv("STORAGE_BACKEND") or "minio").strip().lower()
    if backend == "azure":
        conn = (os.getenv("AZURE_STORAGE_CONNECTION_STRING") or "").strip()
        if not conn:
            raise RuntimeError(
                "STORAGE_BACKEND=azure requires AZURE_STORAGE_CONNECTION_STRING (unset or empty)"
            )
        return AzureBlobStorage(
            container=os.getenv("AZURE_STORAGE_CONTAINER") or "vexa",
            connection_string=conn,
        )
    if backend != "minio":
        raise RuntimeError(f"unknown STORAGE_BACKEND {backend!r} — expected 'minio' or 'azure'")
    return S3Storage(
        bucket=os.getenv("MINIO_BUCKET", os.getenv("RECORDING_BUCKET", "vexa")),
        endpoint_url=os.getenv("S3_ENDPOINT") or _minio_endpoint_url(),
        access_key=os.getenv("S3_ACCESS_KEY") or os.getenv("MINIO_ACCESS_KEY"),
        secret_key=os.getenv("S3_SECRET_KEY") or os.getenv("MINIO_SECRET_KEY"),
    )


class SqlAlchemyRecordingRepo:
    """``RecordingRepo`` over a SQLAlchemy-async ``session_factory`` (``meetings`` /
    ``meeting_sessions``; recordings live in ``meetings.data`` JSONB)."""

    def __init__(self, session_factory):
        self._session_factory = session_factory

    async def find_session(self, session_uid):
        from sqlalchemy import select

        from ..sessions.models import MeetingSession

        async with self._session_factory() as db:
            s = (
                await db.execute(
                    select(MeetingSession).where(MeetingSession.session_uid == session_uid)
                )
            ).scalars().first()
            return {"meeting_id": s.meeting_id, "session_uid": s.session_uid} if s else None

    async def _meeting(self, db, meeting_id):
        from sqlalchemy import select

        from ..sessions.models import Meeting

        return (
            await db.execute(select(Meeting).where(Meeting.id == meeting_id).with_for_update())
        ).scalars().first()

    async def get_recordings(self, meeting_id):
        async with self._session_factory() as db:
            m = await self._meeting(db, meeting_id)
            data = m.data if isinstance(m.data, dict) else {}
            return list(data.get("recordings", []))

    async def put_recordings(self, meeting_id, recordings):
        from sqlalchemy.orm.attributes import flag_modified

        async with self._session_factory() as db:
            m = await self._meeting(db, meeting_id)
            data = dict(m.data) if isinstance(m.data, dict) else {}
            data["recordings"] = list(recordings)
            m.data = data
            flag_modified(m, "data")
            await db.commit()

    async def mutate_recordings(self, meeting_id, mutator):
        """Atomic read→modify→write under ONE ``SELECT … FOR UPDATE`` row lock (G3). The lock spans the
        whole mutation (held from the read through commit), so concurrent chunk-upload / finalize calls
        serialize instead of clobbering each other (the old get+put released the lock between)."""
        from sqlalchemy.orm.attributes import flag_modified

        async with self._session_factory() as db:
            m = await self._meeting(db, meeting_id)  # SELECT … FOR UPDATE
            data = dict(m.data) if isinstance(m.data, dict) else {}
            recordings = list(data.get("recordings", []))
            new_recordings, result = mutator(recordings)
            data["recordings"] = list(new_recordings)
            m.data = data
            flag_modified(m, "data")
            await db.commit()
            return result

    async def owner_of(self, meeting_id):
        from sqlalchemy import select

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            m = (await db.execute(select(Meeting).where(Meeting.id == meeting_id))).scalars().first()
            return m.user_id if m else None

    async def prepare_recording_deletion(self, user_id, recording_id):
        from sqlalchemy import select
        from sqlalchemy.orm.attributes import flag_modified

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            meetings = (await db.execute(
                select(Meeting).where(Meeting.user_id == user_id).with_for_update()
            )).scalars().all()
            for meeting in meetings:
                data = dict(meeting.data) if isinstance(meeting.data, dict) else {}
                recordings = list(data.get("recordings") or [])
                recording = next((r for r in recordings if r.get("id") == recording_id), None)
                if recording is None:
                    continue
                if meeting.status not in ("completed", "failed"):
                    return {"error": "conflict"}
                prepared = {
                    **recording, "deletion_pending": True, "meeting_id": meeting.id,
                }
                data["recordings"] = [
                    prepared if r.get("id") == recording_id else r for r in recordings
                ]
                meeting.data = data
                flag_modified(meeting, "data")
                await db.commit()
                return prepared
            return None

    async def list_meeting_recordings(self, user_id):
        from sqlalchemy import select

        from ..sessions.models import Meeting

        async with self._session_factory() as db:
            rows = (
                await db.execute(select(Meeting).where(Meeting.user_id == user_id))
            ).scalars().all()
            out = []
            for m in rows:
                data = m.data if isinstance(m.data, dict) else {}
                for r in data.get("recordings", []):
                    out.append({**r, "meeting_id": m.id})
            return out


def build_production_router(*, database_url: Optional[str] = None):
    """Construct the recordings router with the env-selected storage + SQLAlchemy adapters."""
    from sqlalchemy.ext.asyncio import async_sessionmaker

    from ..db import build_engine
    from .router import build_router

    database_url = database_url or os.getenv(
        "DATABASE_URL", "postgresql+asyncpg://postgres:postgres@postgres:5432/vexa"
    )
    engine = build_engine(database_url)  # #635: env-steered pool
    session_factory = async_sessionmaker(engine, expire_on_commit=False)
    return build_router(SqlAlchemyRecordingRepo(session_factory), build_storage_from_env())
