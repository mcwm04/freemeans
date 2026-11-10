import copy
import datetime as dt
import json

import pytest

from crawler.domain import clean_url, site_key, parse_site
from crawler.draft import assemble, check_numbers, draft_listing, number_near, slugify, validate
from crawler.fetch import Fetcher, RobotsCache, page_text
from crawler.llm import Drafter, NoProvider, Provider
from crawler.run import Stats, run_discover, run_draft
from crawler.sources import BLOCKED, discover, percentiles, Candidate
from crawler.store import MemoryStore
from signals.http import Http, Response

from conftest import DOCS, GOOD_DRAFT, HOME, PRICING, REPO, FakeSite

TODAY = dt.date(2026, 11, 10)
SITE = {"https://voicekit.ai/": HOME, "https://voicekit.ai/pricing": PRICING, "https://voicekit.ai/docs": DOCS}


def fetcher(pages=SITE, robots=lambda u: True):
    return Fetcher(FakeSite(pages), robots=robots, pause=0, sleep=lambda s: None)


def drafter_returning(*answers):
    """Fake LLM: each call returns the next answer (dict → JSON, int → HTTP status)."""
    seq = list(answers)

    def post(url, headers, body):
        a = seq.pop(0)
        if isinstance(a, int):
            return a, None, f"HTTP {a}"
        return 200, {"choices": [{"message": {"content": json.dumps(a)}}]}, ""
    return Drafter([Provider("groq", "https://g/v1", "m", "k"), Provider("gemini", "https://ge/v1", "m2", "k2")], post=post)


# ---------- domain rules (shared with the API) ----------

def test_site_key_matches_shared_cases():
    cases = json.loads((REPO / "packages/schema/site-key-cases.json").read_text())
    for url, key in cases["cases"]:
        assert site_key(url) == key, url
    for bad in cases["invalid"]:
        assert parse_site(bad) is None, bad


def test_clean_url_drops_tracking():
    assert clean_url("https://WWW.x.ai/p?utm_source=hn&id=3#top") == "https://www.x.ai/p?id=3"


# ---------- fetching ----------

def test_fetch_reads_home_pricing_and_docs_within_caps():
    f = fetcher().fetch_tool("https://voicekit.ai/")
    assert f.status == "ok"
    assert set(f.texts) == {"home", "pricing", "docs"}
    assert "10,000 characters" in f.all_text
    assert "var x" not in f.all_text and "© VoiceKit" not in f.all_text   # scripts and footer dropped
    assert len(f.all_text) <= 12_000


def test_fetch_respects_robots_and_reports_dead_and_parked_sites():
    assert fetcher(robots=lambda u: False).fetch_tool("https://voicekit.ai/").status == "blocked"
    dead = fetcher({}).fetch_tool("https://gone.ai/")
    assert dead.status == "dead_site"
    parked = fetcher({"https://p.ai/": "<p>This domain is for sale. Buy this domain today.</p>"}).fetch_tool("https://p.ai/")
    assert parked.status == "parked"


def test_robots_cache_obeys_disallow():
    rc = RobotsCache(lambda url: (200, "User-agent: FreemeansBot\nDisallow: /private\n"))
    assert rc("https://a.ai/") is True
    assert rc("https://a.ai/private/x") is False
    assert RobotsCache(lambda url: (None, ""))("https://b.ai/") is False      # unreachable robots.txt
    assert RobotsCache(lambda url: (404, ""))("https://c.ai/") is True        # no robots.txt


# ---------- number check ----------

def test_number_must_sit_next_to_its_unit():
    text = "Free: 10,000 characters per month, no credit card. Starter: $5 per month."
    assert number_near(text, 10000, ["characters"])
    assert number_near("You get 10k characters", 10000, ["characters"])
    assert not number_near(text, 20000, ["characters"])
    assert not number_near("Founded in 2021. 10000 happy users", 10000, ["characters"])


def test_invented_numbers_are_blanked_and_flagged():
    rec = {"free_tier": {"quota": {"value": 50, "unit": "images", "period": "day"}, "trial_days": 14},
           "pricing": {"cheapest_paid_usd": 9}}
    flags = check_numbers(rec, "Make images with AI. Plans from $5 per month.")
    assert rec["free_tier"]["quota"] is None and rec["free_tier"]["trial_days"] is None
    assert rec["pricing"]["cheapest_paid_usd"] is None
    assert flags == ["number_blanked:free_tier.quota", "number_blanked:free_tier.trial_days", "number_blanked:pricing.cheapest_paid_usd"]


# ---------- assembling and validating ----------

