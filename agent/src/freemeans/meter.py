"""Usage meter: reads rate-limit headers and counts calls (Chapter 5.3).

Three ways to know how much quota is left, best first:
1. header  - the provider's own rate-limit headers on the last response (exact)
2. counted - our own count of calls through the router vs. the catalog limit (estimate, shown as "≈")
3. unknown - the provider publishes no number and none is configured
"""

from __future__ import annotations

import re
import sqlite3
import threading
import time
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable, Mapping
from zoneinfo import ZoneInfo

from .catalog import Limit

REQUEST_METRICS = {"rps", "rpm", "rpd", "requests_per_month", "requests"}
TOKEN_METRICS = {"tpm", "tpd", "itpm", "otpm"}

_DUR = re.compile(r"(\d+(?:\.\d+)?)(ms|h|m|s)")


def parse_duration(text: str) -> float | None:
    """Parse Groq-style durations: '2m59.56s', '7.66s', '14h12m', '500ms', '2'."""
    text = text.strip()
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        pass
    total, matched = 0.0, ""
    for value, unit in _DUR.findall(text):
        matched += value + unit
        v = float(value)
        total += {"ms": v / 1000, "s": v, "m": v * 60, "h": v * 3600}[unit]
    return total if matched == text.replace(" ", "") else None


def parse_reset(text: str, now: float) -> float | None:
    """Turn a reset header into an absolute epoch time.

    Accepts durations ('7.66s'), seconds-from-now ('42'), epoch seconds or epoch milliseconds.
    """
    try:
        n = float(text)
    except ValueError:
        d = parse_duration(text)
        return now + d if d is not None else None
    if n > 1e12:  # epoch milliseconds
        return n / 1000
    if n > 1e9:  # epoch seconds
        return n
    return now + n


def parse_retry_after(headers: Mapping[str, str], now: float) -> float | None:
    """Seconds to wait, from Retry-After (seconds or HTTP date)."""
    h = {k.lower(): v for k, v in headers.items()}
    val = h.get("retry-after")
    if not val:
        return None
    try:
        return max(0.0, float(val))
    except ValueError:
        try:
            return max(0.0, parsedate_to_datetime(val).timestamp() - now)
        except (TypeError, ValueError):
            return None


@dataclass
class HeaderWindow:
    metric: str
    limit: float | None
    remaining: float | None
    reset_at: float | None
    observed_at: float
    seq: int = 0  # meter event counter when the header was seen


def parse_rate_headers(headers: Mapping[str, str], now: float) -> list[HeaderWindow]:
    """Extract rate-limit windows from response headers.

    Groq documents that x-ratelimit-*-requests always refers to requests per DAY
    and x-ratelimit-*-tokens to tokens per MINUTE. Other providers using the
    generic X-RateLimit-Limit/Remaining/Reset trio are recorded as 'requests'.
    """
    h = {k.lower(): v for k, v in headers.items()}
    out: list[HeaderWindow] = []

    def num(key: str) -> float | None:
        try:
            return float(h[key])
        except (KeyError, ValueError):
            return None

    def reset(key: str) -> float | None:
        return parse_reset(h[key], now) if key in h else None

    if "x-ratelimit-remaining-requests" in h or "x-ratelimit-limit-requests" in h:
        out.append(HeaderWindow("rpd", num("x-ratelimit-limit-requests"), num("x-ratelimit-remaining-requests"),
                                reset("x-ratelimit-reset-requests"), now))
    if "x-ratelimit-remaining-tokens" in h or "x-ratelimit-limit-tokens" in h:
        out.append(HeaderWindow("tpm", num("x-ratelimit-limit-tokens"), num("x-ratelimit-remaining-tokens"),
                                reset("x-ratelimit-reset-tokens"), now))
    if "x-ratelimit-remaining" in h or "x-ratelimit-limit" in h:
        out.append(HeaderWindow("requests", num("x-ratelimit-limit"), num("x-ratelimit-remaining"),
                                reset("x-ratelimit-reset"), now))
    return out


@dataclass
class Remaining:
    metric: str
    limit: float
    remaining: float
    method: str  # "header" | "counted"
    reset_at: float | None

    @property
    def fraction(self) -> float:
        return 0.0 if self.limit <= 0 else max(0.0, min(1.0, self.remaining / self.limit))


