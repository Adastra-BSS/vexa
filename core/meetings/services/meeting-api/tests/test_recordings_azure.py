"""``AzureBlobStorage`` — the unit-level contract, driven over a STUB container client.

Same shape as ``test_recordings.py``'s ``_StubS3``: a subclass overrides ``_c()`` (so no
azure-storage-blob client is ever constructed and no account is contacted) and INHERITS ``_run`` —
the ``asyncio.to_thread`` offload is precisely what the event-loop test exercises.

What is pinned here, and why each one is a defect if it regresses:

  * the blocking SDK call runs OFF the loop (G4) — the azure SDK is synchronous exactly like boto3,
    so a multi-MB master finalize would otherwise stall the whole control plane;
  * ``list``/``list_detailed`` drain the lazily-paging ``ItemPaged`` INSIDE the thread — returning
    the iterator and consuming it on the loop moves the per-page network round-trips back onto the
    loop, which is the same stall wearing a different hat;
  * ``get_range`` translates the port's INCLUSIVE ``[start, end]`` into the SDK's
    ``offset``/``length`` pair — an off-by-one here serves a wrong audio window on every seek;
  * the missing-key contract: ``get``/``size``/``get_range`` raise ``KeyError``, ``exists`` is
    False, ``delete`` is an idempotent no-op.
"""
from __future__ import annotations

import pytest

from meeting_api.recordings.adapters import AzureBlobStorage

# The exception the adapter translates is the SDK's own type — without azure.core installed there is
# nothing to raise, so the whole module is skipped rather than testing a hand-rolled look-alike.
pytest.importorskip("azure.core", reason="azure-storage-blob (azure.core) not installed")

from azure.core.exceptions import ResourceNotFoundError  # noqa: E402  (after importorskip)


class _Blob:
    """A ``list_blobs`` item — the SDK's BlobProperties carries ``name``/``size``/``last_modified``."""

    def __init__(self, name: str, size: int = 0, last_modified=None):
        self.name = name
        self.size = size
        self.last_modified = last_modified


class _Downloader:
    def __init__(self, data: bytes):
        self._data = data

    def readall(self) -> bytes:
        return self._data


class _StubContainer:
    """A stub ``ContainerClient``: dict-backed, records calls, and raises the SDK's own
    ResourceNotFoundError for an absent blob (what a real container does)."""

    def __init__(self, blobs: dict | None = None, *, block_s: float = 0.0):
        self.blobs: dict[str, bytes] = dict(blobs or {})
        self.mtimes: dict[str, object] = {}
        self.uploads: list[dict] = []
        self.deleted: list[str] = []
        self.range_calls: list[tuple] = []
        self.list_calls = 0
        self._block_s = block_s

    def _maybe_block(self):
        if self._block_s:
            import time

            time.sleep(self._block_s)  # a real, blocking, synchronous call (what the SDK does)

    def _require(self, name: str) -> bytes:
        if name not in self.blobs:
            raise ResourceNotFoundError(f"blob {name} not found")
        return self.blobs[name]

    # ── the ContainerClient surface the adapter uses ──
    def upload_blob(self, name=None, data=None, overwrite=False, content_settings=None, **kw):
        self._maybe_block()
        self.uploads.append({"name": name, "data": data, "overwrite": overwrite,
                             "content_type": getattr(content_settings, "content_type", None)})
        self.blobs[name] = data

    def list_blobs(self, name_starts_with=None, **kw):
        self.list_calls += 1
        names = [n for n in self.blobs if n.startswith(name_starts_with or "")]
        # Deliberately UNSORTED and lazy: a generator stands in for the SDK's ItemPaged, which
        # fetches each page over the network as it is consumed. Iterating it outside the worker
        # thread is the defect the event-loop test guards.
        return (_Blob(n, len(self.blobs[n]), self.mtimes.get(n)) for n in reversed(sorted(names)))

    def download_blob(self, name, offset=None, length=None, **kw):
        self._maybe_block()
        data = self._require(name)
        if offset is None:
            return _Downloader(data)
        self.range_calls.append((name, offset, length))
        return _Downloader(data[offset : offset + length])

    def delete_blob(self, name, **kw):
        self._require(name)
        del self.blobs[name]
        self.deleted.append(name)

    def get_blob_client(self, name):
        outer = self

        class _BlobClient:
            def get_blob_properties(self):
                outer._require(name)
                return _Blob(name, len(outer.blobs[name]), outer.mtimes.get(name))

        return _BlobClient()


