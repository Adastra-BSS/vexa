"""``build_storage_from_env`` — the ONE place the recordings ``Storage`` adapter is chosen.

Before the factory there were two divergent construction sites (``__main__`` and
``build_production_router``) that disagreed on the bucket default, so which storage a deployment
got depended on which entry point booted it. Now both call the factory, and these tests pin what
the factory resolves from env.

Fully OFFLINE: every adapter's client is LAZY (``_c()``), so a factory call constructs no client —
no boto3, no azure-storage-blob, no reachable backend needed here.

The pin that carries the rollback: an EMPTY env must still resolve MinIO with the 0.11 bucket and
endpoint, so an operator who rolls back to the old image + old env keeps a working deployment.
"""
from __future__ import annotations

import pytest

from meeting_api.recordings.adapters import (
    AzureBlobStorage,
    S3Storage,
    build_storage_from_env,
)

# Every env key the factory reads — cleared per test so a permutation states its whole world.
_STORAGE_ENV = (
    "STORAGE_BACKEND",
    "MINIO_BUCKET", "MINIO_ENDPOINT", "MINIO_SECURE", "MINIO_ACCESS_KEY", "MINIO_SECRET_KEY",
    "RECORDING_BUCKET",
    "S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY",
    "AZURE_STORAGE_CONNECTION_STRING", "AZURE_STORAGE_ACCOUNT_URL", "AZURE_STORAGE_CONTAINER",
)

_AZURE_URL = "https://acct.blob.core.windows.net"

_AZURE_CONN = (
    "DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=a2V5;"
    "EndpointSuffix=core.windows.net"
)


@pytest.fixture(autouse=True)
def _clean_storage_env(monkeypatch):
    for key in _STORAGE_ENV:
        monkeypatch.delenv(key, raising=False)


# ── the default is MinIO, byte for byte what 0.11 built (the rollback pin) ───────────────────────


def test_unset_backend_resolves_minio_with_the_shipped_defaults():
    """No STORAGE_BACKEND at all ⇒ the SAME S3Storage the pre-factory ``__main__`` built. This is
    the rollback contract: old env + this image behaves exactly as before."""
    storage = build_storage_from_env()
    assert isinstance(storage, S3Storage)
    assert storage._bucket == "vexa"
    assert storage._endpoint == "http://minio:9000"


def test_explicit_minio_backend_resolves_s3_storage(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "minio")
    assert isinstance(build_storage_from_env(), S3Storage)


def test_backend_value_is_case_and_whitespace_insensitive(monkeypatch):
    """Deploy surfaces interpolate (``${STORAGE_BACKEND:-minio}``); a stray space or capital must
    not fall through to the unknown-backend refusal and take the whole boot down."""
    monkeypatch.setenv("STORAGE_BACKEND", "  MinIO ")
    assert isinstance(build_storage_from_env(), S3Storage)
    monkeypatch.setenv("STORAGE_BACKEND", " Azure\n")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", _AZURE_CONN)
    assert isinstance(build_storage_from_env(), AzureBlobStorage)


# ── precedence: the factory reproduces the exact fallback chains __main__ carried ────────────────


def test_bucket_precedence_minio_then_recording_then_vexa(monkeypatch):
    monkeypatch.setenv("RECORDING_BUCKET", "from-recording")
    assert build_storage_from_env()._bucket == "from-recording"
    monkeypatch.setenv("MINIO_BUCKET", "from-minio")
    assert build_storage_from_env()._bucket == "from-minio", "MINIO_BUCKET must win"


def test_endpoint_precedence_s3_endpoint_wins_over_derived(monkeypatch):
    monkeypatch.setenv("MINIO_ENDPOINT", "minio.internal:9000")
    assert build_storage_from_env()._endpoint == "http://minio.internal:9000"
    monkeypatch.setenv("S3_ENDPOINT", "https://s3.example.com")
    assert build_storage_from_env()._endpoint == "https://s3.example.com"


def test_endpoint_is_derived_from_minio_secure(monkeypatch):
    monkeypatch.setenv("MINIO_ENDPOINT", "store:9000")
    monkeypatch.setenv("MINIO_SECURE", "true")
    assert build_storage_from_env()._endpoint == "https://store:9000"


def test_a_full_url_minio_endpoint_is_passed_through(monkeypatch):
    """MINIO_ENDPOINT is documented as host:port OR a full URL — a full URL must not be re-schemed."""
    monkeypatch.setenv("MINIO_ENDPOINT", "https://already.a.url:9000")
    assert build_storage_from_env()._endpoint == "https://already.a.url:9000"


def test_credential_precedence_s3_keys_win_over_minio_keys(monkeypatch):
    monkeypatch.setenv("MINIO_ACCESS_KEY", "minio-ak")
    monkeypatch.setenv("MINIO_SECRET_KEY", "minio-sk")
    storage = build_storage_from_env()
    assert (storage._access_key, storage._secret_key) == ("minio-ak", "minio-sk")
    monkeypatch.setenv("S3_ACCESS_KEY", "s3-ak")
    monkeypatch.setenv("S3_SECRET_KEY", "s3-sk")
    storage = build_storage_from_env()
    assert (storage._access_key, storage._secret_key) == ("s3-ak", "s3-sk")


