"""The two jobs: the nightly collection and the one-time history backfill.

Days are UTC days. The nightly run (00:34 Pakistan time = 19:34 UTC) collects for the UTC day
that has just finished ("yesterday"), and refreshes the two days before it, because Wikipedia
figures and Hacker News points keep settling for a day or two.
"""
from __future__ import annotations

import datetime as dt
import os
from collections import defaultdict
from dataclasses import dataclass, field

from .http import HostClosed, Http
from .model import Outcome, daterange, merge
from .sources import github, hackernews, huggingface, wikipedia
from .store import Store
from .tools import Tool

REFRESH_DAYS = 3
FAILURE_LIMIT = 0.30          # PRD 7.7: more than 30% failures marks the run not OK
SOURCES = ("wiki", "hn", "github", "hf", "clicks")
DISABLED = {
    "trends": "Google Trends API: waiting for alpha access",
    "producthunt": "Product Hunt: off until it allows commercial use (PRD 7.2)",
}


def utc_yesterday(now: dt.datetime | None = None) -> dt.date:
    now = now or dt.datetime.now(dt.timezone.utc)
    return now.astimezone(dt.timezone.utc).date() - dt.timedelta(days=1)


def clicks_live_since() -> dt.date | None:
    """Clicks are a real 0 only once /go/{slug} is live; before that they are NULL (not measured)."""
    raw = os.environ.get("FREEMEANS_CLICKS_SINCE", "").strip()
    try:
        return dt.date.fromisoformat(raw) if raw else None
    except ValueError:
        return None


@dataclass
class RunStats:
    job: str
    first_day: dt.date
    last_day: dt.date
    tools: int = 0
    rows: int = 0
    http_calls: int = 0
    counts: dict[str, dict[str, int]] = field(default_factory=lambda: defaultdict(lambda: defaultdict(int)))
    problems: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)
    closed_hosts: list[str] = field(default_factory=list)

    def record(self, source: str, slug: str, outcome: Outcome) -> None:
        self.counts[source][outcome.status] += 1
        if outcome.status in ("failed", "not_found"):
            self.problems.append(f"{slug} · {source} · {outcome.status}: {outcome.detail}")
        elif outcome.detail:
            self.notes.append(f"{slug} · {source}: {outcome.detail}")

    @property
    def attempted(self) -> int:
        return sum(c.get("ok", 0) + c.get("failed", 0) for c in self.counts.values())

    @property
    def failed(self) -> int:
        return sum(c.get("failed", 0) for c in self.counts.values())

    @property
    def failure_rate(self) -> float:
        return self.failed / self.attempted if self.attempted else 0.0

    @property
    def ok(self) -> bool:
        return self.failure_rate <= FAILURE_LIMIT

    def as_json(self) -> dict:
        return {
            "first_day": self.first_day.isoformat(), "last_day": self.last_day.isoformat(),
            "tools": self.tools, "rows": self.rows, "http_calls": self.http_calls,
            "counts": {s: dict(c) for s, c in self.counts.items()},
            "failure_rate": round(self.failure_rate, 3), "problems": self.problems[:100],
            "notes": self.notes[:100], "closed_hosts": self.closed_hosts,
            "disabled": list(DISABLED),
        }

    def markdown(self) -> str:
        head = "✅ OK" if self.ok else "❌ NOT OK (more than 30% of calls failed)"
        span = (self.last_day.isoformat() if self.first_day == self.last_day
                else f"{self.first_day} → {self.last_day}")
        lines = [f"## Signal {self.job}: {head}", "",
                 f"Days (UTC): **{span}** · tools: **{self.tools}** · rows written: **{self.rows}** · "
                 f"HTTP calls: **{self.http_calls}** · failure rate: **{self.failure_rate:.0%}**", "",
                 "| Source | ok | not found | failed | skipped |", "| --- | ---: | ---: | ---: | ---: |"]
        for s in sorted(self.counts):
            c = self.counts[s]
            lines.append(f"| {s} | {c.get('ok', 0)} | {c.get('not_found', 0)} | {c.get('failed', 0)} | {c.get('skipped', 0)} |")
        for name, why in DISABLED.items():
            lines.append(f"| {name} | – | – | – | off: {why} |")
        if self.closed_hosts:
            lines += ["", f"Rate-limited and stopped for this run: {', '.join(self.closed_hosts)}"]
        if self.problems:
            lines += ["", "### Needs a look", ""] + [f"- {p}" for p in self.problems[:50]]
        if self.notes:
            lines += ["", "### Notes", ""] + [f"- {n}" for n in self.notes[:50]]
        return "\n".join(lines) + "\n"


