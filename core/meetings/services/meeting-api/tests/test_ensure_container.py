"""``ensure_container`` — the out-of-band step every deployment needs before its first upload.

The unit tests pin backend SELECTION and the refusals (that is pure env dispatch). The idempotence
that actually matters — "already there" is a success, not an error — is settled against a real
Azurite in ``test_recordings_azurite_e2e.py``'s companion below, because a stubbed client would only
mirror this module's own assumptions about which exception the SDK raises.
"""
from __future__ import annotations

import socket

import pytest

from meeting_api.recordings import ensure_container

AZURITE_CONNECTION_STRING = (
    "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;"
    "AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;"
    "BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;"
)


def _azurite_ok() -> bool:
    try:
        import azure.storage.blob  # noqa: F401
    except ImportError:
        return False
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(2)
        return sock.connect_ex(("127.0.0.1", 10000)) == 0


# ── dispatch + refusals (no network) ──────────────────────────────────────────────────────────────

def test_azure_without_a_connection_string_refuses_and_names_the_key(monkeypatch, capsys):
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.delenv("AZURE_STORAGE_CONNECTION_STRING", raising=False)
    assert ensure_container.main() == 2
    assert "AZURE_STORAGE_CONNECTION_STRING" in capsys.readouterr().err


def test_unknown_backend_refuses(monkeypatch, capsys):
    monkeypatch.setenv("STORAGE_BACKEND", "gcs")
    assert ensure_container.main() == 2
    assert "gcs" in capsys.readouterr().err


def test_unset_backend_dispatches_to_minio_like_the_storage_factory(monkeypatch):
    """Same default as build_storage_from_env: unset means minio, so an operator rolling back to
    unchanged env keeps a working step."""
    seen = {}
    monkeypatch.delenv("STORAGE_BACKEND", raising=False)
    monkeypatch.setenv("MINIO_BUCKET", "tapes")
    monkeypatch.setattr(ensure_container, "ensure_minio", lambda **kw: seen.update(kw) or True)
    assert ensure_container.main() == 0
    assert seen["bucket"] == "tapes"


def test_azure_container_defaults_to_vexa(monkeypatch):
    seen = {}
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", "x")
    monkeypatch.delenv("AZURE_STORAGE_CONTAINER", raising=False)
    monkeypatch.setattr(ensure_container, "ensure_azure", lambda **kw: seen.update(kw) or True)
    assert ensure_container.main() == 0
    assert seen["container"] == "vexa"


# ── the real thing ────────────────────────────────────────────────────────────────────────────────

@pytest.mark.skipif(not _azurite_ok(), reason="no reachable Azurite on 127.0.0.1:10000")
def test_ensure_azure_creates_then_is_idempotent():
    """The property the callers depend on: running it on every redeploy is safe. First call creates,
    every later call reports already-present rather than raising."""
    from azure.storage.blob import BlobServiceClient

    name = "vexa-ensure-idem"
    service = BlobServiceClient.from_connection_string(AZURITE_CONNECTION_STRING)
    client = service.get_container_client(name)
    if client.exists():
        client.delete_container()
    try:
        assert ensure_container.ensure_azure(
            connection_string=AZURITE_CONNECTION_STRING, container=name) is True
        assert ensure_container.ensure_azure(
            connection_string=AZURITE_CONNECTION_STRING, container=name) is False
        assert client.exists()
    finally:
        if client.exists():
            client.delete_container()


@pytest.mark.skipif(not _azurite_ok(), reason="no reachable Azurite on 127.0.0.1:10000")
def test_main_end_to_end_against_azurite(monkeypatch, capsys):
    from azure.storage.blob import BlobServiceClient

    name = "vexa-ensure-main"
    monkeypatch.setenv("STORAGE_BACKEND", "azure")
    monkeypatch.setenv("AZURE_STORAGE_CONNECTION_STRING", AZURITE_CONNECTION_STRING)
    monkeypatch.setenv("AZURE_STORAGE_CONTAINER", name)
    client = BlobServiceClient.from_connection_string(
        AZURITE_CONNECTION_STRING).get_container_client(name)
    if client.exists():
        client.delete_container()
    try:
        assert ensure_container.main() == 0
        assert "created" in capsys.readouterr().out
        assert client.exists()
    finally:
        if client.exists():
            client.delete_container()