def test_assemble_owns_slug_url_dates_and_drops_unknown_taxonomy(taxonomy):
    pages = {"home": "https://voicekit.ai/", "pricing": "https://voicekit.ai/pricing"}
    raw = copy.deepcopy(GOOD_DRAFT) | {"slug": "evil", "status": "removed"}
    rec = assemble(raw, url="https://voicekit.ai/", key="voicekit.ai", source="hn", source_ref="1", page_urls=pages,
                   taxonomy=taxonomy, taken={"voicekit"}, today=TODAY)
    assert rec["slug"] == "voicekit-2" and rec["status"] == "published" and rec["listed_at"] == "2026-11-10"
    assert rec["categories"] == ["voice"]
    assert rec["free_tier"]["source_url"] == "https://voicekit.ai/pricing"
    assert rec["signals"]["hn_domain"] == "voicekit.ai" and rec["signals"]["wikipedia_article"] is None
    assert validate(rec, taxonomy, TODAY) == []


def test_assemble_never_links_a_page_it_did_not_read(taxonomy):
    raw = copy.deepcopy(GOOD_DRAFT)
    raw["free_tier"]["source_url"] = "https://elsewhere.com/fake"
    rec = assemble(raw, url="https://voicekit.ai/", key="voicekit.ai", source="hn", source_ref=None,
                   page_urls={"home": "https://voicekit.ai/"}, taxonomy=taxonomy, taken=set(), today=TODAY)
    assert rec["free_tier"]["source_url"] == "https://voicekit.ai/"


def test_github_and_space_signals(taxonomy):
    raw = copy.deepcopy(GOOD_DRAFT) | {"open_source": True, "repo_url": None}
    rec = assemble(raw, url="https://github.com/acme/voice", key="github.com/acme/voice", source="github", source_ref="acme/voice",
                   page_urls={"home": "https://github.com/acme/voice"}, taxonomy=taxonomy, taken=set(), today=TODAY)
    assert rec["repo_url"] == "https://github.com/acme/voice" and rec["signals"]["github_repo"] == "acme/voice"
    assert rec["signals"]["hn_domain"] == "github.com/acme/voice"
    sp = assemble(GOOD_DRAFT, url="https://huggingface.co/spaces/a/b", key="huggingface.co/spaces/a/b", source="hf", source_ref="a/b",
                  page_urls={"home": "https://huggingface.co/spaces/a/b"}, taxonomy=taxonomy, taken=set(), today=TODAY)
    assert sp["signals"]["hf_id"] == "spaces/a/b" and sp["signals"]["hn_domain"] is None


def test_slugify_avoids_reserved_and_taken():
    assert slugify("Submit", set()) == "submit-2"
    assert slugify("Café AI!", {"caf-ai"}) == "caf-ai-2"


# ---------- LLM providers ----------

def test_groq_rate_limit_falls_back_to_gemini():
    d = drafter_returning(429, GOOD_DRAFT, GOOD_DRAFT)
    out, provider = d.complete_json("s", "u")
    assert provider == "gemini" and out["name"] == "VoiceKit"
    d.complete_json("s", "u")
    assert d.calls == {"groq": 1, "gemini": 2}, "groq stays paused for the run after a 429"


def test_no_provider_answers():
    with pytest.raises(NoProvider):
        drafter_returning(500, 500).complete_json("s", "u")
    with pytest.raises(NoProvider, match="no LLM key"):
        Drafter([]).complete_json("s", "u")


def test_draft_listing_retries_once_with_the_problems(taxonomy):
    bad = copy.deepcopy(GOOD_DRAFT) | {"description": "Too short."}
    sent = []
    seq = [bad, GOOD_DRAFT]

    def post(url, headers, body):
        sent.append(body["messages"][1]["content"])
        return 200, {"choices": [{"message": {"content": json.dumps(seq.pop(0))}}]}, ""
    d = Drafter([Provider("groq", "https://g/v1", "m", "k")], post=post)
    f = fetcher().fetch_tool("https://voicekit.ai/")
    res = draft_listing(d, f, url="https://voicekit.ai/", source="submit", source_ref=None, hint={"name": "VoiceKit"},
                        taxonomy=taxonomy, taken=set(), today=TODAY)
    assert res["errors"] == [] and len(sent) == 2
    assert "description has" in sent[1]
    assert "Category ids:" in sent[0] and "10,000 characters" in sent[0]
    assert res["record"]["free_tier"]["quota"] == {"value": 10000, "unit": "characters", "period": "month"}
    assert res["evidence"]["free_tier.quota"].startswith("Free: 10,000")


