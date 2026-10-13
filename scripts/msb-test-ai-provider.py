#!/usr/bin/env python3
"""Prove which AI provider and endpoint are actually used, with a real call.

Prints (never the key):
  - the explicitly selected provider (MSB_AI_PROVIDER),
  - the resolved base URL the SDK will POST to,
  - the model the API reports back,
  - a short real response generated from FICTIONAL content.

Usage:
    MSB_AI_PROVIDER=genspark python scripts/msb-test-ai-provider.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "artifacts/api-server/python_api"))

from ai_client import ai_api_key, ai_provider, ai_provider_label, build_ai_client  # noqa: E402

FICTIONAL = (
    "Rapport d'intervention FICTIF (données de test, aucune donnée réelle).\n"
    "Site : Immeuble de démonstration, 1 rue Fictive, 00000 Nullville.\n"
    "Objet : Contrôle de couverture.\n"
    "Constat : trois tuiles déplacées côté nord. Travaux : repositionnement des tuiles.\n"
)


def main() -> int:
    provider = ai_provider()
    print(f"provider          : {provider}  ({ai_provider_label()})")
    key = ai_api_key()
    print(f"api key present   : {bool(key)}  (value never printed)")
    if not key:
        print("BLOCKED: no API key for the selected provider.")
        return 2

    client = build_ai_client()
    base_url = str(getattr(client, "base_url", "?"))
    print(f"resolved base_url : {base_url}")

    response = client.messages.create(
        model="claude-sonnet-5-5",
        max_tokens=300,
        system="Tu reformules un constat de chantier en français, factuel, phrases courtes.",
        messages=[{"role": "user", "content": FICTIONAL}],
    )
    text = next((b.text for b in response.content if getattr(b, "type", "") == "text"), "")
    print(f"response.model    : {getattr(response, 'model', '?')}")
    print(f"response.id       : {getattr(response, 'id', '?')}")
    print(f"stop_reason       : {getattr(response, 'stop_reason', '?')}")
    print("--- short real response (fictional input) ---")
    print(text.strip()[:400])
    print("--- end ---")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
