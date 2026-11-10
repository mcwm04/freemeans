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
    # A named User-Agent is needed: Groq sits behind Cloudflare, which answers 403 to the default "Python-urllib".
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers={
        "User-Agent": "FreemeansBot/1.0 (+https://freemeans.com)", "Accept": "application/json",
        **headers, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, json.loads(res.read().decode("utf-8")), ""
    except urllib.error.HTTPError as e:
        try:                                  # keep the provider's reason; it is never a secret
            detail = " ".join(e.read().decode("utf-8", "replace").split())[:160]
        except Exception:
            detail = ""
        return e.code, None, f"HTTP {e.code}" + (f" {detail}" if detail else "")
    except Exception as e:
        return None, None, f"{type(e).__name__}: {e}"[:200]


class NoProvider(Exception):
    pass


TRANSIENT = {None, 500, 502, 503, 504}      # overloaded or unreachable: worth another try
RETRY_WAITS = (5, 20)                        # seconds before the 2nd and 3rd attempt on one provider
COOLDOWN = 60                                # a 429 benches that provider for this long (limits are per minute)
WAIT_BUDGET = 20 * 60                        # total seconds one run may spend waiting, so the job stays under its timeout


class Drafter:
    """Returns parsed JSON from the first provider that answers with valid JSON.

    Free tiers are busy and rate-limited, so: transient errors (503, timeouts) are retried with short
    waits; a 429 benches the provider for a minute, not for the whole run; if every provider is benched
    the drafter waits for the earliest one (within WAIT_BUDGET) before giving up on this site.
    """

    def __init__(self, providers: list[Provider], post: Post = urllib_post, sleep=time.sleep, clock=time.monotonic):
        self.providers = providers
        self.post = post
        self.sleep = sleep
        self.clock = clock
        self.benched: dict[str, float] = {}  # provider -> clock time when it may be used again
        self.waited = 0.0
        self.calls: dict[str, int] = {}

    def _wait(self, seconds: float) -> bool:
        if seconds <= 0 or self.waited + seconds > WAIT_BUDGET:
            return False
        self.waited += seconds
        self.sleep(seconds)
        return True

    def _try(self, p: Provider, system: str, user: str, errors: list[str]):
        """Ask one provider, retrying transient errors. Returns (json, name), or None to move on."""
        body = {"model": p.model, "temperature": 0.1, "response_format": {"type": "json_object"},
                "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}]}
        for attempt in range(len(RETRY_WAITS) + 1):
            status, data, err = self.post(f"{p.base_url}/chat/completions", {"Authorization": f"Bearer {p.key}"}, body)
            self.calls[p.name] = self.calls.get(p.name, 0) + 1
            if status == 429:
                self.benched[p.name] = self.clock() + COOLDOWN
                errors.append(f"{p.name}: rate-limited")
                return None
            if status in TRANSIENT and attempt < len(RETRY_WAITS) and self._wait(RETRY_WAITS[attempt]):
                continue
            if status != 200 or not data:
                errors.append(f"{p.name}: {err or status}")
                return None
            try:
                text = data["choices"][0]["message"]["content"] or ""
                return json.loads(_strip_fences(text)), p.name
            except (KeyError, IndexError, TypeError, ValueError):
                errors.append(f"{p.name}: answer was not JSON")
                return None
        return None

    def complete_json(self, system: str, user: str) -> tuple[dict, str]:
        errors: list[str] = []
        for round_ in range(2):
            for p in self.providers:
                if self.benched.get(p.name, 0) > self.clock():
                    continue
                got = self._try(p, system, user, errors)
                if got:
                    return got
            # Nobody answered. If a provider is only resting, wait for it once and go round again.
            soonest = min((t - self.clock() for t in self.benched.values() if t > self.clock()), default=0)
            if round_ == 1 or not self._wait(soonest):
                break
        raise NoProvider("; ".join(errors) or "no LLM key configured (GROQ_API_KEY / GEMINI_API_KEY)")


def _strip_fences(text: str) -> str:
    t = text.strip()
    if t.startswith("```"):
        t = t.split("\n", 1)[1] if "\n" in t else t
        t = t.rsplit("```", 1)[0]
    return t.strip()