# ---------- sources and queue ----------

def api_web(routes):
    def transport(url, headers):
        for needle, data in routes.items():
            if needle in url:
                return Response(200, data)
        return Response(404, None, "HTTP 404")
    return Http(transport, pause=0, sleep=lambda s: None)


def test_discover_sources_and_blocklist():
    http = api_web({
        "tags=show_hn": {"hits": [{"objectID": "1", "title": "Show HN: VoiceKit – AI voice-overs in your browser", "url": "https://voicekit.ai/?ref=hn", "points": 120},
                                  {"objectID": "2", "title": "Show HN: My new keyboard", "url": "https://kb.dev", "points": 300}]},
        "query=AI": {"hits": [{"objectID": "3", "title": "AI undress app goes viral", "url": "https://bad.ai", "points": 900}]},
        "api.github.com/search": {"items": [{"full_name": "acme/agentkit", "name": "agentkit", "html_url": "https://github.com/acme/agentkit",
                                             "homepage": "", "stargazers_count": 900, "fork": False}]},
        "huggingface.co/api/spaces": [{"id": "a/demo", "likes": 40}],
    })
    cands, problems = discover(http, dt.datetime(2026, 11, 10, tzinfo=dt.timezone.utc))
    assert problems == {}
    assert {(c.source, c.url) for c in cands} == {("hn", "https://voicekit.ai/?ref=hn"), ("github", "https://github.com/acme/agentkit"),
                                                  ("hf", "https://huggingface.co/spaces/a/demo")}
    assert next(c for c in cands if c.source == "hn").name == "VoiceKit"
    assert BLOCKED.search("AI undress app")


def test_percentiles_are_per_source():
    a, b, c = Candidate("u1", "a", "hn", "1", 10), Candidate("u2", "b", "hn", "2", 100), Candidate("u3", "c", "github", "3", 5)
    p = percentiles([a, b, c])
    assert p[id(a)] == 0.5 and p[id(b)] == 1.0 and p[id(c)] == 1.0


def test_discover_skips_published_and_known_sites():
    http = api_web({"tags=show_hn": {"hits": [
        {"objectID": "1", "title": "Show HN: Ollama 2 AI", "url": "https://ollama.com/blog", "points": 50},
        {"objectID": "2", "title": "Show HN: VoiceKit AI", "url": "https://voicekit.ai/", "points": 50},
        {"objectID": "3", "title": "Show HN: VoiceKit app AI", "url": "https://app.voicekit.ai/", "points": 40}]}})
    store, stats = MemoryStore(), Stats()
    run_discover(http, store, dt.datetime(2026, 11, 10, tzinfo=dt.timezone.utc), stats, ("hn",))
    assert [r.domain for r in store.rows.values()] == ["voicekit.ai"]
    assert stats.skipped_known == 2


def test_draft_run_end_to_end(taxonomy):
    store = MemoryStore()
    store.add([{"url": "https://voicekit.ai/", "domain": "voicekit.ai", "source": "submit", "source_ref": None, "name": "VoiceKit", "category": "voice", "priority": 40, "buzz": None},
               {"url": "https://gone.ai/", "domain": "gone.ai", "source": "hn", "source_ref": "9", "name": "Gone", "category": None, "priority": 10, "buzz": 5}])
    stats = Stats()
    run_draft(store, fetcher(), drafter_returning(GOOD_DRAFT), taxonomy, TODAY, stats)
    v, g = store.rows[1], store.rows[2]
    assert v.status == "drafted" and v.priority == 60 and v.draft["slug"] == "voicekit" and v.flags == []
    assert g.status == "new" and g.attempts == 1             # dead once: retried next run
    run_draft(store, fetcher(), drafter_returning(), taxonomy, TODAY, stats)
    assert g.status == "rejected" and g.reject_reason == "dead_site"
    assert stats.ok and stats.drafted == 1


def test_draft_run_without_llm_keeps_candidates_queued(taxonomy):
    store = MemoryStore()
    store.add([{"url": "https://voicekit.ai/", "domain": "voicekit.ai", "source": "submit", "source_ref": None, "name": "V", "category": None, "priority": 0, "buzz": None}])
    stats = Stats()
    run_draft(store, fetcher(), Drafter([]), taxonomy, TODAY, stats)
    assert store.rows[1].status == "new" and store.rows[1].attempts == 0
    assert not stats.ok and "no LLM key" in stats.problems[0]


def test_page_text_finds_links_in_nav():
    text, links = page_text(HOME)
    assert ("/pricing", "Pricing") in links and "Pricing" not in text
