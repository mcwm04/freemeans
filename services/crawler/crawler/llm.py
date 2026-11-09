"""LLM drafting through OpenAI-compatible chat endpoints: Groq first, Google Gemini as fallback
when Groq is rate-limited, down or returns unusable output (PRD 7.3, decided 9 Nov 2026).

Keys come from GROQ_API_KEY and GEMINI_API_KEY. A provider without a key is skipped.
Model names are settings (GROQ_MODEL, GEMINI_MODEL) because free-tier models change.
"""
from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable

TIMEOUT = 60


@dataclass
class Provider:
    name: str
    base_url: str
    model: str
    key: str


def providers_from_env() -> list[Provider]:
    out = []
    if os.environ.get("GROQ_API_KEY"):
        out.append(Provider("groq", "https://api.groq.com/openai/v1", os.environ.get("GROQ_MODEL", "openai/gpt-oss-120b"), os.environ["GROQ_API_KEY"]))
    if os.environ.get("GEMINI_API_KEY"):
        out.append(Provider("gemini", "https://generativelanguage.googleapis.com/v1beta/openai",
                            os.environ.get("GEMINI_MODEL", "gemini-3.8-flash"), os.environ["GEMINI_API_KEY"]))
    return out


Post = Callable[[str, dict, dict], tuple[int | None, dict | None, str]]


def urllib_post(url: str, headers: dict, body: dict) -> tuple[int | None, dict | None, str]:
    req = urllib.request.Request(url, data=json.dumps(body).encode(), headers={**headers, "Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, json.loads(res.read().decode("utf-8")), ""
    except urllib.error.HTTPError as e:
        return e.code, None, f"HTTP {e.code}"
    except Exception as e:
        return None, None, f"{type(e).__name__}: {e}"[:200]


class NoProvider(Exception):
    pass


class Drafter:
    """Returns parsed JSON from the first provider that answers with valid JSON."""

    def __init__(self, providers: list[Provider], post: Post = urllib_post, sleep=time.sleep):
        self.providers = providers
        self.post = post
        self.sleep = sleep
        self.paused: set[str] = set()       # providers that rate-limited us this run
        self.calls: dict[str, int] = {}

    def complete_json(self, system: str, user: str) -> tuple[dict, str]:
        errors = []
        for p in self.providers:
            if p.name in self.paused:
                continue
            body = {"model": p.model, "temperature": 0.1, "response_format": {"type": "json_object"},
                    "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
            status, data, err = self.post(f"{p.base_url}/chat/completions", {"Authorization": f"Bearer {p.key}"}, body)
            self.calls[p.name] = self.calls.get(p.name, 0) + 1
            if status == 429:
                self.paused.add(p.name)
                errors.append(f"{p.name}: rate-limited")
                continue
            if status != 200 or not data:
                errors.append(f"{p.name}: {err or status}")
                continue
            try:
                text = data["choices"][0]["message"]["content"] or ""
                return json.loads(_strip_fences(text)), p.name
            except (KeyError, IndexError, TypeError, ValueError):
                errors.append(f"{p.name}: answer was not JSON")
        raise NoProvider("; ".join(errors) or "no LLM key configured (GROQ_API_KEY / GEMINI_API_KEY)")


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        t = t.rsplit("```", 1)[0]
    return t.strip()
