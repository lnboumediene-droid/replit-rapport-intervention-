#!/usr/bin/env python3
"""Restore / verify MSB-BAT private files against ``donnees/fichiers.json``.

The private backup is laid out as ``fichiers/prive/<relative_path>``. This script
copies (or, with ``--check``, only verifies) each referenced object into the
private storage root used by the FastAPI service, preserving the application
``/objects/<relative_path>`` path and checking the SHA-256 from the export.

Usage (from the workspace root):

    # Verify only (no writes) — safe to run any time
    python scripts/msb-restore-files.py --check

    # Copy files from an extracted backup into the private storage root
    python scripts/msb-restore-files.py \
        --source fichiers/prive \
        --root msb-data/private

Never prints credentials. Reports missing references exactly as recorded in
``fichiers.json`` (their contents are not invented or replaced).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        default=str(ROOT / "donnees/fichiers.json"),
        help="Path to fichiers.json",
    )
    parser.add_argument(
        "--source",
        default=None,
        help="Directory holding the extracted private files (fichiers/prive). "
        "When omitted, files are only verified in --root.",
    )
    parser.add_argument(
        "--root",
        default=str(ROOT / "msb-data/private"),
        help="Private storage root (destination or verification target).",
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Only verify; do not copy any file.",
    )
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.is_file():
        print(f"Manifest not found: {manifest_path}", file=sys.stderr)
        return 2
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    root = Path(args.root)
    source = Path(args.source) if args.source else None

    ok = missing = mismatch = copied = 0
    for obj in data.get("objects", []):
        relative = obj["relative_path"]
        target = root / relative
        expected = obj.get("sha256")

        if not target.is_file() and source is not None and not args.check:
            src = source / relative
            if src.is_file():
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(src, target)
                copied += 1

        if not target.is_file():
            missing += 1
            continue
        if expected and sha256(target) != expected:
            mismatch += 1
            print(f"SHA-256 mismatch: {relative}")
        else:
            ok += 1

    print(
        json.dumps(
            {
                "objects_in_manifest": len(data.get("objects", [])),
                "verified_ok": ok,
                "copied": copied,
                "missing_files": missing,
                "sha256_mismatch": mismatch,
                "recorded_missing_references": data.get("missing_references", {}),
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0 if mismatch == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
