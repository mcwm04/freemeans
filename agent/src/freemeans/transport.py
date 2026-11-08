"""How the router talks to providers.

The prototype calls each provider's OpenAI-compatible endpoint directly, so it
can read every rate-limit header. A LiteLLM-backed transport can replace this
class later (same interface) to reach providers without such an endpoint.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import httpx

from .config import Deployment
from .keys import get_key


@dataclass
class ProviderResponse:
    status: int
    body: dict[str, Any]
    headers: dict[str, str]


class Transport(Protocol):
    async def chat(self, dep: Deployment, body: dict[str, Any]) -> ProviderResponse: ...


class HttpxTransport:
    def __init__(self, timeout: float = 60.0, client: httpx.AsyncClient | None = None):
        self._client = client or httpx.AsyncClient(timeout=timeout)

    async def chat(self, dep: Deployment, body: dict[str, Any]) -> ProviderResponse:
        base = (dep.resource.base_url or "").rstrip("/")
        url = f"{base}/chat/completions"
        headers = {"Authorization": f"Bearer {get_key(dep.key_env)}", "Content-Type": "application/json"}
        if dep.provider == "OpenRouter":
            headers["X-Title"] = "Freemeans local agent"
        payload = {**body, "model": dep.model}
        resp = await self._client.post(url, json=payload, headers=headers)
        try:
            data = resp.json()
        except ValueError:
            data = {"error": {"message": resp.text[:500]}}
        return ProviderResponse(resp.status_code, data, dict(resp.headers))

    async def aclose(self) -> None:
        await self._client.aclose()
