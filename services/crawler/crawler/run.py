"""The two nightly steps: discover (find and queue candidates) and draft (fetch, LLM, check, queue for review)."""
from __future__ import annotations

import datetime as dt
import json
from dataclasses import dataclass, field
from pathlib import Path

from signals.http import Http

from .domain import clean_url, site_key
from .draft import draft_listing
from .fetch import Fetcher
from .llm import Drafter, NoProvider
from .sources import discover, percentiles
from .store import Store

REPO = Path(__file__).resolve().parents[3]
FAILURE_LIMIT = 0.30
DEFER_STOP = 4                 # stop drafting after this many sites in a row turned away by busy providers
FREE_TYPES = {"forever_free", "credits", "open_source"}


def published(tools_dir: Path = REPO / "data" / "tools") -> tuple[set[str], set[str]]:
    """Site keys and slugs of every tool file (any status): never re-queue a listed site."""
    keys, slugs = set(), set()
    for p in sorted(tools_dir.glob("*.json")):
        try:
            t = json.loads(p.read_text(encoding="utf-8"))
        except ValueError:
            continue
        slugs.add(t.get("slug") or p.stem)
        for u in (t.get("url"), t.get("repo_url")):
            if k := site_key(u):
                keys.add(k)
    return keys, slugs


@dataclass
class Stats:
    found: int = 0
    queued: int = 0
    skipped_known: int = 0
    drafted: int = 0
    needs_manual: int = 0
    rejected: dict[str, int] = field(default_factory=dict)
    failed: int = 0
    deferred: int = 0              # LLM rate-limited or overloaded; stays queued for the next run
    attempted: int = 0
    numbers_blanked: int = 0
    problems: list[str] = field(default_factory=list)
    llm: dict[str, int] = field(default_factory=dict)

    @property
    def ok(self) -> bool:
        return not self.attempted or self.failed / self.attempted <= FAILURE_LIMIT

    def as_json(self) -> dict:
        return {k: v for k, v in self.__dict__.items()} | {"ok": self.ok}

    def markdown(self) -> str:
        head = "✅ OK" if self.ok else "❌ NOT OK (more than 30% of drafts failed)"
        lines = [f"## Discovery crawler: {head}", "",
                 f"Found **{self.found}** · queued **{self.queued}** · already known **{self.skipped_known}**",
                 f"Drafted **{self.drafted}** · needs manual **{self.needs_manual}** · failed **{self.failed}** · "
                 f"deferred (LLM busy) **{self.deferred}** · numbers blanked by the check **{self.numbers_blanked}**"]
        if self.rejected:
            lines.append("Rejected automatically: " + ", ".join(f"{k} {v}" for k, v in sorted(self.rejected.items())))
        if self.llm:
            lines.append("LLM calls: " + ", ".join(f"{k} {v}" for k, v in sorted(self.llm.items())))
        if self.problems:
            lines += ["", "### Needs a look", ""] + [f"- {p}" for p in self.problems[:40]]
        return "\n".join(lines) + "\n"


def run_discover(http: Http, store: Store, now: dt.datetime, stats: Stats, enabled=("hn", "github", "hf")) -> None:
    cands, problems = discover(http, now, enabled)
    stats.found = len(cands)
    stats.problems += [f"source {k}: {v}" for k, v in problems.items()]
    listed, _ = published()
    known = store.known_domains() | listed
    pct = percentiles(cands)
    rows, seen = [], set()
    for c in cands:
        url = clean_url(c.url)
        key = site_key(url)
        if not url or not key or key in known or key in seen:
            stats.skipped_known += 1
            continue
        seen.add(key)
        rows.append({"url": url, "domain": key, "source": c.source, "source_ref": c.source_ref, "name": c.name,
                     "category": None, "priority": round(60 * pct.get(id(c), 0)), "buzz": c.buzz})
    stats.queued = store.add(rows)


def run_draft(store: Store, fetcher: Fetcher, drafter: Drafter, taxonomy: dict, today: dt.date, stats: Stats,
              limit: int = 40) -> None:
    _, taken = published()
    rows = list(store.next_batch(limit))
    strikes = 0
    for done, row in enumerate(rows, 1):
        row.attempts += 1
        fetched = fetcher.fetch_tool(row.url)
        if fetched.status != "ok":
            reason = {"dead_site": "dead_site", "parked": "parked"}.get(fetched.status)
            if reason and row.attempts >= 2:
                row.status, row.reject_reason = "rejected", reason
                stats.rejected[reason] = stats.rejected.get(reason, 0) + 1
            elif fetched.status == "blocked":
                row.status, row.flags = "needs_manual", ["robots_blocked"]
                stats.needs_manual += 1
            store.save(row)
            continue
        stats.attempted += 1
        try:
            result = draft_listing(drafter, fetched, url=_home(fetched.final_url or row.url), source=row.source,
                                   source_ref=row.source_ref, hint={"name": row.name, "category": row.category},
                                   taxonomy=taxonomy, taken=taken, today=today)
        except NoProvider as e:
            msg = str(e)
            row.attempts -= 1                      # not the candidate's fault: retry next run
            store.save(row)
            stats.problems.append(f"{row.domain}: LLM: {msg}")
            if "no LLM key" in msg:
                stats.failed += 1
                break
            if "not JSON" in msg:                  # a provider answered badly: counts as a real failure
                stats.failed += 1
                strikes = 0
                continue
            # Providers are rate-limited or overloaded. That is a free-tier limit, not a broken run:
            # leave the site queued, and stop early once several in a row are turned away.
            stats.deferred += 1
            strikes += 1
            if strikes >= DEFER_STOP:
                stats.problems.append(f"LLM providers exhausted; stopped early, {len(rows) - done} left for the next run")
                break
            continue
        strikes = 0
        stats.llm[result["provider"]] = stats.llm.get(result["provider"], 0) + 1
        rec = result["record"]
        taken.add(rec["slug"])
        row.draft, row.evidence = rec, result["evidence"]
        row.flags = result["flags"] + [f"invalid:{e}"[:200] for e in result["errors"]]
        row.name = rec["name"]
        stats.numbers_blanked += len(result["flags"])
        if result["errors"]:
            row.status = "needs_manual"
            stats.needs_manual += 1
        else:
            row.status = "drafted"
            stats.drafted += 1
            if rec["free_tier"]["type"] in FREE_TYPES:
                row.priority = min(100, row.priority + 20)
        store.save(row)
    stats.llm = {**stats.llm, **{f"{k} calls": v for k, v in drafter.calls.items()}}


def _home(url: str) -> str:
    """Listings link to the site's address as found; path-keyed hosts keep their repo or Space path."""
    return clean_url(url) or url
