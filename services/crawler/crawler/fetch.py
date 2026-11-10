"""Polite page fetching for drafting (PRD 7.1): at most 3 pages per tool, robots.txt respected,
one request per second per domain, 10-second timeout, honest user agent."""
from __future__ import annotations

import html as htmlmod
import re
import time
import urllib.error
import urllib.request
import urllib.robotparser
from dataclasses import dataclass, field
from html.parser import HTMLParser
from typing import Callable
from urllib.parse import urljoin, urlsplit

USER_AGENT = "FreemeansBot/1.0 (+https://freemeans.com/bot; hello@freemeans.com)"
TIMEOUT = 10
MAX_BYTES = 2_000_000
TEXT_CAP = 12_000                       # characters per tool, all pages together
PAGE_SHARE = {"home": 6_000, "pricing": 4_500, "docs": 2_500}
PRICING = re.compile(r"pricing|plans?\b|price|subscribe|upgrade", re.I)
DOCS = re.compile(r"\b(docs|documentation|faq|help|limits?)\b", re.I)
PARKED = re.compile(r"domain (is )?for sale|buy this domain|this domain (name )?(may be|is) (for sale|available)|parked (free|domain)", re.I)


@dataclass
class Page:
    url: str
    status: int | None
    html: str = ""
    final_url: str = ""
    error: str | None = None

    @property
    def ok(self) -> bool:
        return self.status is not None and 200 <= self.status < 300


Transport = Callable[[str], Page]
Robots = Callable[[str], bool]


def urllib_transport(url: str) -> Page:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Accept": "text/html,application/xhtml+xml"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
            ctype = res.headers.get("content-type", "")
            if "html" not in ctype and "text" not in ctype:
                return Page(url, res.status, final_url=res.geturl(), error=f"not a web page ({ctype})")
            raw = res.read(MAX_BYTES)
            charset = res.headers.get_content_charset() or "utf-8"
            return Page(url, res.status, raw.decode(charset, "replace"), res.geturl())
    except urllib.error.HTTPError as e:
        return Page(url, e.code, error=f"HTTP {e.code}")
    except Exception as e:
        return Page(url, None, error=f"{type(e).__name__}: {e}"[:200])


class RobotsCache:
    def __init__(self, fetch_robots: Callable[[str], tuple[int | None, str]] | None = None):
        self.fetch_robots = fetch_robots or _http_robots
        self.cache: dict[str, urllib.robotparser.RobotFileParser | None] = {}

    def __call__(self, url: str) -> bool:
        p = urlsplit(url)
        site = f"{p.scheme}://{p.netloc}"
        if site not in self.cache:
            status, body = self.fetch_robots(site + "/robots.txt")
            if status is None or status >= 500:
                self.cache[site] = None            # unreachable robots.txt: treat as "disallow all"
            else:
                rp = urllib.robotparser.RobotFileParser()
                rp.parse(body.splitlines() if status == 200 else [])
                self.cache[site] = rp
        rp = self.cache[site]
        return bool(rp and rp.can_fetch("FreemeansBot", url))


def _http_robots(url: str) -> tuple[int | None, str]:
    p = urllib_transport(url)
    if p.status == 200 and p.error and "not a web page" in p.error:
        # robots.txt is text/plain; fetch it without the content-type gate
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as res:
                return res.status, res.read(500_000).decode("utf-8", "replace")
        except Exception:
            return None, ""
    return p.status, p.html


class _Text(HTMLParser):
    SKIP = {"script", "style", "noscript", "svg", "template", "head", "nav", "footer", "form", "iframe"}
    BLOCK = {"p", "div", "li", "tr", "td", "th", "br", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "table", "dd", "dt"}

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.out: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self.depth += 1
        if tag in self.BLOCK:
            self.out.append("\n")

    def handle_endtag(self, tag):
        if tag in self.SKIP and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if not self.depth:
            self.out.append(data)


