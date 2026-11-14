"""Polite JSON-over-HTTPS client shared by every source.

- Honest user agent with a contact address (Wikimedia requires one).
- A short pause between calls to the same host.
- Retries with back-off on 5xx and network errors.
- After 3 rate-limit answers (429) from one host, that host is closed for the rest of the run
  (PRD 7.7: "stop a source for the day after repeated 429").
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Callable
from urllib.parse import urlsplit

USER_AGENT = "FreemeansBot/1.0 (+https://freemeans.com/bot; hello@freemeans.com) freemeans-signals/0.1"
TIMEOUT = 20
MAX_BYTES = 20_000_000


@dataclass
class Response:
    status: int | None          # None = network error before any HTTP answer
    data: object = None         # parsed JSON, or None
    error: str | None = None
    headers: dict | None = None

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300 and self.error is None


class HostClosed(Exception):
    """The host rate-limited us repeatedly; skip it for the rest of this run."""


Transport = Callable[[str, dict], Response]


def urllib_transport(url: str, headers: dict) -> Response:
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read(MAX_BYTES)
            hdrs = {k.lower(): v for k, v in res.headers.items()}
            try:
                return Response(res.status, json.loads(raw.decode("utf-8")), headers=hdrs)
            except ValueError as e:
                return Response(res.status, None, f"not JSON: {e}"[:200], hdrs)
    except urllib.error.HTTPError as e:
        hdrs = {k.lower(): v for k, v in (e.headers or {}).items()}
        try:                                  # GitHub explains its 403s in the body; keep the reason
            detail = " ".join(json.loads(e.read().decode("utf-8", "replace")).get("message", "").split())[:160]
        except Exception:
            detail = ""
        return Response(e.code, None, f"HTTP {e.code}" + (f" {detail}" if detail else ""), hdrs)
    except Exception as e:  # DNS, timeout, TLS
        return Response(None, None, f"{type(e).__name__}: {e}"[:200])


class Http:
    def __init__(self, transport: Transport = urllib_transport, *, pause: float = 0.25,
                 retries: int = 2, backoff: float = 2.0, max_429: int = 3,
                 sleep: Callable[[float], None] = time.sleep):
        self.transport = transport
        self.pause = pause
        self.retries = retries
        self.backoff = backoff
        self.max_429 = max_429
        self.sleep = sleep
        self._last: dict[str, float] = {}
        self._429: dict[str, int] = {}
        self.calls = 0
        self.closed_hosts: set[str] = set()

    def get_json(self, url: str, headers: dict | None = None) -> Response:
        host = urlsplit(url).hostname or ""
        if host in self.closed_hosts:
            raise HostClosed(host)
        hdrs = {"User-Agent": USER_AGENT, "Accept": "application/json"}
        hdrs.update(headers or {})
        attempt = 0
        while True:
            wait = self.pause - (time.monotonic() - self._last.get(host, 0.0))
            if wait > 0:
                self.sleep(wait)
            self._last[host] = time.monotonic()
            self.calls += 1
            res = self.transport(url, hdrs)
            if res.status == 429 or (res.status == 403 and _is_rate_limit(res)):
                self._429[host] = self._429.get(host, 0) + 1
                if self._429[host] >= self.max_429:
                    self.closed_hosts.add(host)
                    raise HostClosed(host)
                self.sleep(_retry_after(res, self.backoff * (attempt + 1) * 5))
                attempt += 1
                continue
            retryable = res.status is None or res.status >= 500
            if retryable and attempt < self.retries:
                attempt += 1
                self.sleep(self.backoff ** attempt)
                continue
            return res


def _is_rate_limit(res: Response) -> bool:
    """GitHub answers 403 with x-ratelimit-remaining: 0 when the hourly budget is spent."""
    h = res.headers or {}
    # Secondary ("abuse") limits come without x-ratelimit-remaining: 0 but with retry-after or a message.
    return (h.get("x-ratelimit-remaining") == "0" or "retry-after" in h
            or "rate limit" in (res.error or "").lower())


def _retry_after(res: Response, default: float) -> float:
    try:
        return min(float((res.headers or {}).get("retry-after", default)), 120.0)
    except (TypeError, ValueError):
        return default
