"""``AzureBlobStorage`` against a REAL Azure Blob endpoint (Azurite) — the contract decider.

The stub-client tests in ``test_recordings_azure.py`` pin what the adapter ASKS the SDK for; only a
real endpoint proves the SDK answers the way the ``Storage`` port promises. The one that cannot be
faked is ``get_range``: the port is INCLUSIVE ``[start, end]`` while the SDK is
``offset``/``length``, and a stub that mirrors the adapter's own arithmetic would agree with an
off-by-one. Here the bytes come back from a real service or they do not.

Skipped where no Azurite is reachable (laptop/CI without it), the same shape as
``core/runtime/tests/test_k8s_backend.py``. To run it:

    docker run --rm -d --name vexa-azurite -p 10000:10000 \
        mcr.microsoft.com/azure-storage/azurite \
        azurite-blob --blobHost 0.0.0.0 --skipApiVersionCheck
    uv run --with azure-storage-blob pytest -q tests/test_recordings_azurite_e2e.py

``--skipApiVersionCheck`` is not optional: the emulator whitelists the storage REST API versions it
knows, and the SDK negotiates the newest one it ships with, so a current azure-storage-blob against a
current Azurite answers ``InvalidHeaderValue`` on the first request. Real Azure serves that version —
the lag is the emulator's, so skipping the check is the accurate stand-in, not a workaround.
"""
from __future__ import annotations

import pytest

# Azurite's well-known DEVELOPMENT account — published by Microsoft, hardcoded in the emulator, and
# useless against real Azure. It is not a credential.
AZURITE_CONNECTION_STRING = (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;"
    "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;"
)


def _azurite_ok() -> bool:
    """The SDK importable AND something listening on Azurite's blob port."""
    import socket

    try:
        import azure.storage.blob  # noqa: F401
    except ImportError:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(2)
        return sock.connect_ex(("127.0.0.1", 10000)) == 0


pytestmark = pytest.mark.skipif(
    not _azurite_ok(), reason="no reachable Azurite on 127.0.0.1:10000 (or azure-storage-blob absent)"
)

MASTER = bytes(range(256))  # position-checkable master bytes: byte i == i


@pytest.fixture
def container(request):
    """A FRESH container per test (named from the test, so a leftover never leaks across runs),
    removed afterwards."""
    from azure.storage.blob import BlobServiceClient

    # Container names: lowercase alphanumerics + dashes. The node name carries underscores.
    name = "vexa-e2e-" + request.node.name.replace("_", "-").lower()[-40:].strip("-")
    service = BlobServiceClient.from_connection_string(AZURITE_CONNECTION_STRING)
    client = service.get_container_client(name)
    if client.exists():
        client.delete_container()
    client.create_container()
    try:
        yield name
    finally:
        client.delete_container()


@pytest.fixture
def storage(container):
    from meeting_api.recordings.adapters import AzureBlobStorage

    return AzureBlobStorage(container=container, connection_string=AZURITE_CONNECTION_STRING)


# ── the round trip ──────────────────────────────────────────────────────────────────────────────


async def test_upload_then_get_round_trips_the_bytes(storage):
    await storage.upload("recordings/7/100/audio/master.wav", MASTER, content_type="audio/wav")
    assert await storage.get("recordings/7/100/audio/master.wav") == MASTER


async def test_upload_preserves_the_content_type_on_the_blob(storage, container):
    """Asserted on the SERVICE's own view of the blob, not through the adapter — the dashboard's
    <audio> element needs the real Content-Type header, and only the service can confirm it."""
    from azure.storage.blob import BlobServiceClient

    await storage.upload("k.wav", MASTER, content_type="audio/wav")
    props = (BlobServiceClient.from_connection_string(AZURITE_CONNECTION_STRING)
             .get_container_client(container).get_blob_client("k.wav").get_blob_properties())
    assert props.content_settings.content_type == "audio/wav"


async def test_reupload_of_the_same_key_overwrites(storage):
    """The bot retries a chunk upload; a real container answers 409 BlobAlreadyExists unless the
    adapter passes overwrite=True. This is the leg the stub cannot decide."""
    await storage.upload("k", b"first", content_type="audio/wav")
    await storage.upload("k", b"second", content_type="audio/wav")
    assert await storage.get("k") == b"second"


async def test_exists_and_size_agree_with_the_uploaded_object(storage):
    await storage.upload("k", MASTER, content_type="audio/wav")
    assert await storage.exists("k") is True
    assert await storage.size("k") == 256


# ── listing ─────────────────────────────────────────────────────────────────────────────────────


async def test_list_is_sorted_and_prefix_scoped(storage):
    for key in ("p/c", "p/a", "p/b", "other/z"):
        await storage.upload(key, b"x", content_type="application/octet-stream")
    assert await storage.list("p/") == ["p/a", "p/b", "p/c"]


