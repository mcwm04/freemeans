import datetime as dt
from urllib.parse import parse_qs, urlsplit

import pytest

from signals.http import HostClosed, Http, Response
from signals.sources import github, hackernews, huggingface, wikipedia

from conftest import ts, wiki_items

D = dt.date(2026, 11, 8)


# ---------- Wikipedia ----------

def test_wikipedia_url_encodes_title_and_uses_user_agent_filter():
    url = wikipedia.url_for("Whisper_(speech_recognition_system)", D - dt.timedelta(days=2), D)
    assert "/all-access/user/Whisper_%28speech_recognition_system%29/daily/2026110600/2026110800" in url


def test_wikipedia_parses_views_and_fills_gaps_with_zero(web, http):
    web.add(r"wikimedia\.org", Response(200, wiki_items("Llama.cpp", {D - dt.timedelta(days=2): 50, D: 70})))
    out = wikipedia.fetch(http, "Llama.cpp", D - dt.timedelta(days=2), D)
    assert out.status == "ok"
    assert out.values == {D - dt.timedelta(days=2): {"wiki_views": 50},
                          D - dt.timedelta(days=1): {"wiki_views": 0},
                          D: {"wiki_views": 70}}
    assert "FreemeansBot" in web.headers[0]["User-Agent"] and "@" in web.headers[0]["User-Agent"]


def test_wikipedia_missing_article_is_not_found_not_zero(web, http):
    out = wikipedia.fetch(http, "No_such_article", D, D)
    assert out.status == "not_found" and out.values == {}


# ---------- Hacker News ----------

def hn_answer(hits, nb=None):
    return Response(200, {"hits": hits, "nbHits": len(hits) if nb is None else nb})


def test_hn_domain_match_counts_points_per_utc_day(web, http):
    hits = [
        {"url": "https://ollama.com/blog/x", "points": 120, "created_at_i": ts(D)},
        {"url": "https://www.ollama.com/", "points": 5, "created_at_i": ts(D, 23)},
        {"url": "https://docs.ollama.com/api", "points": 7, "created_at_i": ts(D - dt.timedelta(days=1))},
        {"url": "https://notollama.com/", "points": 999, "created_at_i": ts(D)},       # different domain
        {"url": None, "points": 999, "created_at_i": ts(D)},                            # Ask HN, no link
    ]
    web.add(r"hn\.algolia\.com", hn_answer(hits))
    out = hackernews.fetch(http, D - dt.timedelta(days=2), D, hn_domain="ollama.com")
    assert out.status == "ok"
    assert out.values == {D - dt.timedelta(days=2): {"hn_points": 0},
                          D - dt.timedelta(days=1): {"hn_points": 7},
                          D: {"hn_points": 125}}
    q = parse_qs(urlsplit(web.calls[0]).query)
    assert q["restrictSearchableAttributes"] == ["url"] and q["tags"] == ["story"]
    assert q["numericFilters"] == [f"created_at_i>={ts(D - dt.timedelta(days=2), 0)},created_at_i<{ts(D + dt.timedelta(days=1), 0)}"]


def test_hn_domain_with_path_only_matches_that_repo(web, http):
    hits = [
        {"url": "https://github.com/openai/whisper", "points": 40, "created_at_i": ts(D)},
        {"url": "https://github.com/openai/whisper/discussions/1", "points": 2, "created_at_i": ts(D)},
        {"url": "https://github.com/openai/whisper-fork", "points": 500, "created_at_i": ts(D)},
        {"url": "https://github.com/someone/whisper", "points": 500, "created_at_i": ts(D)},
    ]
    web.add(r"hn\.algolia\.com", hn_answer(hits))
    out = hackernews.fetch(http, D, D, hn_domain="github.com/openai/whisper")
    assert out.values == {D: {"hn_points": 42}}


def test_hn_title_query_matches_whole_term_only(web, http):
    hits = [
        {"title": "Show HN: llama.cpp now runs on phones", "points": 30, "created_at_i": ts(D)},
        {"title": "Why llama.cppx is different", "points": 900, "created_at_i": ts(D)},
        {"title": "Ollama vs llama.cpp", "points": 10, "created_at_i": ts(D)},
    ]
    web.add(r"hn\.algolia\.com", hn_answer(hits))
    out = hackernews.fetch(http, D, D, hn_query="llama.cpp")
    assert out.values == {D: {"hn_points": 40}}


def test_hn_splits_ranges_when_algolia_caps_results(web, http):
    def answer(url):
        q = parse_qs(urlsplit(url).query)["numericFilters"][0]
        lo, hi = [int(p.split("=")[-1].split("<")[-1]) for p in q.split(",")]
        span = (hi - lo) // 86400
        if span > 2:
            return hn_answer([], nb=5000)   # pretend too many hits: forces a split
        day = dt.datetime.fromtimestamp(lo, dt.timezone.utc).date()
        return hn_answer([{"url": "https://ollama.com", "points": 1, "created_at_i": ts(day)}])
    web.add(r"hn\.algolia\.com", answer)
    out = hackernews.fetch(http, D - dt.timedelta(days=9), D, hn_domain="ollama.com")
    assert out.status == "ok"
    assert sum(v["hn_points"] for v in out.values.values()) >= 5
    assert len(web.calls) > 3


