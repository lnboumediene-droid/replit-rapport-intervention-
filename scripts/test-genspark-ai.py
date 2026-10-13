"""Verify the app's Anthropic call path actually reaches the Genspark proxy.

Reads ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL from the environment exactly like
the application does (the Anthropic SDK honours ANTHROPIC_BASE_URL by default),
and performs one real generation. Prints the outcome so the switch can be judged
on evidence, never on assumption.
"""
import json
import os
import sys

from anthropic import Anthropic

base_url = os.environ.get("ANTHROPIC_BASE_URL")
key = os.environ.get("ANTHROPIC_API_KEY")
print("base_url host:", base_url.split("/")[2] if base_url else None)
print("key prefix:", (key or "")[:6] + "...")

client = Anthropic(api_key=key)  # SDK picks up ANTHROPIC_BASE_URL automatically.

model = os.environ.get("MSB_AI_MODEL", "claude-sonnet-5-5")
try:
    response = client.messages.create(
        model=model,
        max_tokens=64,
        system="Réponds uniquement par un objet JSON valide, sans texte autour.",
        messages=[{"role": "user", "content": "Retourne {\"ok\": true}."}],
    )
    text = next((b.text for b in response.content if b.type == "text"), "")
    print("MODEL:", model)
    print("RESPONSE:", text.strip())
    print("RESULT: SUCCESS")
except Exception as exc:  # noqa: BLE001 - report the real failure verbatim
    print("MODEL:", model)
    print("RESULT: FAILED")
    print("ERROR TYPE:", type(exc).__name__)
    print("ERROR:", str(exc)[:600])
    sys.exit(1)