# ── the azure branch ────────────────────────────────────────────────────────────────────────────


def test_azure_backend_resolves_azure_blob_storage(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", _AZURE_CONN)
    storage = build_storage_from_env()
    assert isinstance(storage, AzureBlobStorage)
    assert storage._container == "vexa", "the container default matches the MinIO bucket default"
    assert storage._conn == _AZURE_CONN


def test_azure_container_is_overridable(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", _AZURE_CONN)
    monkeypatch.setenv("AZURE_STORAGE_CONTAINER", "recordings")
    assert build_storage_from_env()._container == "recordings"


def test_azure_account_url_alone_resolves_managed_identity_mode(monkeypatch):
    """No connection string, an account URL: the keyless path a shared-key-disabled account needs."""
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", f"  {_AZURE_URL} ")
    storage = build_storage_from_env()
    assert isinstance(storage, AzureBlobStorage)
    assert storage._account_url == _AZURE_URL
    assert storage._conn is None
    assert storage._client is None, "resolving the identity path must not construct a credential"


def test_azure_connection_string_wins_over_account_url(monkeypatch):
    """Both set ⇒ the connection string, so adding the URL to an existing deployment changes nothing
    until the connection string is removed (the rollback is putting it back)."""
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", _AZURE_CONN)
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", _AZURE_URL)
    storage = build_storage_from_env()
    assert storage._conn == _AZURE_CONN
    assert storage._account_url is None


def test_azure_with_neither_refuses_naming_both_keys(monkeypatch):
    """A half-configured azure deployment must fail at BOOT naming the missing keys - not silently
    fall back to a MinIO that is not deployed and 500 on the first chunk upload."""
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    with pytest.raises(RuntimeError) as ei:
        build_storage_from_env()
    assert "AZURE_STORAGE_CONNECTION_STRING" in str(ei.value)
    assert "AZURE_STORAGE_ACCOUNT_URL" in str(ei.value)


def test_azure_with_blank_values_refuses(monkeypatch):
    """Compose's ``${VAR:-}`` sets an EMPTY string, not an absent var — empty must count as unset."""
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", "   ")
    monkeypatch.setenv("AZURE_STORAGE_ACCOUNT_URL", "")
    with pytest.raises(RuntimeError) as ei:
        build_storage_from_env()
    assert "AZURE_STORAGE_CONNECTION_STRING" in str(ei.value)
    assert "AZURE_STORAGE_ACCOUNT_URL" in str(ei.value)


@pytest.mark.parametrize("auth", [
    {},
    {"connection_string": _AZURE_CONN, "account_url": _AZURE_URL},
])
def test_azure_blob_storage_needs_exactly_one_auth_mode(auth):
    with pytest.raises(ValueError):
        AzureBlobStorage(container="vexa", **auth)


def test_unknown_backend_refuses_and_names_both_valid_values(monkeypatch):
    monkeypatch.setenv("STORAGE_BACKEND", "gcs")
    with pytest.raises(RuntimeError) as ei:
        build_storage_from_env()
    message = str(ei.value)
    assert "gcs" in message, "the refusal must quote what was actually configured"
    assert "minio" in message and "azure" in message


def test_the_factory_constructs_no_client(monkeypatch):
    """The offline guarantee this whole module depends on: resolving a backend touches no SDK and
    opens no socket, so a MinIO deployment needs no azure package and vice versa."""
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", _AZURE_CONN)
    assert build_storage_from_env()._client is None
    monkeypatch.setenv("STORAGE_BACKEND", "minio")
    assert build_storage_from_env()._client is None


# ── one var, one truth: the JSONB stamp and the dispatch cannot disagree ────────────────────────


async def test_the_jsonb_stamp_reads_the_same_var_the_factory_dispatches_on(monkeypatch):
    """``storage_backend`` in the recording's meeting.data JSONB is the field an operator reads to
    know WHERE a tape lives. It is stamped from STORAGE_BACKEND — the same var the factory
    dispatches on — so a recording can never claim minio while the bytes went to Azure."""
    from meeting_api.recordings import upload_chunk
    from meeting_api.recordings.fakes import InMemoryRecordingRepo, InMemoryStorage

    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", _AZURE_CONN)
    assert isinstance(build_storage_from_env(), AzureBlobStorage)

    repo = InMemoryRecordingRepo()
    repo.seed(meeting_id=1, user_id=7, session_uid="conn-abc")
    await upload_chunk(
        repo, InMemoryStorage(),
        token_meeting_id=1,
        session_uid="conn-abc", chunk_seq=0, data=b"\x00" * 8,
        media_type="audio", media_format="wav", is_final=False,
    )
    media_files = (await repo.get_recordings(1))[0]["media_files"]
    assert media_files[0]["storage_backend"] == "azure"
