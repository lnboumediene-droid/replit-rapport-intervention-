#!/usr/bin/env python3
"""Verify the MSB-BAT import against ``donnees/CONTROLES-SHA256.json``.

Checks three groups and prints a clear summary:

* ``code/*``          — the imported source tree.
* ``fichiers/prive/*`` — the private files (PDF/photos), when present.
* everything else      — top-level docs and ``donnees/*`` exports.

Files changed on purpose during the Genspark reprise (the documented
adaptations) are listed separately so a real, unintended drift is obvious.

Usage (from the workspace root):

    python scripts/msb-verify-integrity.py
    python scripts/msb-verify-integrity.py --private-root fichiers/prive
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

# Adaptations made on purpose during the reprise (see the PR description).
INTENTIONAL = {
    ".gitignore",
    "artifacts/api-server/python_api/main.py",
    "artifacts/api-server/python_api/test_report_deletion.py",
    "artifacts/api-server/src/app.ts",
    "artifacts/api-server/src/routes/index.ts",
    "artifacts/api-server/src/routes/storage.ts",
    "artifacts/msb-rapports/src/App.tsx",
    "artifacts/msb-rapports/vite.config.ts",
}

# Regenerable environment artifacts that legitimately differ after a local
# install/build (build caches and a generated file) — not real drift.
ENVIRONMENT_ARTIFACTS = {
    "artifacts/api-server/.tsbuildinfo",
    "artifacts/mockup-sandbox/.tsbuildinfo",
    "artifacts/mockup-sandbox/src/.generated/mockup-components.ts",
}


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--manifest",
        default=str(ROOT / "donnees/CONTROLES-SHA256.json"),
        help="Path to CONTROLES-SHA256.json",
    )
    parser.add_argument(
        "--private-root",
        default=str(ROOT / "msb-data/private"),
        help="Where the private files (fichiers/prive) live.",
    )
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    if not manifest_path.is_file():
        print(f"Manifest not found: {manifest_path}", file=sys.stderr)
        return 2
    entries = json.loads(manifest_path.read_text(encoding="utf-8"))
    private_root = Path(args.private_root)

    def target_for(key: str) -> Path:
        if key.startswith("code/"):
            return ROOT / key[len("code/"):]
        if key.startswith("fichiers/prive/"):
            return private_root / key[len("fichiers/prive/"):]
        # Top-level docs and donnees/* are expected under donnees/.
        return ROOT / "donnees" / key

    groups = {"code": [0, 0, 0, 0], "private": [0, 0, 0, 0], "other": [0, 0, 0, 0]}
    intentional_seen: list[str] = []
    environment_seen: list[str] = []
    unexpected: list[str] = []
    missing: list[str] = []

    for key, expected in entries.items():
        group = (
            "code"
            if key.startswith("code/")
            else "private"
            if key.startswith("fichiers/prive/")
            else "other"
        )
        target = target_for(key)
        if not target.is_file():
            groups[group][3] += 1
            missing.append(key)
            continue
        if sha256(target) == expected:
            groups[group][0] += 1
            continue
        relative = key[len("code/"):] if key.startswith("code/") else key
        if relative in INTENTIONAL:
            intentional_seen.append(key)
            continue
        if relative in ENVIRONMENT_ARTIFACTS:
            environment_seen.append(key)
            continue
        groups[group][1] += 1
        unexpected.append(key)

    def line(name: str, g: list[int]) -> str:
        ok, changed, _, miss = g
        return f"  {name:9s} match={ok:3d}  changed={changed:2d}  missing={miss:3d}"

    print("Integrity vs CONTROLES-SHA256.json")
    print(line("code", groups["code"]))
    print(line("private", groups["private"]))
    print(line("other", groups["other"]))
    print(f"  intentional adaptations: {len(intentional_seen)}")
    if unexpected:
        print("\nUNEXPECTED differences (investigate):")
        for item in sorted(unexpected):
            print("  -", item)
    if missing:
        print("\nMissing (not provided / not yet restored):")
        for item in sorted(missing):
            print("  -", item)

    # Non-zero only when something drifted unexpectedly.
    return 1 if unexpected else 0


if __name__ == "__main__":
    raise SystemExit(main())
