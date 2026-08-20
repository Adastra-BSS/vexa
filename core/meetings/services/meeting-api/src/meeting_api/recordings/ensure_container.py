"""Create the recordings container/bucket if it is not already there — the ONE implementation of a
step every deployment needs and no deployment gets for free.

Why it exists at all: the ``Storage`` port deliberately has no "create the container" method. On a
real cloud account the container is INFRASTRUCTURE — it carries the retention/lifecycle policy, the
access tier and the network rules — so the application creating one on demand would quietly produce
an unmanaged store with none of that. The adapters therefore never create; they fail loudly against
a missing one.

That leaves every stack having to do it out-of-band before the first upload, or every recording
fails with ContainerNotFound / NoSuchBucket and the bot's audio is dropped after its flush timeout.
Compose ran an ``mc mb`` container, lite shelled out to ``mc``, and downstream deployments each grew
their own copy. This is that step, once, next to the adapters whose env it already shares:

    python -m meeting_api.recordings.ensure_container

Idempotent by construction — an existing container is a success, not an error — so it is safe as a
compose init container, a Makefile step, or a deploy-script line that runs on every redeploy.
"""
from __future__ import annotations

import os
import sys


def ensure_azure(*, connection_string: str, container: str) -> bool:
    """Create the Blob container. Returns True if it was created, False if it already existed."""
    from azure.core.exceptions import ResourceExistsError
    from azure.storage.blob import BlobServiceClient

    client = BlobServiceClient.from_connection_string(connection_string).get_container_client(container)
    created = True
    try:
        client.create_container()
    except ResourceExistsError:
        created = False
    if not client.exists():
        raise RuntimeError(f"azure container {container!r} is still absent after create")
    return created


def ensure_minio(*, bucket: str, endpoint_url: str | None,
                 access_key: str | None, secret_key: str | None) -> bool:
    """Create the S3/MinIO bucket. Returns True if it was created, False if it already existed."""
    import boto3
    from botocore.exceptions import ClientError

    client = boto3.client("s3", endpoint_url=endpoint_url,
                          aws_access_key_id=access_key, aws_secret_access_key=secret_key)
    try:
        client.head_bucket(Bucket=bucket)
        return False
    except ClientError:
        pass
    try:
        client.create_bucket(Bucket=bucket)
    except ClientError as exc:
        # Another replica winning the race is the SAME outcome we wanted, not a failure.
        if exc.response.get("Error", {}).get("Code") not in (
            "BucketAlreadyOwnedByYou", "BucketAlreadyExists",
        ):
            raise
        return False
    return True


def main(argv: list[str] | None = None) -> int:
    """Resolve the backend from the same env the adapters read, and ensure its container exists."""
    from .adapters import _minio_endpoint_url

    backend = (os.getenv("STORAGE_BACKEND") or "minio").strip().lower()
    if backend == "azure":
        conn = (os.getenv("AZURE_STORAGE_CONNECTION_STRING") or "").strip()
        if not conn:
            print("STORAGE_BACKEND=azure requires AZURE_STORAGE_CONNECTION_STRING (unset or empty)",
                  file=sys.stderr)
            return 2
        name = os.getenv("AZURE_STORAGE_CONTAINER") or "vexa"
        created = ensure_azure(connection_string=conn, container=name)
    elif backend == "minio":
        name = os.getenv("MINIO_BUCKET", os.getenv("RECORDING_BUCKET", "vexa"))
        created = ensure_minio(
            bucket=name,
            endpoint_url=os.getenv("S3_ENDPOINT") or _minio_endpoint_url(),
            access_key=os.getenv("S3_ACCESS_KEY") or os.getenv("MINIO_ACCESS_KEY"),
            secret_key=os.getenv("S3_SECRET_KEY") or os.getenv("MINIO_SECRET_KEY"),
        )
    else:
        print(f"unknown STORAGE_BACKEND {backend!r} — expected 'minio' or 'azure'", file=sys.stderr)
        return 2
    print(f"{backend}: container {name} {'created' if created else 'already present'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