def _call(stats: RunStats, source: str, slug: str, fn) -> Outcome:
    try:
        out = fn()
    except HostClosed as e:
        out = Outcome("failed", detail=f"{e} rate-limited us; stopped for this run")
    stats.record(source, slug, out)
    return out


def collect_daily(tools: list[Tool], store: Store, http: Http, day: dt.date) -> RunStats:
    start = day - dt.timedelta(days=REFRESH_DAYS - 1)
    stats = RunStats("collection", start, day, tools=len(tools))
    rows: dict[tuple[str, dt.date], dict] = {}

    for t in tools:
        if art := t.sig("wikipedia_article"):
            merge(rows, t.slug, _call(stats, "wiki", t.slug, lambda: wikipedia.fetch(http, art, start, day)))
        else:
            stats.counts["wiki"]["skipped"] += 1
        dom, q = t.sig("hn_domain"), t.sig("hn_query")
        if dom or q:
            merge(rows, t.slug, _call(stats, "hn", t.slug,
                                      lambda: hackernews.fetch(http, start, day, hn_domain=dom, hn_query=q)))
        else:
            stats.counts["hn"]["skipped"] += 1
        if repo := t.sig("github_repo"):
            merge(rows, t.slug, _call(stats, "github", t.slug, lambda: github.fetch_total(http, repo, day)))
        else:
            stats.counts["github"]["skipped"] += 1
        if hf := t.sig("hf_id"):
            merge(rows, t.slug, _call(stats, "hf", t.slug, lambda: huggingface.fetch(http, hf, day)))
        else:
            stats.counts["hf"]["skipped"] += 1

    since = clicks_live_since()
    if since and since <= day:
        first = max(since, start)
        found = store.clicks([t.slug for t in tools], first, day)
        for t in tools:
            for d in daterange(first, day):
                rows.setdefault((t.slug, d), {})["our_clicks"] = found.get((t.slug, d), 0)
        stats.counts["clicks"]["ok"] += len(tools)
    else:
        stats.counts["clicks"]["skipped"] += len(tools)

    # Every published tool gets a row for the day, even if every signal was skipped or failed:
    # the scorer can then tell "measured nothing" from "tool missing".
    for t in tools:
        rows.setdefault((t.slug, day), {})

    stats.rows = store.upsert_snapshots(rows)
    stats.http_calls = http.calls
    stats.closed_hosts = sorted(http.closed_hosts)
    return stats


def backfill(tools: list[Tool], store: Store, http: Http, end: dt.date, *, years: int = 2,
             signals: tuple[str, ...] = ("wiki", "hn", "github"), gh_budget: int = 600) -> RunStats:
    """Load past data once per tool and signal (PRD 6.5). Safe to re-run: finished work is skipped."""
    start = end - dt.timedelta(days=365 * years)
    stats = RunStats("backfill", start, end, tools=len(tools))
    done = store.backfills()
    rows_total = 0

    def save(slug: str, signal: str, status: str, out: Outcome) -> None:
        nonlocal rows_total
        n = store.upsert_snapshots({(slug, d): v for d, v in out.values.items()}) if out.values else 0
        rows_total += n
        days = sorted(out.values)
        store.set_backfill(slug, signal, status, days[0] if days else None, days[-1] if days else None, n, out.detail)

    for t in tools:
        if "wiki" in signals and (art := t.sig("wikipedia_article")) and done.get((t.slug, "wiki")) != "done":
            out = _call(stats, "wiki", t.slug, lambda: wikipedia.fetch(http, art, start, end))
            save(t.slug, "wiki", "done" if out.status == "ok" else "failed", out)
        dom, q = t.sig("hn_domain"), t.sig("hn_query")
        if "hn" in signals and (dom or q) and done.get((t.slug, "hn")) != "done":
            out = _call(stats, "hn", t.slug, lambda: hackernews.fetch(http, start, end, hn_domain=dom, hn_query=q))
            save(t.slug, "hn", "done" if out.status == "ok" else "failed", out)
        repo = t.sig("github_repo")
        if "github" in signals and repo and done.get((t.slug, "github")) not in ("done", "too_large"):
            if gh_budget <= 1:
                stats.counts["github"]["skipped"] += 1
                stats.notes.append(f"{t.slug} · github: request budget used up; continues next run")
                continue
            try:
                status, out, used = github.backfill(http, repo, start, end, gh_budget)
            except HostClosed as e:
                status, out, used = "failed", Outcome("failed", detail=f"{e} rate-limited us"), 0
            gh_budget -= used
            stats.record("github", t.slug, out)
            if status != "partial":
                save(t.slug, "github", status, out)

    stats.rows = rows_total
    stats.http_calls = http.calls
    stats.closed_hosts = sorted(http.closed_hosts)
    return stats
