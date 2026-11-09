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

USER_AGENT = "FreemeansBot/0.3 (+https://freemeans.com/bot; source freshness check)"
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
RobotsCheck = Callable[[str], "bool | str"]


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


RobotsFetcher = Callable[[str], tuple[int | None, str]]


def http_robots(url: str) -> tuple[int | None, str]:
    """Fetch robots.txt as FreemeansBot (not Python's default agent, which many sites block)."""
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            return res.status, res.read(500_000).decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception:
        return None, ""  # DNS, timeout, TLS: robots.txt unreachable


class Robots:
    """robots.txt rules per site, following RFC 9309:
    2xx → obey the file · 4xx (none available, incl. 401/403) → allowed ·
    5xx or unreachable → assume everything is disallowed."""

    def __init__(self, fetch: RobotsFetcher = http_robots, agent: str = "FreemeansBot"):
        self.fetch = fetch
        self.agent = agent
        self.cache: dict[str, tuple[urllib.robotparser.RobotFileParser | None, str | None]] = {}

    def _site(self, url: str):
        parts = urlsplit(url)
        base = f"{parts.scheme}://{parts.netloc}"
        if base not in self.cache:
            status, text = self.fetch(base + "/robots.txt")
            if status is not None and 200 <= status < 300:
                rp = urllib.robotparser.RobotFileParser()
                rp.parse(text.splitlines())
                self.cache[base] = (rp, None)
            elif status is not None and 400 <= status < 500:
                self.cache[base] = (None, None)  # no rules: allowed
            else:
                why = f"HTTP {status}" if status else "no connection"
                self.cache[base] = (None, f"robots.txt could not be read ({why}), so the site is treated as closed")
        return self.cache[base]

    def __call__(self, url: str) -> bool | str:
        """True when allowed; otherwise a short reason."""
        rp, closed = self._site(url)
        if closed:
            return closed
        if rp is None or rp.can_fetch(self.agent, url):
            return True
        return "robots.txt does not allow this page"


robots_allows = Robots()


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
        verdict = allowed(url)
        if verdict is not True:
            reason = verdict if isinstance(verdict, str) else "robots.txt does not allow this page"
            pages[url] = Page(url, False, error=reason)
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