async def test_list_detailed_shape_against_the_real_service(storage):
    """Size and mtime ride the SAME listing response, and ``last_modified`` must arrive as a
    comparable epoch FLOAT (the janitor's ordering key), not the SDK's datetime."""
    import time

    before = time.time() - 5
    await storage.upload("p/a", b"1", content_type="application/octet-stream")
    await storage.upload("p/b", b"22", content_type="application/octet-stream")
    await storage.upload("other/c", b"333", content_type="application/octet-stream")
    rows = await storage.list_detailed("p/")
    assert [r["key"] for r in rows] == ["p/a", "p/b"], "sorted by key, prefix-scoped"
    assert [r["size"] for r in rows] == [1, 2]
    for row in rows:
        assert isinstance(row["last_modified"], float)
        assert before <= row["last_modified"] <= time.time() + 5, row["last_modified"]


async def test_list_of_an_empty_prefix_is_empty_not_an_error(storage):
    assert await storage.list("nothing/here/") == []


# ── get_range: the INCLUSIVE-to-offset/length translation, decided by the real service ──────────


async def test_get_range_returns_exactly_the_inclusive_window(storage):
    await storage.upload("k", MASTER, content_type="audio/wav")
    window = await storage.get_range("k", 10, 19)
    assert window == bytes(range(10, 20))
    assert len(window) == 10, "an inclusive [10, 19] is TEN bytes"


async def test_get_range_edges_are_inclusive_on_both_sides(storage):
    await storage.upload("k", MASTER, content_type="audio/wav")
    assert await storage.get_range("k", 0, 0) == bytes([0])
    assert await storage.get_range("k", 255, 255) == bytes([255])
    assert await storage.get_range("k", 0, 255) == MASTER


# ── the missing-key contract, against the real backend ─────────────────────────────────────────


async def test_missing_key_contract_against_the_real_service(storage):
    for call in (storage.get("gone"), storage.size("gone"), storage.get_range("gone", 0, 9)):
        with pytest.raises(KeyError):
            await call
    assert await storage.exists("gone") is False
    await storage.delete("gone")  # idempotent no-op


async def test_delete_removes_the_blob_from_the_service(storage):
    await storage.upload("k", b"x", content_type="audio/wav")
    await storage.delete("k")
    assert await storage.exists("k") is False


# ── the router over the real backend (the value the issue is actually buying) ───────────────────


def _seeded_client(storage, storage_path: str):
    """The recordings router mounted on a real FastAPI app, backed by the REAL Azure storage and the
    in-memory repo — the seeding recipe from ``test_recordings_range.py``."""
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    from meeting_api.recordings import build_router
    from meeting_api.recordings.fakes import InMemoryRecordingRepo

    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=1, user_id=7, session_uid="conn-abc")
    repo._meetings[1]["recordings"] = [
        {
            "id": 100, "session_uid": "conn-abc", "source": "bot", "status": "completed",
            "media_files": [
                {"id": 11, "type": "audio", "format": "wav", "is_final": True,
                 "storage_path": storage_path},
            ],
        }
    ]
    app = FastAPI()
    app.include_router(build_router(repo, storage))
    return TestClient(app)


async def test_raw_media_route_serves_a_full_body_from_azure(storage):
    path = "recordings/7/100/conn-abc/audio/master.wav"
    await storage.upload(path, MASTER, content_type="audio/wav")
    r = _seeded_client(storage, path).get("/recordings/100/media/11/raw?type=audio",
                                         headers={"x-user-id": "7"})
    assert r.status_code == 200, r.text
    assert r.headers["accept-ranges"] == "bytes"
    assert r.headers["content-length"] == "256"
    assert r.content == MASTER


async def test_raw_media_route_honors_an_http_range_over_azure(storage):
    """The whole point of ``get_range`` reaching the port: the dashboard's <audio> seek becomes a
    206 whose body is the requested window and whose Content-Range agrees with it."""
    path = "recordings/7/100/conn-abc/audio/master.wav"
    await storage.upload(path, MASTER, content_type="audio/wav")
    r = _seeded_client(storage, path).get(
        "/recordings/100/media/11/raw?type=audio",
        headers={"x-user-id": "7", "Range": "bytes=10-19"},
    )
    assert r.status_code == 206, r.text
    assert r.headers["content-range"] == "bytes 10-19/256"
    assert r.headers["content-length"] == "10"
    assert r.content == MASTER[10:20]


async def test_chunk_upload_and_finalize_land_in_azure(storage):
    """The producer side end to end: the shipped ``upload_chunk`` writes a chunk THROUGH the Azure
    adapter, and the bytes are readable back out of the container."""
    from meeting_api.recordings import upload_chunk
    from meeting_api.recordings.fakes import InMemoryRecordingRepo

    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=1, user_id=7, session_uid="conn-abc")
    result = await upload_chunk(
        repo, storage,
        token_meeting_id=1, session_uid="conn-abc", chunk_seq=0, data=MASTER,
        media_type="audio", media_format="wav", is_final=False,
    )
    # a NON-final chunk: the chunk is persisted, the master is not built yet
    assert result["status"] == "in_progress", result
    assert await storage.get(result["storage_path"]) == MASTER
    assert await storage.list("recordings/") == [result["storage_path"]]