def test_hn_failure_is_reported(web, http):
    web.add(r"hn\.algolia\.com", Response(500, None, "HTTP 500"))
    assert hackernews.fetch(http, D, D, hn_domain="ollama.com").status == "failed"


def test_hn_without_config_is_skipped(http):
    assert hackernews.fetch(http, D, D).status == "skipped"


# ---------- GitHub ----------

def test_github_total_and_moved_repo(web, http, monkeypatch):
    monkeypatch.setenv("GITHUB_TOKEN", "t0ken")
    web.add(r"api\.github\.com/repos/ggerganov/llama\.cpp$",
            Response(200, {"full_name": "ggml-org/llama.cpp", "stargazers_count": 90000}))
    out = github.fetch_total(http, "ggerganov/llama.cpp", D)
    assert out.values == {D: {"gh_stars": 90000}}
    assert "moved to ggml-org/llama.cpp" in out.detail
    assert web.headers[0]["Authorization"] == "Bearer t0ken"


def test_github_missing_repo(web, http):
    assert github.fetch_total(http, "nobody/nothing", D).status == "not_found"


def test_github_backfill_rebuilds_running_totals(web, http):
    start = D - dt.timedelta(days=3)
    stars = ([{"starred_at": "2026-10-01T10:00:00Z"}] * 3                      # before the window
             + [{"starred_at": f"{start + dt.timedelta(days=1)}T08:00:00Z"}] * 2
             + [{"starred_at": f"{D}T08:00:00Z"}])
    web.add(r"/repos/a/b$", Response(200, {"full_name": "a/b", "stargazers_count": 6}))
    web.add(r"/repos/a/b/stargazers", Response(200, stars))
    status, out, used = github.backfill(http, "a/b", start, D, budget=50)
    assert status == "done" and used == 2
    assert [out.values[d]["gh_stars"] for d in sorted(out.values)] == [3, 5, 5, 6]
    assert "star+json" in web.headers[1]["Accept"]


def test_github_backfill_too_large_and_budget(web, http):
    web.add(r"/repos/big/repo$", Response(200, {"full_name": "big/repo", "stargazers_count": 150_000}))
    assert github.backfill(http, "big/repo", D - dt.timedelta(days=5), D, 600)[0] == "too_large"
    web.add(r"/repos/mid/repo$", Response(200, {"full_name": "mid/repo", "stargazers_count": 30_000}))
    assert github.backfill(http, "mid/repo", D - dt.timedelta(days=5), D, 100)[0] == "partial"


# ---------- Hugging Face ----------

def test_hf_model_and_space(web, http):
    web.add(r"/api/models/openai/whisper-large-v3$", Response(200, {"likes": 5000, "downloads": 4_000_000}))
    web.add(r"/api/spaces/a/demo$", Response(200, {"likes": 12}))
    assert huggingface.fetch(http, "openai/whisper-large-v3", D).values == {D: {"hf_likes": 5000, "hf_downloads": 4_000_000}}
    assert huggingface.fetch(http, "spaces/a/demo", D).values == {D: {"hf_likes": 12}}
    assert huggingface.fetch(http, "x/missing", D).status == "not_found"


# ---------- HTTP client ----------

def test_http_retries_server_errors_then_succeeds(web):
    answers = iter([Response(503, None, "HTTP 503"), Response(None, None, "timeout"), Response(200, {"ok": 1})])
    web.add(r".", lambda url: next(answers))
    h = Http(web, pause=0, sleep=lambda s: None)
    assert h.get_json("https://x.test/a").data == {"ok": 1}
    assert len(web.calls) == 3


def test_http_closes_host_after_repeated_429(web):
    web.add(r"x\.test", Response(429, None, "HTTP 429", {"retry-after": "1"}))
    h = Http(web, pause=0, sleep=lambda s: None)
    with pytest.raises(HostClosed):
        h.get_json("https://x.test/a")
    with pytest.raises(HostClosed):
        h.get_json("https://x.test/b")
    assert len(web.calls) == 3
    assert h.closed_hosts == {"x.test"}


def test_http_treats_github_403_budget_as_rate_limit(web):
    web.add(r"api\.github\.com", Response(403, None, "HTTP 403", {"x-ratelimit-remaining": "0"}))
    h = Http(web, pause=0, sleep=lambda s: None)
    with pytest.raises(HostClosed):
        h.get_json("https://api.github.com/repos/a/b")
