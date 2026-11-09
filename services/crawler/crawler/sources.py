"""Where new tools come from (PRD 7.2). Official APIs only. Product Hunt stays off until it allows
commercial use; Google and Product Hunt pages are never scraped.

Each source returns Candidates; `buzz` is that source's own attention number (HN points, GitHub
stars of a young repo, Hugging Face likes) and is turned into a percentile per source later.
"""
from __future__ import annotations

import calendar
import datetime as dt
import os
import re
from dataclasses import dataclass
from urllib.parse import urlencode

from signals.http import HostClosed, Http

AI_WORDS = re.compile(r"\b(ai|llm|llms|gpt|agents?|genai|generative|chatbot|copilot|diffusion|transformer|rag|"
                      r"text[- ]to[- ](speech|image|video)|speech[- ]to[- ]text|voice clon\w*|ml|machine learning)\b", re.I)
# Chapter 1 non-goals: never queued.
BLOCKED = re.compile(r"\b(porn|nsfw|nude|undress|onlyfans|casino|betting|gambl\w*|spyware|stalker\w*|deepfake)\b", re.I)


@dataclass
class Candidate:
    url: str
    name: str
    source: str            # hn | github | hf | submit | editor
    source_ref: str
    buzz: float = 0.0


def _ts(d: dt.datetime) -> int:
    return calendar.timegm(d.utctimetuple())


def hacker_news(http: Http, now: dt.datetime, hours: int = 48) -> list[Candidate]:
    """Show HN posts about AI with 20+ points, and other AI stories with 50+ points."""
    since = _ts(now - dt.timedelta(hours=hours))
    out: dict[str, Candidate] = {}
    queries = [
        {"tags": "show_hn", "numericFilters": f"created_at_i>{since},points>=20", "hitsPerPage": 200},
        {"tags": "story", "query": "AI", "restrictSearchableAttributes": "title",
         "numericFilters": f"created_at_i>{since},points>=50", "hitsPerPage": 200},
    ]
    for q in queries:
        res = http.get_json("https://hn.algolia.com/api/v1/search_by_date?" + urlencode(q))
        if not res.ok or not isinstance(res.data, dict):
            continue
        for h in res.data.get("hits", []):
            title, url = h.get("title") or "", h.get("url")
            if not url or not AI_WORDS.search(title):
                continue
            name = re.sub(r"^(show hn|launch hn)\s*:\s*", "", title, flags=re.I).split(" – ")[0].split(" - ")[0].split(":")[0].strip()
            c = Candidate(url, name[:80] or url, "hn", str(h.get("objectID")), float(h.get("points") or 0))
            if c.url not in out or out[c.url].buzz < c.buzz:
                out[c.url] = c
    return list(out.values())


GITHUB_TOPICS = ("llm", "generative-ai", "ai-agents", "ai-tools", "text-to-speech", "stable-diffusion")


def github(http: Http, now: dt.datetime, days: int = 30, min_stars: int = 100) -> list[Candidate]:
    """Young repos with AI topics that already have many stars (fast growers)."""
    headers = {"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"}
    token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"
    since = (now - dt.timedelta(days=days)).date().isoformat()
    out: dict[str, Candidate] = {}
    for topic in GITHUB_TOPICS:
        q = f"topic:{topic} created:>{since} stars:>={min_stars} archived:false"
        res = http.get_json("https://api.github.com/search/repositories?" + urlencode({"q": q, "sort": "stars", "order": "desc", "per_page": 30}), headers)
        if not res.ok or not isinstance(res.data, dict):
            continue
        for r in res.data.get("items", []):
            if r.get("fork"):
                continue
            home = (r.get("homepage") or "").strip()
            url = home if home.startswith(("http://", "https://")) else r.get("html_url")
            full = r.get("full_name", "")
            out[full] = Candidate(url, r.get("name") or full, "github", full, float(r.get("stargazers_count") or 0))
    return list(out.values())


def hugging_face(http: Http, limit: int = 40) -> list[Candidate]:
    """Trending Spaces: usable demo apps, not bare model files."""
    res = http.get_json("https://huggingface.co/api/spaces?" + urlencode({"sort": "trendingScore", "direction": -1, "limit": limit}))
    if not res.ok or not isinstance(res.data, list):
        return []
    out = []
    for s in res.data:
        sid = s.get("id")
        if not sid or s.get("private"):
            continue
        out.append(Candidate(f"https://huggingface.co/spaces/{sid}", sid.split("/")[-1], "hf", sid, float(s.get("likes") or 0)))
    return out


def discover(http: Http, now: dt.datetime, enabled=("hn", "github", "hf")) -> tuple[list[Candidate], dict[str, str]]:
    """All sources; a failing source is reported, never fatal."""
    found: list[Candidate] = []
    problems: dict[str, str] = {}
    runners = {"hn": lambda: hacker_news(http, now), "github": lambda: github(http, now), "hf": lambda: hugging_face(http)}
    for name in enabled:
        try:
            found += runners[name]()
        except HostClosed as e:
            problems[name] = f"{e} rate-limited us"
        except Exception as e:  # one broken source must not stop the others
            problems[name] = f"{type(e).__name__}: {e}"[:200]
    return [c for c in found if not BLOCKED.search(f"{c.name} {c.url}")], problems


def percentiles(cands: list[Candidate]) -> dict[int, float]:
    """Buzz as a 0–1 percentile within each source (PRD 7.4), keyed by id(candidate)."""
    out: dict[int, float] = {}
    by_source: dict[str, list[Candidate]] = {}
    for c in cands:
        by_source.setdefault(c.source, []).append(c)
    for group in by_source.values():
        ranked = sorted(group, key=lambda c: c.buzz)
        n = len(ranked)
        for i, c in enumerate(ranked):
            out[id(c)] = (i + 1) / n if n > 1 else 1.0
    return out
