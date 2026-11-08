"""Fetch each limit's source page once and check that its number is still there."""
from __future__ import annotations

import time
import urllib.error
import urllib.request
import urllib.robotparser
from dataclasses import dataclass, field
from typing import Callable
from urllib.parse import urlsplit

from .extract import Match, find_limit, page_text

USER_AGENT = "FreemeansBot/0.2 (+https://freemeans.com/bot; source freshness check)"
MAX_BYTES = 3_000_000
TIMEOUT = 25


@dataclass
class Page:
    url: str
    ok: bool
    text: str = ""
    status: int | None = None
    error: str | None = None


@dataclass
class RuleResult:
    resource_id: str
    metric: str
    value: object
    window: str
    source_url: str
    signal_type: str
    verified_at: str
    status: str  # confirmed | weak | missing | unreachable | skipped
    detail: str = ""
    snippet: str | None = None
    nearby: list[str] = field(default_factory=list)


Fetcher = Callable[[str], Page]
RobotsCheck = Callable[[str], bool]


def http_fetch(url: str) -> Page:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/markdown,text/plain;q=0.9,*/*;q=0.5"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            raw = res.read(MAX_BYTES + 1)
            ctype = res.headers.get("content-type", "")
            charset = res.headers.get_content_charset() or "utf-8"
            body = raw[:MAX_BYTES].decode(charset, errors="replace")
            text = page_text(body, ctype)
            if len(text) < 200:
                return Page(url, False, text, res.status, "page has almost no text (probably built by JavaScript)")
            return Page(url, True, text, res.status)
    except urllib.error.HTTPError as e:
        return Page(url, False, status=e.code, error=f"HTTP {e.code}")
    except Exception as e:  # network errors, timeouts, TLS
        return Page(url, False, error=f"{type(e).__name__}: {e}"[:200])


_robots_cache: dict[str, urllib.robotparser.RobotFileParser | None] = {}


def robots_allows(url: str) -> bool:
    """Honour robots.txt. If robots.txt cannot be read, treat the page as allowed."""
    parts = urlsplit(url)
    base = f"{parts.scheme}://{parts.netloc}"
    if base not in _robots_cache:
        rp = urllib.robotparser.RobotFileParser(base + "/robots.txt")
        try:
            rp.read()
        except Exception:
            rp = None
        _robots_cache[base] = rp
    rp = _robots_cache[base]
    return True if rp is None else rp.can_fetch(USER_AGENT, url)


def _classify(m: Match) -> tuple[str, str]:
    if m.status == "near_unit":
        return "confirmed", f"found “{m.variant}” next to its unit"
    if m.status == "number_only":
        return "weak", f"found “{m.variant}”, but not next to its unit"
    return "missing", "number not found on the page"


def check_catalog(catalog: dict, fetch: Fetcher = http_fetch, allowed: RobotsCheck = robots_allows, pause: float = 1.0) -> list[RuleResult]:
    rules = [(r, l) for r in catalog["resources"] for l in r["limit_rules"]]
    urls = sorted({l["source_url"] for _, l in rules})
    pages: dict[str, Page] = {}
    last_host = None
    for url in urls:
        host = urlsplit(url).netloc
        if not allowed(url):
            pages[url] = Page(url, False, error="robots.txt does not allow this page")
            continue
        if pause and host == last_host:
            time.sleep(pause)  # be gentle: one request at a time, a pause between pages on one host
        pages[url] = fetch(url)
        last_host = host

    results: list[RuleResult] = []
    for r, l in rules:
        base = dict(
            resource_id=r["id"], metric=l["metric"], value=l.get("value"), window=l["window"],
            source_url=l["source_url"], signal_type=l["signal_type"], verified_at=l["verified_at"],
        )
        if l.get("value") is None or l.get("published") is False:
            results.append(RuleResult(**base, status="skipped", detail="limit is not published, nothing to compare"))
            continue
        page = pages[l["source_url"]]
        if not page.ok:
            results.append(RuleResult(**base, status="unreachable", detail=page.error or "could not read the page"))
            continue
        m = find_limit(page.text, l["metric"], l["value"])
        status, detail = _classify(m)
        results.append(RuleResult(**base, status=status, detail=detail, snippet=m.snippet, nearby=m.nearby))
    return results


def summary(results: list[RuleResult]) -> dict[str, int]:
    out: dict[str, int] = {}
    for r in results:
        out[r.status] = out.get(r.status, 0) + 1
    return out