def page_text(html: str) -> tuple[str, list[tuple[str, str]]]:
    """Main text (no scripts, nav, footer) and all links with their anchor text."""
    p = _Text()
    try:
        p.feed(html)
    except Exception:
        pass
    text = htmlmod.unescape("".join(p.out))
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    # Nav and footer links are skipped from the text but still useful to find the pricing page.
    q = _LinkOnly()
    try:
        q.feed(html)
    except Exception:
        pass
    return text, q.links


class _LinkOnly(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.links: list[tuple[str, str]] = []
        self._a: str | None = None
        self._t: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            self._a = dict(attrs).get("href")
            self._t = []

    def handle_data(self, data):
        if self._a is not None:
            self._t.append(data.strip())

    def handle_endtag(self, tag):
        if tag == "a" and self._a:
            self.links.append((self._a, " ".join(t for t in self._t if t)))
            self._a = None


@dataclass
class Fetched:
    pages: dict[str, Page] = field(default_factory=dict)       # role -> page (home, pricing, docs)
    texts: dict[str, str] = field(default_factory=dict)        # role -> capped text
    final_url: str = ""
    status: str = "ok"                                          # ok | dead_site | parked | blocked
    detail: str = ""

    @property
    def all_text(self) -> str:
        return "\n\n".join(self.texts.values())


class Fetcher:
    def __init__(self, transport: Transport = urllib_transport, robots: Robots | None = None,
                 pause: float = 1.0, sleep: Callable[[float], None] = time.sleep):
        self.transport = transport
        self.robots = robots or RobotsCache()
        self.pause = pause
        self.sleep = sleep
        self._last: dict[str, float] = {}
        self.requests = 0

    def _get(self, url: str) -> Page:
        host = urlsplit(url).netloc
        wait = self.pause - (time.monotonic() - self._last.get(host, 0.0))
        if wait > 0:
            self.sleep(wait)
        self._last[host] = time.monotonic()
        self.requests += 1
        return self.transport(url)

    def fetch_tool(self, url: str) -> Fetched:
        out = Fetched()
        if not self.robots(url):
            out.status, out.detail = "blocked", "robots.txt does not allow our crawler"
            return out
        home = self._get(url)
        if not home.ok:
            home = self._get(url)                      # PRD 7.1: dead after 2 tries
        if not home.ok:
            out.status, out.detail = "dead_site", home.error or f"HTTP {home.status}"
            return out
        out.final_url = home.final_url or url
        text, links = page_text(home.html)
        if PARKED.search(text[:3000]):
            out.status, out.detail = "parked", "looks like a parked domain"
            return out
        out.pages["home"] = home
        out.texts["home"] = text[: PAGE_SHARE["home"]]

        base = out.final_url
        site = urlsplit(base).netloc
        for role, pattern in (("pricing", PRICING), ("docs", DOCS)):
            link = _pick(links, base, site, pattern, exclude={p.url for p in out.pages.values()})
            if not link or not self.robots(link):
                continue
            page = self._get(link)
            if page.ok:
                out.pages[role] = page
                out.texts[role] = page_text(page.html)[0][: PAGE_SHARE[role]]
        total = 0
        for role in list(out.texts):
            keep = max(0, TEXT_CAP - total)
            out.texts[role] = out.texts[role][:keep]
            total += len(out.texts[role])
        return out


def _pick(links, base, site, pattern, exclude) -> str | None:
    best = None
    for href, text in links:
        if not href or href.startswith(("#", "mailto:", "javascript:", "tel:")):
            continue
        absolute = urljoin(base, href).split("#")[0]
        p = urlsplit(absolute)
        if p.scheme not in ("http", "https"):
            continue
        same = p.netloc == site or p.netloc.endswith("." + site.removeprefix("www.")) or site.endswith("." + p.netloc.removeprefix("www."))
        if not same or absolute in exclude or absolute.rstrip("/") == base.rstrip("/"):
            continue
        if pattern.search(text or "") or pattern.search(p.path):
            if best is None or len(absolute) < len(best):
                best = absolute
    return best