class Meter:
    def __init__(self, db_path: Path | None = None, now: Callable[[], float] = time.time):
        self.now = now
        self._lock = threading.Lock()
        self._events: dict[str, deque[tuple[float, int, int, int]]] = {}  # (ts, tokens, status, seq)
        self._seq: dict[str, int] = {}
        self._headers: dict[str, dict[str, HeaderWindow]] = {}
        self._db: sqlite3.Connection | None = None
        if db_path is not None:
            db_path = Path(db_path)
            db_path.parent.mkdir(parents=True, exist_ok=True)
            self._db = sqlite3.connect(str(db_path), check_same_thread=False)
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS events (ts REAL, deployment TEXT, tokens INTEGER, status INTEGER)"
            )
            self._db.execute(
                "CREATE TABLE IF NOT EXISTS header_windows (deployment TEXT, metric TEXT, lim REAL, remaining REAL,"
                " reset_at REAL, observed_at REAL, PRIMARY KEY (deployment, metric))"
            )
            cutoff = self.now() - 32 * 86400
            for ts, dep, tokens, status in self._db.execute(
                "SELECT ts, deployment, tokens, status FROM events WHERE ts >= ? ORDER BY ts", (cutoff,)
            ):
                n = self._seq.get(dep, 0) + 1
                self._seq[dep] = n
                self._events.setdefault(dep, deque()).append((ts, tokens, status, n))
            # Restore the last header reading per window; its seq = served calls up to that moment.
            for dep, metric, lim, rem, reset_at, observed_at in self._db.execute(
                "SELECT deployment, metric, lim, remaining, reset_at, observed_at FROM header_windows"
            ):
                seq = sum(1 for e in self._events.get(dep, ()) if e[0] <= observed_at)
                self._headers.setdefault(dep, {})[metric] = HeaderWindow(metric, lim, rem, reset_at, observed_at, seq)

    # -- recording -------------------------------------------------------
    def record(self, deployment: str, tokens: int, status: int, headers: Mapping[str, str] | None = None) -> None:
        ts = self.now()
        with self._lock:
            if 200 <= status < 300:  # only served calls count against quota estimates
                n = self._seq.get(deployment, 0) + 1
                self._seq[deployment] = n
                self._events.setdefault(deployment, deque()).append((ts, int(tokens), int(status), n))
                if self._db is not None:
                    self._db.execute("INSERT INTO events VALUES (?, ?, ?, ?)", (ts, deployment, int(tokens), int(status)))
                    self._db.commit()
            for w in parse_rate_headers(headers or {}, ts):
                w.seq = self._seq.get(deployment, 0)  # the header already reflects this call
                self._headers.setdefault(deployment, {})[w.metric] = w
                if self._db is not None:
                    self._db.execute(
                        "INSERT OR REPLACE INTO header_windows VALUES (?, ?, ?, ?, ?, ?)",
                        (deployment, w.metric, w.limit, w.remaining, w.reset_at, w.observed_at),
                    )
                    self._db.commit()
            self._trim(deployment, ts)

    def _trim(self, deployment: str, now: float) -> None:
        q = self._events.get(deployment)
        cutoff = now - 32 * 86400
        while q and q[0][0] < cutoff:
            q.popleft()

    # -- windows ---------------------------------------------------------
    def window_start(self, lim: Limit, now: float) -> float:
        if lim.window == "second":
            return now - 1
        if lim.window == "minute":
            return now - 60
        if lim.window == "day":
            if lim.reset_kind == "fixed_daily":
                tz = ZoneInfo(lim.reset_tz or "UTC")
                hh, mm = (int(x) for x in (lim.reset_at or "00:00").split(":"))
                local = datetime.fromtimestamp(now, tz)
                start = local.replace(hour=hh, minute=mm, second=0, microsecond=0)
                if start > local:
                    start -= timedelta(days=1)
                return start.timestamp()
            return now - 86400
        if lim.window == "month":
            if lim.reset_kind == "fixed_monthly":
                tz = ZoneInfo(lim.reset_tz or "UTC")
                local = datetime.fromtimestamp(now, tz)
                return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0).timestamp()
            return now - 30 * 86400
        return now - 86400

    def next_reset(self, lim: Limit, now: float) -> float | None:
        start = self.window_start(lim, now)
        span = {"second": 1, "minute": 60, "day": 86400}.get(lim.window)
        if lim.window == "day" and lim.reset_kind != "fixed_daily":
            return None  # rolling or unknown: no single reset moment
        return start + span if span else None

    def _used(self, deployment: str, since: float, metric: str, after_seq: int = 0) -> float:
        q = self._events.get(deployment, ())
        rows = [(ts, tok) for ts, tok, _, seq in q if ts >= since and seq > after_seq]
        if metric in TOKEN_METRICS:
            return float(sum(tok for _, tok in rows))
        return float(len(rows))

    # -- queries ---------------------------------------------------------
    def remaining(self, deployment: str, limits: Mapping[str, Limit]) -> list[Remaining]:
        now = self.now()
        out: list[Remaining] = []
        with self._lock:
            headers = dict(self._headers.get(deployment, {}))
            for metric, lim in limits.items():
                hw = headers.pop(metric, None)
                if hw and hw.remaining is not None and hw.limit and (hw.reset_at is None or hw.reset_at > now):
                    # Header is exact as of observed_at; subtract calls made since then.
                    since = self._used(deployment, hw.observed_at, metric, after_seq=hw.seq)
                    out.append(Remaining(metric, hw.limit, max(0.0, hw.remaining - since), "header", hw.reset_at))
                elif lim.value is not None and metric in REQUEST_METRICS | TOKEN_METRICS:
                    used = self._used(deployment, self.window_start(lim, now), metric)
                    out.append(Remaining(metric, lim.value, max(0.0, lim.value - used), "counted",
                                         self.next_reset(lim, now)))
            # Header windows with no catalog counterpart (e.g. generic 'requests')
            for metric, hw in headers.items():
                if hw.remaining is not None and hw.limit and (hw.reset_at is None or hw.reset_at > now):
                    since = self._used(deployment, hw.observed_at, metric, after_seq=hw.seq)
                    out.append(Remaining(metric, hw.limit, max(0.0, hw.remaining - since), "header", hw.reset_at))
        return out

    def headroom(self, deployment: str, limits: Mapping[str, Limit]) -> float | None:
        rem = self.remaining(deployment, limits)
        return min((r.fraction for r in rem), default=None)

    def can_send(self, deployment: str, limits: Mapping[str, Limit], est_tokens: int) -> tuple[bool, str]:
        for r in self.remaining(deployment, limits):
            if r.metric in REQUEST_METRICS and r.remaining < 1:
                return False, f"{r.metric} exhausted ({r.method})"
            if r.metric in TOKEN_METRICS and r.remaining < est_tokens:
                return False, f"{r.metric} would be exceeded: ~{est_tokens} tokens needed, {int(r.remaining)} left ({r.method})"
        return True, ""

    def earliest_reset(self, deployment: str, limits: Mapping[str, Limit]) -> float | None:
        resets = [r.reset_at for r in self.remaining(deployment, limits)
                  if r.reset_at and (r.remaining < 1 or r.fraction == 0)]
        return min(resets, default=None)
