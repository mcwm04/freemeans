"""Wikipedia attention: daily pageviews of the tool's English article (Wikimedia REST API).

Docs: https://wikimedia.org/api/rest_v1/#/Pageviews%20data
History goes back to mid-2015, so the same call serves the daily run (3 days) and the
2-year backfill (one call per tool). agent=user leaves out known crawlers and bots.
"""
from __future__ import annotations

import datetime as dt
from urllib.parse import quote

from ..http import Http
from ..model import Outcome, daterange

BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user"


def url_for(article: str, start: dt.date, end: dt.date) -> str:
    title = quote(article.replace(" ", "_"), safe="")
    return f"{BASE}/{title}/daily/{start:%Y%m%d}00/{end:%Y%m%d}00"


def fetch(http: Http, article: str, start: dt.date, end: dt.date) -> Outcome:
    res = http.get_json(url_for(article, start, end))
    if res.status == 404:
        # Wikimedia answers 404 both for a missing article and for "no views in range".
        return Outcome("not_found", detail=f"no pageviews for {article!r} (check the title)")
    if not res.ok or not isinstance(res.data, dict):
        return Outcome("failed", detail=res.error or "unexpected answer")
    by_day: dict[dt.date, int] = {}
    for item in res.data.get("items", []):
        ts = str(item.get("timestamp", ""))
        try:
            day = dt.date(int(ts[0:4]), int(ts[4:6]), int(ts[6:8]))
        except ValueError:
            continue
        by_day[day] = by_day.get(day, 0) + int(item.get("views") or 0)
    if not by_day:
        return Outcome("not_found", detail=f"no pageviews for {article!r}")
    # Inside the range the API returns, a missing day means no views were recorded.
    first = min(by_day)
    values = {d: {"wiki_views": by_day.get(d, 0)} for d in daterange(max(first, start), end) if d <= max(by_day)}
    return Outcome("ok", values)
