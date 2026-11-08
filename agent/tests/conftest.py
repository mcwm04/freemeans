from __future__ import annotations

from pathlib import Path
from typing import Any

import pytest
import yaml

from freemeans.config import load_config
from freemeans.meter import Meter
from freemeans.router import Router
from freemeans.transport import ProviderResponse

AGENT = Path(__file__).resolve().parents[1]
REPO = AGENT.parent


class Clock:
    def __init__(self, t: float = 1_794_000_000.0):  # 2026-11-08 (UTC)
        self.t = t

    def __call__(self) -> float:
        return self.t

    def advance(self, s: float) -> None:
        self.t += s


class FakeTransport:
    """Returns scripted responses per deployment; records calls."""

    def __init__(self) -> None:
        self.script: dict[str, list[ProviderResponse]] = {}
        self.calls: list[str] = []

    def push(self, dep: str, status: int, body: dict[str, Any] | None = None, headers: dict[str, str] | None = None):
        self.script.setdefault(dep, []).append(ProviderResponse(status, body or {}, headers or {}))

    async def chat(self, dep, body):
        self.calls.append(dep.name)
        queue = self.script.get(dep.name)
        if queue:
            return queue.pop(0)
        return ProviderResponse(200, ok_body(dep.model), {})


def ok_body(model: str = "m", tokens: int = 100) -> dict[str, Any]:
    return {"id": "x", "object": "chat.completion", "model": model,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": "hi"}, "finish_reason": "stop"}],
            "usage": {"prompt_tokens": tokens // 2, "completion_tokens": tokens // 2, "total_tokens": tokens}}


@pytest.fixture
def config_path(tmp_path: Path) -> Path:
    raw = yaml.safe_load((AGENT / "freemeans.example.yaml").read_text())
    raw["catalog"] = str(REPO / "data" / "catalog" / "seed.json")
    raw["db_path"] = str(tmp_path / "usage.sqlite3")
    p = tmp_path / "freemeans.yaml"
    p.write_text(yaml.safe_dump(raw))
    return p


@pytest.fixture
def keys(monkeypatch):
    for k in ("GROQ_API_KEY", "GEMINI_API_KEY", "OPENROUTER_API_KEY"):
        monkeypatch.setenv(k, "test-key")


@pytest.fixture
def clock() -> Clock:
    return Clock()


@pytest.fixture
def setup(config_path, keys, clock):
    cfg = load_config(config_path)
    meter = Meter(cfg.db_path, now=clock)
    transport = FakeTransport()
    router = Router(cfg, meter, transport, now=clock)
    return cfg, meter, transport, router
