"""Explicit, deterministic AI provider selection for the MSB-BAT app.

The provider is chosen ONLY by the ``MSB_AI_PROVIDER`` environment variable:

  * ``anthropic`` (default) — direct Claude. The base URL is set explicitly to
    ``https://api.anthropic.com`` (or ``ANTHROPIC_BASE_URL`` if the operator set
    it on purpose), and the key comes from ``ANTHROPIC_API_KEY``.
  * ``genspark`` — Claude through the Genspark Anthropic-compatible proxy. The
    base URL and key come from the Genspark secrets (``MSB_GENSPARK_API_KEY``,
    else ``ANTHROPIC_API_KEY``).

Why this module exists
----------------------
The Anthropic SDK silently reads an ambient ``ANTHROPIC_BASE_URL`` from the
environment when ``base_url`` is not passed explicitly. That made the provider
change with the surrounding environment — an implicit switch. Here the base URL
is ALWAYS passed explicitly, so the provider can only change when
``MSB_AI_PROVIDER`` is set deliberately. There is no silent fallback: if the
selected provider has no key, the request fails loudly (HTTP 503) instead of
quietly using another provider.

The provider label is exposed through ``/healthz`` so the active choice is
always observable.
"""
from __future__ import annotations

import os

from anthropic import Anthropic

ANTHROPIC_DIRECT_BASE_URL = "https://api.anthropic.com"
GENSPARK_ANTHROPIC_BASE_URL = "https://www.genspark.ai/api/anthropic"
DEFAULT_PROVIDER = "anthropic"
PROVIDERS = ("anthropic", "genspark")

LABELS = {
    "anthropic": "Claude direct (Anthropic)",
    "genspark": "Genspark (proxy Claude)",
}


def ai_provider() -> str:
    """Return the explicitly configured provider (default: direct Claude)."""
    provider = (os.environ.get("MSB_AI_PROVIDER") or DEFAULT_PROVIDER).strip().lower()
    return provider if provider in PROVIDERS else DEFAULT_PROVIDER


def ai_provider_label() -> str:
    return LABELS[ai_provider()]


def ai_api_key() -> str | None:
    """Return the key for the selected provider, or ``None`` when unset."""
    if ai_provider() == "genspark":
        return os.environ.get("MSB_GENSPARK_API_KEY") or os.environ.get("ANTHROPIC_API_KEY")
    return os.environ.get("ANTHROPIC_API_KEY")


def build_ai_client() -> Anthropic:
    """Build an Anthropic client bound to the explicitly selected provider.

    The base URL is ALWAYS passed explicitly and NEVER read from the ambient
    ``ANTHROPIC_BASE_URL`` (which the surrounding environment may inject). Only a
    deliberate ``MSB_AI_BASE_URL`` override is honoured, so the provider can
    change solely by setting ``MSB_AI_PROVIDER``.
    """
    provider = ai_provider()
    override = os.environ.get("MSB_AI_BASE_URL")
    if provider == "genspark":
        base_url = override or GENSPARK_ANTHROPIC_BASE_URL
    else:
        base_url = override or ANTHROPIC_DIRECT_BASE_URL
    return Anthropic(api_key=ai_api_key(), base_url=base_url)
