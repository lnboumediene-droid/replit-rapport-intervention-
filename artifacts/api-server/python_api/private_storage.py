"""Pluggable private-object storage for MSB-BAT.

The original application stored every private file (source PDFs, generated PDFs
and photos) in Replit Object Storage, reached through the local Replit sidecar
on ``http://127.0.0.1:1106`` with external-account credentials. That sidecar
does not exist outside Replit, so the service could not even start here.

This module keeps the exact same application contract — objects are addressed
by their application path ``/objects/<relative>`` — but moves the byte
transport behind a small backend interface. Two backends are provided:

* ``GcsBackend``  — the original behaviour (Replit sidecar / any GCS-compatible
  endpoint), selected when ``MSB_STORAGE_BACKEND=gcs``.
* ``LocalBackend`` — a private directory on the server's own disk, selected by
  default. Files are laid out exactly like the export archive
  (``fichiers/prive/<relative>``), so the backup can be dropped straight in.

Nothing here makes objects public: the local root lives outside any served
directory, and the public Express server keeps enforcing identity + ACL before
streaming a private object. Only the transport changed, never the access rules.
"""

from __future__ import annotations

import os
import threading
from pathlib import Path
from typing import Protocol


class ObjectNotFound(Exception):
    """Raised when a private object does not exist in the backend."""


def bucket_and_key(private_object_dir: str, object_path: str) -> tuple[str, str]:
    """Split ``/objects/<rel>`` into ``(bucket, key)`` using the private root.

    Kept identical to the original implementation so that existing object paths
    keep their meaning across backends.
    """
    parts = private_object_dir.strip("/").split("/")
    if len(parts) < 2 or not object_path.startswith("/objects/"):
        raise RuntimeError("Invalid private object path")
    bucket = parts[0]
    key = "/".join(parts[1:] + [object_path.removeprefix("/objects/")])
    return bucket, key


class StorageBackend(Protocol):
    def download(self, object_path: str) -> bytes: ...
    def upload(self, object_path: str, content: bytes, content_type: str) -> None: ...
    def delete(self, object_path: str) -> None: ...


class LocalBackend:
    """Private files stored under a local directory (default backend).

    The relative part of ``/objects/<rel>`` maps to ``<root>/<rel>``. When the
    root is the extracted backup's ``fichiers/prive`` directory, every exported
    file is found at its original application path with no rewriting.
    """

    def __init__(self, root: str) -> None:
        if not root:
            raise RuntimeError(
                "MSB_PRIVATE_STORAGE_DIR is required for the local storage backend"
            )
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def _target(self, object_path: str) -> Path:
        if not object_path.startswith("/objects/"):
            raise ObjectNotFound(object_path)
        relative = object_path.removeprefix("/objects/").lstrip("/")
        target = (self.root / relative).resolve()
        # Defence in depth: never allow a crafted object path to escape the root.
        if target != self.root and self.root not in target.parents:
            raise ObjectNotFound(object_path)
        return target

    def download(self, object_path: str) -> bytes:
        target = self._target(object_path)
        if not target.is_file():
            raise ObjectNotFound(object_path)
        return target.read_bytes()

    def upload(self, object_path: str, content: bytes, content_type: str) -> None:
        del content_type  # The local filesystem does not persist a content type.
        target = self._target(object_path)
        with self._lock:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)

    def delete(self, object_path: str) -> None:
        target = self._target(object_path)
        with self._lock:
            try:
                target.unlink()
            except FileNotFoundError:
                # Already removed is a successful cleanup, not a failed deletion.
                pass


class GcsBackend:
    """Original Replit Object Storage transport (external-account credentials)."""

    def __init__(self, private_object_dir: str) -> None:
        self.private_object_dir = private_object_dir
        self._client = None
        self._lock = threading.Lock()

    def _gcs(self):
        if self._client is None:
            from google.auth import load_credentials_from_dict
            from google.cloud import storage

            credentials = load_credentials_from_dict(
                {
                    "type": "external_account",
                    "audience": "replit",
                    "subject_token_type": "access_token",
                    "token_url": "http://127.0.0.1:1106/token",
                    "credential_source": {
                        "url": "http://127.0.0.1:1106/credential",
                        "format": {
                            "type": "json",
                            "subject_token_field_name": "access_token",
                        },
                    },
                    "universe_domain": "googleapis.com",
                }
            )[0]
            self._client = storage.Client(project="", credentials=credentials)
        return self._client

    def download(self, object_path: str) -> bytes:
        from google.cloud.exceptions import NotFound

        bucket, key = bucket_and_key(self.private_object_dir, object_path)
        try:
            return self._gcs().bucket(bucket).blob(key).download_as_bytes()
        except NotFound as exc:
            raise ObjectNotFound(object_path) from exc

    def upload(self, object_path: str, content: bytes, content_type: str) -> None:
        bucket, key = bucket_and_key(self.private_object_dir, object_path)
        self._gcs().bucket(bucket).blob(key).upload_from_string(
            content, content_type=content_type
        )

    def delete(self, object_path: str) -> None:
        from google.cloud.exceptions import NotFound

        bucket, key = bucket_and_key(self.private_object_dir, object_path)
        try:
            self._gcs().bucket(bucket).blob(key).delete(timeout=10, retry=None)
        except NotFound:
            # Already removed is a successful cleanup, not a failed deletion.
            pass


def build_backend() -> StorageBackend:
    """Select the private-storage backend from the environment.

    ``MSB_STORAGE_BACKEND=gcs`` restores the original Replit transport. The
    default is the local backend, which needs no sidecar and starts anywhere.
    """
    backend = os.environ.get("MSB_STORAGE_BACKEND", "local").strip().lower()
    if backend == "gcs":
        return GcsBackend(os.environ.get("PRIVATE_OBJECT_DIR", ""))
    if backend == "local":
        root = os.environ.get("MSB_PRIVATE_STORAGE_DIR")
        if not root:
            data_dir = os.environ.get("MSB_DATA_DIR")
            if not data_dir:
                # Default to a private directory beside the project, never inside
                # a served/public path.
                data_dir = str(Path(__file__).resolve().parents[3] / "msb-data")
            root = os.path.join(data_dir, "private")
        return LocalBackend(root)
    raise RuntimeError(f"Unknown MSB_STORAGE_BACKEND: {backend!r}")
