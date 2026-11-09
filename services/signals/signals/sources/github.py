"""Code adoption: GitHub stars (REST API).

Daily: GET /repos/{owner}/{repo} → stargazers_count, stored as the total for the day.
Backfill: list stargazers with timestamps (Accept: application/vnd.github.star+json), oldest
first, and rebuild the running total for every day. GitHub stops listing after about 40,000
stars, so bigger repos are marked too_large and simply start their history on day 1.
Un-starring is not visible in that list, so rebuilt totals can be a little high.

A token (GITHUB_TOKEN in Actions) raises the limit from 60 to 1,000+ requests an hour.
"""
from __future__ import annotations

import datetime as dt
import os

from ..http import Http
from ..model import Outcome, daterange

API = "https://api.github.com"
PER_PAGE = 100
MAX_PAGES = 400            # GitHub's listing limit (about 40,000 stars)


def _headers(accept: str = "application/vnd.github+json") -> dict:
    h = {"Accept": accept, "X-GitHub-Api-Version": "2022-11-28"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        h["Authorization"] = f"Bearer {token}"
    return h


def fetch_total(http: Http, repo: str, day: dt.date) -> Outcome:
    res = http.get_json(f"{API}/repos/{repo}", _headers())
    if res.status == 404:
        return Outcome("not_found", detail=f"repo {repo} not found")
    if not res.ok or not isinstance(res.data, dict):
        return Outcome("failed", detail=res.error or "unexpected answer")
    stars = res.data.get("stargazers_count")
    if not isinstance(stars, int):
        return Outcome("failed", detail="no stargazers_count")
    detail = ""
    full = res.data.get("full_name")
    if isinstance(full, str) and full.lower() != repo.lower():
        detail = f"repo moved to {full}; update signals.github_repo"
    return Outcome("ok", {day: {"gh_stars": stars}}, detail)


def backfill(http: Http, repo: str, start: dt.date, end: dt.date, budget: int) -> tuple[str, Outcome, int]:
    """Rebuild daily star totals for start..end. Returns (backfill status, outcome, requests used)."""
    first = fetch_total(http, repo, end)
    used = 1
    if first.status != "ok":
        return ("failed", first, used)
    total = first.values[end]["gh_stars"]
    pages = -(-total // PER_PAGE)
    if pages > MAX_PAGES:
        return ("too_large", Outcome("skipped", detail=f"{total} stars: more than GitHub lists"), used)
    if pages + 1 > budget:
        return ("partial", Outcome("skipped", detail=f"needs {pages} requests, budget {budget - 1}; retry next run"), used)

    per_day: dict[dt.date, int] = {}
    for page in range(1, pages + 1):
        res = http.get_json(f"{API}/repos/{repo}/stargazers?per_page={PER_PAGE}&page={page}",
                            _headers("application/vnd.github.star+json"))
        used += 1
        if res.status == 422:
            return ("too_large", Outcome("skipped", detail="GitHub refused deeper pages"), used)
        if not res.ok or not isinstance(res.data, list):
            return ("failed", Outcome("failed", detail=res.error or "unexpected answer"), used)
        for item in res.data:
            ts = item.get("starred_at") if isinstance(item, dict) else None
            if not ts:
                continue
            day = dt.date.fromisoformat(ts[:10])
            per_day[day] = per_day.get(day, 0) + 1
        if len(res.data) < PER_PAGE:
            break

    if not per_day:
        return ("done", Outcome("ok", {}), used)
    running = sum(n for d, n in per_day.items() if d < start)
    values = {}
    for d in daterange(max(start, min(per_day)), end):
        running += per_day.get(d, 0)
        values[d] = {"gh_stars": running}
    # Today's API total is the most accurate figure for the last day.
    values[end] = {"gh_stars": total}
    return ("done", Outcome("ok", values), used)