class _StubAzure(AzureBlobStorage):
    """``AzureBlobStorage`` with its client replaced. ``_run`` is INHERITED — the to_thread offload
    is under test, not stubbed."""

    def __init__(self, container: _StubContainer):
        super().__init__(container="c", connection_string="stub")
        self._stub = container

    def _c(self):
        return self._stub


def _epoch(seconds: float):
    """A tz-aware datetime like the SDK hands back for ``last_modified``."""
    import datetime as dt

    return dt.datetime.fromtimestamp(seconds, tz=dt.timezone.utc)


# ── G4: the blocking SDK call must not block the event loop ─────────────────────────────────────


async def test_upload_does_not_block_the_event_loop():
    """The azure SDK is synchronous. A ~0.3s blocking upload runs concurrently with a 5ms
    heartbeat: a non-blocking loop ticks many times, a blocked one ~never."""
    import asyncio

    storage = _StubAzure(_StubContainer(block_s=0.3))
    ticks = {"n": 0}
    stop = {"v": False}

    async def heartbeat():
        while not stop["v"]:
            ticks["n"] += 1
            await asyncio.sleep(0.005)

    hb = asyncio.create_task(heartbeat())
    try:
        await storage.upload("k", b"x" * 1024, content_type="audio/wav")
    finally:
        stop["v"] = True
        await hb

    assert len(storage._stub.uploads) == 1
    assert ticks["n"] >= 20, (
        f"event loop appears BLOCKED during the azure upload (only {ticks['n']} heartbeats in "
        "~0.3s) — the SDK call is not being offloaded to a thread"
    )


async def test_list_drains_the_pager_inside_the_thread():
    """``list_blobs`` returns a LAZY pager; the adapter must consume it in the worker thread. A
    blocking pager stands in for the per-page network fetch — if the iteration happened on the
    loop, the heartbeat would starve exactly as in an un-offloaded upload."""
    import asyncio

    class _BlockingPagerContainer(_StubContainer):
        def list_blobs(self, name_starts_with=None, **kw):
            pager = super().list_blobs(name_starts_with=name_starts_with, **kw)

            def _slow():
                import time

                for item in pager:
                    time.sleep(0.1)  # a page fetch
                    yield item

            return _slow()

    storage = _StubAzure(_BlockingPagerContainer({"p/a": b"1", "p/b": b"2", "p/c": b"3"}))
    ticks = {"n": 0}
    stop = {"v": False}

    async def heartbeat():
        while not stop["v"]:
            ticks["n"] += 1
            await asyncio.sleep(0.005)

    hb = asyncio.create_task(heartbeat())
    try:
        keys = await storage.list("p/")
    finally:
        stop["v"] = True
        await hb

    assert keys == ["p/a", "p/b", "p/c"]
    assert ticks["n"] >= 20, (
        f"only {ticks['n']} heartbeats while paging — the ItemPaged is being iterated ON the event "
        "loop instead of inside the worker thread"
    )


# ── the read/write translations ─────────────────────────────────────────────────────────────────


async def test_upload_overwrites_and_carries_the_content_type():
    """Chunk re-upload (the bot retries) must overwrite, not 409; and the content type has to reach
    the blob or the browser gets a download instead of a playable <audio> source."""
    storage = _StubAzure(_StubContainer())
    await storage.upload("k.wav", b"first", content_type="audio/wav")
    await storage.upload("k.wav", b"second", content_type="audio/wav")
    assert storage._stub.blobs["k.wav"] == b"second"
    assert [u["overwrite"] for u in storage._stub.uploads] == [True, True]
    assert storage._stub.uploads[0]["content_type"] == "audio/wav"


