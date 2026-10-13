#!/usr/bin/env python3
"""Restore the MSB-BAT private storage from the files uploaded by the user.

The user delivered the private backup as loose files (generated report PDFs,
upload objects, photos). This script maps every uploaded file to its manifest
object in ``donnees/fichiers.json`` **by SHA-256** and writes it to the private
storage root at its exact ``/objects/<relative_path>`` location.

Three sources are supported:

1. **Direct copies** — uploaded files whose SHA-256 already equals a manifest
   object (report PDFs, upload objects, source PDFs). Copied verbatim.
2. **Seed demo photos** — ``demo-toiture-*.jpg`` are regenerated with the exact
   seed transform (thumbnail 1600, JPEG q=80, optimize) from
   ``attached_assets/generated_images``.
3. **Imported PDF photos** — ``imports/<id>/photos/photo-N.jpg`` are re-extracted
   from the original source PDF using the application pipeline
   (``pdf_import_processing.extract_pdf``), so the bytes match the originals.

Every restored file is verified against the recorded SHA-256. Objects that
cannot be reproduced (e.g. the two references the export already flagged as
missing) are reported verbatim — never invented.

Usage (from the workspace root):

    python scripts/msb-restore-from-uploads.py \
        --uploads /home/user/uploaded_files \
        --root msb-data/private
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PY_API = ROOT / "artifacts/api-server/python_api"

# Uploaded helper files that are not private objects.
IGNORED_UPLOAD_NAMES = {
    "CONTROLES-SHA256.json.txt", "CONTROLES-SHA256.json",
    "LIRE-MOI.md", "MANIFESTE.json.txt", "MANIFESTE.json",
    "PROMPT-GENSPARK.md", "PROMPT-GENSPARK (2).md",
    "development.json.txt", "development.json", "development.sql",
    "production.json.txt", "production.json", "production.sql",
    "fichiers.json.txt", "fichiers.json", "VERIFICATION.json.txt",
}


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_names(manifest: dict, override: list[str] | None) -> list[str]:
    if override:
        return override
    names: list[str] = []
    prod = ROOT / "donnees/production.json"
    if prod.is_file():
        try:
            data = json.loads(prod.read_text(encoding="utf-8"))
            for row in data.get("tables", {}).get("msb_erased_names", []):
                if row.get("active", True) and row.get("name"):
                    names.append(row["name"])
        except Exception:
            pass
    return names or ["SRP"]


def index_uploads(uploads: Path) -> dict[str, Path]:
    """Map SHA-256 -> uploaded file path (first seen wins)."""
    by_sha: dict[str, Path] = {}
    if not uploads.is_dir():
        return by_sha
    for path in sorted(uploads.iterdir()):
        if not path.is_file() or path.name in IGNORED_UPLOAD_NAMES:
            continue
        by_sha.setdefault(sha256_file(path), path)
    return by_sha


def reproduce_demo_photos(manifest_objs: list[dict]) -> dict[str, bytes]:
    """Regenerate the seeded demo photos; return relative_path -> jpeg bytes."""
    from PIL import Image, ImageOps  # local import: only needed here

    written: dict[str, bytes] = {}
    for obj in manifest_objs:
        rel = obj["relative_path"]
        if "photos/" not in rel or "/demo-toiture-" not in rel:
            continue
        filename = Path(rel).name
        source = ROOT / "attached_assets/generated_images" / filename
        if not source.is_file():
            continue
        with Image.open(source) as source_image:
            image = ImageOps.exif_transpose(source_image).convert("RGB")
            image.thumbnail((1600, 1600))
            buffer = io.BytesIO()
            image.save(buffer, format="JPEG", quality=80, optimize=True)
        data = buffer.getvalue()
        if sha256_bytes(data) == obj["sha256"]:
            written[rel] = data
    return written


def reproduce_import_photos(
    manifest_objs: list[dict], by_sha: dict[str, Path], names: list[str]
) -> dict[str, bytes]:
    """Re-extract imported PDF photos; return relative_path -> jpeg bytes."""
    if not PY_API.is_dir():
        return {}
    sys.path.insert(0, str(PY_API))
    from pdf_import_processing import extract_pdf  # type: ignore

    # index manifest objects by sha so we can find a source PDF's bytes
    obj_by_sha: dict[str, dict] = {}
    for obj in manifest_objs:
        obj_by_sha.setdefault(obj["sha256"], obj)

    def raw_for(sha: str) -> bytes | None:
        path = by_sha.get(sha)
        return path.read_bytes() if path else None

    # collect the distinct source PDFs referenced by the import photo objects
    import_ids = {
        rel.split("/")[1]
        for obj in manifest_objs
        if (rel := obj["relative_path"]).startswith("imports/") and "/photos/" in rel
    }

    extracted: dict[str, bytes] = {}
    for import_id in sorted(import_ids):
        # locate the source PDF object for this import (sources/ or uploads/)
        source_obj = next(
            (
                obj
                for obj in manifest_objs
                if obj["content_type"] == "application/pdf"
                and (
                    obj["relative_path"].endswith(f"sources/{import_id}.pdf")
                    or obj["relative_path"] == f"uploads/{import_id}"
                )
            ),
            None,
        )
        if source_obj is None:
            continue
        raw = raw_for(source_obj["sha256"])
        if raw is None:
            continue
        result = extract_pdf(raw, names)
        for photo in result["photos"]:
            extracted[f"imports/{import_id}/photos/{photo['id']}.jpg"] = photo["bytes"]
    return extracted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=str(ROOT / "donnees/fichiers.json"))
    parser.add_argument("--uploads", default="/home/user/uploaded_files")
    parser.add_argument("--root", default=str(ROOT / "msb-data/private"))
    parser.add_argument("--names", nargs="*", default=None,
                        help="Erased vendor names for the de-identification pass.")
    parser.add_argument("--check", action="store_true", help="Verify only; write nothing.")
    args = parser.parse_args()

    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    objects = manifest["objects"]
    root = Path(args.root)
    by_sha = index_uploads(Path(args.uploads))
    names = load_names(manifest, args.names)

    stats = {"copied": 0, "reproduced": 0, "already_ok": 0, "mismatch": 0}
    missing: list[dict] = []

    # --- sources 1: direct copies -------------------------------------------------
    direct: dict[str, bytes] = {}
    for obj in objects:
        source = by_sha.get(obj["sha256"])
        if source is not None:
            direct[obj["relative_path"]] = source.read_bytes()

    # --- sources 2 & 3: reproductions --------------------------------------------
    reproduced: dict[str, bytes] = {}
    if not args.check:
        reproduced.update(reproduce_demo_photos(objects))
        reproduced.update(reproduce_import_photos(objects, by_sha, names))

    for obj in objects:
        rel = obj["relative_path"]
        target = root / rel
        expected = obj["sha256"]

        if target.is_file() and sha256_file(target) == expected:
            stats["already_ok"] += 1
            continue

        data = direct.get(rel)
        kind = "copied"
        if data is None:
            data = reproduced.get(rel)
            kind = "reproduced"
        if data is None:
            missing.append(obj)
            continue
        if sha256_bytes(data) != expected:
            stats["mismatch"] += 1
            print(f"SHA-256 mismatch after restore: {rel}", file=sys.stderr)
            continue
        if not args.check:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
        stats[kind] += 1

    report = {
        "objects_in_manifest": len(objects),
        "already_present_ok": stats["already_ok"],
        "copied_from_uploads": stats["copied"],
        "reproduced_from_sources": stats["reproduced"],
        "sha256_mismatch": stats["mismatch"],
        "still_missing": len(missing),
        "still_missing_objects": [
            {"relative_path": o["relative_path"], "bytes": o["bytes"], "sha256": o["sha256"]}
            for o in missing
        ],
        "recorded_missing_references": manifest.get("missing_references", {}),
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if stats["mismatch"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
