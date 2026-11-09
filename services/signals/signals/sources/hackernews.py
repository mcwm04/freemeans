"""Developer discussion: Hacker News story points per day (Algolia HN Search API).

Docs: https://hn.algolia.com/api
A tool is matched by the domain of the story's link (signals.hn_domain, preferred: it avoids
name clashes such as "Claude" or "Copilot") or by a title search (signals.hn_query).
Each story's points are counted on the UTC day the story was posted. Points keep growing for a
day or two, so the daily run refreshes the last 3 days.

Algolia returns at most 1,000 hits per query, so long ranges are split until each part fits.
"""
from __future__ import annotations

import calendar
import datetime as dt
import re
from urllib.parse import urlencode, urlsplit

from ..http import Http
from ..model import Outcome, daterange

BASE = "https://hn.algolia.com/api/v1/search_by_date"
MAX_HITS = 1000


def _ts(day: dt.date) -> int:
    return calendar.timegm(day.timetuple())


def _matches_domain(story_url: str | None, hn_domain: str) -> bool:
    if not story_url:
        return False
    want_host, _, want_path = hn_domain.lower().partition("/")
    parts = urlsplit(story_url.lower())
    host = parts.hostname or ""
    if host.startswith("www."):
        host = host[4:]
    if not (host == want_host or host.endswith("." + want_host)):
        return False
    if want_path:
        path = parts.path.strip("/")
        return path == want_path.strip("/") or path.startswith(want_path.strip("/") + "/")
    return True


def _matches_title(title: str | None, query: str) -> bool:
    if not title:
        return False
    return re.search(rf"(?<![\w.]){re.escape(query.lower())}(?![\w])", title.lower()) is not None


def _search(http: Http, params: dict, start: dt.date, end_excl: dt.date) -> list[dict] | None:
    """All hits created in [start, end_excl). Splits the range when Algolia would cut it at 1,000."""
    q = dict(params)
    q["numericFilters"] = f"created_at_i>={_ts(start)},created_at_i<{_ts(end_excl)}"
    q["hitsPerPage"] = MAX_HITS
    res = http.get_json(f"{BASE}?{urlencode(q)}")
    if not res.ok or not isinstance(res.data, dict):
        return None
    hits = list(res.data.get("hits", []))
    total = int(res.data.get("nbHits") or 0)
    if total > len(hits) and (end_excl - start).days > 1:
        mid = start + dt.timedelta(days=(end_excl - start).days // 2)
        left = _search(http, params, start, mid)
        right = _search(http, params, mid, end_excl)
        if left is None or right is None:
            return None
        return left + right
    return hits


def fetch(http: Http, start: dt.date, end: dt.date, *, hn_domain: str | None = None,
          hn_query: str | None = None, chunk_days: int = 31) -> Outcome:
    """Points per day for start..end (both included). Days without stories are 0, a real value."""
    if hn_domain:
        params = {"query": hn_domain, "tags": "story", "restrictSearchableAttributes": "url"}
        keep = lambda h: _matches_domain(h.get("url"), hn_domain)  # noqa: E731
    elif hn_query:
        params = {"query": hn_query, "tags": "story", "restrictSearchableAttributes": "title"}
        keep = lambda h: _matches_title(h.get("title"), hn_query)  # noqa: E731
    else:
        return Outcome("skipped")

    points: dict[dt.date, int] = {d: 0 for d in daterange(start, end)}
    cursor = start
    while cursor <= end:
        stop = min(cursor + dt.timedelta(days=chunk_days), end + dt.timedelta(days=1))
        hits = _search(http, params, cursor, stop)
        if hits is None:
            return Outcome("failed", detail="Algolia search failed")
        for h in hits:
            if not keep(h):
                continue
            created = h.get("created_at_i")
            if created is None:
                continue
            day = dt.datetime.fromtimestamp(int(created), dt.timezone.utc).date()
            if day in points:
                points[day] += int(h.get("points") or 0)
        cursor = stop
    return Outcome("ok", {d: {"hn_points": p} for d, p in points.items()})