async def test_list_returns_sorted_names_under_the_prefix():
    storage = _StubAzure(_StubContainer({"p/b": b"2", "p/a": b"1", "other/c": b"3"}))
    assert await storage.list("p/") == ["p/a", "p/b"], "sorted, and nothing outside the prefix"


async def test_get_returns_the_whole_body():
    storage = _StubAzure(_StubContainer({"k": b"payload"}))
    assert await storage.get("k") == b"payload"


async def test_size_reads_properties_without_fetching_the_body():
    storage = _StubAzure(_StubContainer({"k": b"x" * 4096}))
    assert await storage.size("k") == 4096


async def test_get_range_translates_the_inclusive_window_to_offset_and_length():
    """The port's contract is INCLUSIVE ``[start, end]``; the SDK takes ``offset`` + ``length``.
    ``length = end - start + 1`` — one byte short here truncates every ranged read."""
    storage = _StubAzure(_StubContainer({"k": bytes(range(256))}))
    assert await storage.get_range("k", 10, 19) == bytes(range(10, 20))
    assert storage._stub.range_calls == [("k", 10, 10)], "offset=start, length=end-start+1"
    # a single-byte window is the degenerate case the off-by-one hides in
    assert await storage.get_range("k", 5, 5) == bytes([5])
    assert storage._stub.range_calls[-1] == ("k", 5, 1)


async def test_exists_is_true_for_a_present_blob():
    storage = _StubAzure(_StubContainer({"k": b"x"}))
    assert await storage.exists("k") is True


async def test_list_detailed_carries_size_and_epoch_float_mtimes_sorted_by_key():
    """The budget janitor evicts oldest-first, so ``last_modified`` must be a comparable epoch
    float — the SDK hands back a tz-aware datetime, normalized here like the S3 adapter does."""
    container = _StubContainer({"p/b": b"22", "p/a": b"1", "other/c": b"333"})
    container.mtimes = {"p/a": _epoch(1000.5), "p/b": _epoch(2000.0)}
    storage = _StubAzure(container)
    assert await storage.list_detailed("p/") == [
        {"key": "p/a", "size": 1, "last_modified": 1000.5},
        {"key": "p/b", "size": 2, "last_modified": 2000.0},
    ]


async def test_list_detailed_tolerates_a_missing_mtime():
    container = _StubContainer({"p/a": b"1"})
    storage = _StubAzure(container)
    assert await storage.list_detailed("p/") == [{"key": "p/a", "size": 1, "last_modified": 0.0}]


async def test_delete_removes_the_blob():
    storage = _StubAzure(_StubContainer({"k": b"x"}))
    await storage.delete("k")
    assert storage._stub.deleted == ["k"] and "k" not in storage._stub.blobs


# ── the missing-key contract (issue gap 3) ──────────────────────────────────────────────────────


async def test_missing_key_raises_key_error_from_the_read_methods():
    """``ResourceNotFoundError`` is an SDK-shaped exception; every ``Storage`` consumer would have
    to import azure to catch it. The adapter translates it to the port's ``KeyError(key)`` — the
    same thing the in-memory fake raises — so a consumer's handling is backend-independent."""
    storage = _StubAzure(_StubContainer())
    for label, call in (
        ("get", storage.get("gone")),
        ("size", storage.size("gone")),
        ("get_range", storage.get_range("gone", 0, 9)),
    ):
        with pytest.raises(KeyError) as ei:
            await call
        assert "gone" in str(ei.value), f"{label} must name the missing key"


async def test_missing_key_is_false_from_exists_not_an_error():
    storage = _StubAzure(_StubContainer())
    assert await storage.exists("gone") is False


async def test_delete_of_a_missing_key_is_an_idempotent_no_op():
    """The budget janitor may sweep a key another replica already evicted (#637 runs these loops on
    every replica). A raise there would abort the rest of the sweep."""
    storage = _StubAzure(_StubContainer())
    await storage.delete("gone")  # must not raise
    assert storage._stub.deleted == []


def test_the_adapter_satisfies_the_storage_protocol():
    from meeting_api.recordings.ports import Storage

    assert isinstance(_StubAzure(_StubContainer()), Storage)
