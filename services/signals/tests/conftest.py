"""A fake internet: routes each URL to a canned answer, records every call. No network in tests."""
from __future__ import annotations

import datetime as dt
import re

import pytest

from signals.http import Http, Response
from signals.tools import Tool


class FakeWeb:
    def __init__(self):
        self.routes: list[tuple[re.Pattern, object]] = []
        self.calls: list[str] = []
        self.headers: list[dict] = []

    def add(self, pattern: str, answer) -> None:
        """answer: Response, or a function(url) -> Response. Later routes win."""
        self.routes.insert(0, (re.compile(pattern), answer))

    def __call__(self, url: str, headers: dict) -> Response:
        self.calls.append(url)
        self.headers.append(headers)
        for pat, answer in self.routes:
            if pat.search(url):
                return answer(url) if callable(answer) else answer
        return Response(404, None, "HTTP 404")


@pytest.fixture
def web():
    return FakeWeb()


@pytest.fixture
def http(web):
    return Http(web, pause=0, sleep=lambda s: None)


def ts(day: dt.date, hour: int = 12) -> int:
    return int(dt.datetime(day.year, day.month, day.day, hour, tzinfo=dt.timezone.utc).timestamp())


def wiki_items(article: str, views: dict[dt.date, int]) -> dict:
    return {"items": [{"project": "en.wikipedia", "article": article, "granularity": "daily",
                       "timestamp": f"{d:%Y%m%d}00", "access": "all-access", "agent": "user", "views": v}
                      for d, v in sorted(views.items())]}


def tool(slug="ollama", **signals) -> Tool:
    base = {"trends_term": None, "wikipedia_article": None, "github_repo": None, "hf_id": None,
            "producthunt_slug": None, "hn_domain": None, "hn_query": None}
    base.update(signals)
    return Tool(slug, f"https://{slug}.example", base)
