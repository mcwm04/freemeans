"""Watch phrases and the re-check list (Eligibility PRD, chapter 6). No network."""
import json
from pathlib import Path

from source_check import __main__ as cli
from source_check.check import Page, check_catalog, summary
from source_check.extract import find_phrase, page_text
from source_check.freshness import offers_to_recheck
from source_check.report import markdown, record

ROOT = Path(__file__).resolve().parents[3]
URL = "https://example.com/offer"


def pages(mapping):
    def fetch(url):
        body = mapping.get(url)
        if body is None:
            return Page(url, False, status=404, error="HTTP 404")
        return Page(url, True, page_text(body, "text/html"))
    return fetch


allow_all = lambda url: True  # noqa: E731


def offer(rid="demo.offer", watch=(("December 31, 2026", URL),), **kw):
    r = {
        "id": rid, "name": "Demo offer", "kind": "ai_subscription", "tier_type": "trial", "limit_rules": [],
        "eligibility": {"audiences": ["student_higher_ed"], "countries": {"mode": "global"}, "via": "individual", "proof": ["sheerid"]},
        "badges": [], "last_verified": "2026-11-09", "sources": [{"url": URL, "fetched_at": "2026-11-09", "signal_type": "official_docs"}],
        "watch": [{"text": t, "source_url": u} for t, u in watch], **kw,
    }
    return r


def run(resources, body):
    return check_catalog({"version": "t", "resources": resources}, fetch=pages({URL: body}), allowed=allow_all, pause=0)


# --- find_phrase ----------------------------------------------------------------

def test_phrase_matches_across_line_breaks_case_and_curly_quotes():
    assert find_phrase("Redeem by December  31,\n2026 to get it", "december 31, 2026").status == "found"
    assert find_phrase("Students don’t need a card", "don't need a card").status == "found"


def test_phrase_is_a_whole_word_match():
    assert find_phrase("It costs $1000 a year", "$100").status == "missing"
    assert find_phrase("It costs $100 a year", "$100").status == "found"
    assert find_phrase("Not for students", "student").status == "missing"
    assert find_phrase("anything", "").status == "missing"


# --- check_catalog -----------------------------------------------------------------

def test_phrase_still_on_page_is_confirmed_and_gone_is_missing():
    ok = run([offer()], "<p>Claim by December 31, 2026. No card.</p>" + "<p>filler</p>" * 50)
    assert [(r.metric, r.status) for r in ok] == [("phrase", "confirmed")]
    gone = run([offer()], "<p>The offer has ended.</p>" + "<p>filler</p>" * 50)
    assert gone[0].status == "missing" and gone[0].value == "December 31, 2026"
    assert summary(gone) == {"missing": 1}


def test_unreachable_page_is_reported_not_called_missing():
    res = check_catalog({"version": "t", "resources": [offer()]}, fetch=pages({}), allowed=allow_all, pause=0)
    assert res[0].status == "unreachable"


def test_phrase_and_limit_on_one_page_fetch_it_once():
    fetched = []

    def fetch(url):
        fetched.append(url)
        return Page(url, True, "30 requests per minute. Claim by December 31, 2026.")
    rec = offer()
    rec["limit_rules"] = [{"metric": "rpm", "value": 30, "window": "minute", "published": True, "verified_at": "2026-11-09", "source_url": URL, "signal_type": "official_docs"}]
    res = check_catalog({"version": "t", "resources": [rec]}, fetch=fetch, allowed=allow_all, pause=0)
    assert fetched == [URL] and sorted(r.status for r in res) == ["confirmed", "confirmed"]


# --- re-check list ----------------------------------------------------------------------

def test_recheck_lists_unverified_and_stale_offers_but_not_fresh_or_ended_ones():
    fresh = offer("a.fresh", last_verified="2026-11-09")
    stale = offer("b.stale", last_verified="2026-08-01")
    unver = offer("c.unverified", status="unverified", last_verified="2026-11-09")
    ended = offer("d.ended", status="ended", last_verified="2025-01-01")
    api_tier = {"id": "e.api", "limit_rules": [], "last_verified": "2020-01-01"}
    out = offers_to_recheck([fresh, stale, unver, ended, api_tier], "2026-11-11")
    assert [(x.resource_id, x.reason) for x in out] == [("c.unverified", "unverified"), ("b.stale", "stale")]
    assert out[1].age_days == 102
    assert offers_to_recheck([offer(last_verified="2026-09-12")], "2026-11-11") == [], "exactly 60 days is not stale yet"
    assert len(offers_to_recheck([offer(last_verified="2026-09-11")], "2026-11-11")) == 1


def test_report_names_phrase_file_and_recheck_list():
    res = run([offer(source_file="data/catalog/eligibility.json")], "<p>Gone.</p>" + "<p>filler</p>" * 50)
    rc = offers_to_recheck([offer("c.unverified", status="unverified")], "2026-11-11")
    md = markdown(res, "2026-11-11", "t", rc)
    assert "watch phrase “December 31, 2026”" in md
    assert "File: `data/catalog/eligibility.json`" in md
    assert "## Re-check by hand" in md and "`c.unverified`" in md and "unverified" in md
    assert "Offers to re-check by hand | 1" in md
    assert json.loads(record(res, "2026-11-11", "t", rc))["recheck"][0]["resource_id"] == "c.unverified"
    assert "Re-check by hand" not in markdown(res, "2026-11-11", "t")


# --- command line -------------------------------------------------------------------------

def test_cli_checks_eligibility_watch_phrases_and_writes_the_recheck_count(tmp_path, monkeypatch):
    seed = tmp_path / "seed.json"
    seed.write_text(json.dumps({"version": "s", "resources": []}))
    elig = tmp_path / "eligibility.json"
    gone = offer("x.gone")
    ended = offer("y.ended", status="ended")
    elig.write_text(json.dumps({"version": "e", "resources": [gone, ended, offer("z.unverified", status="unverified")]}))
    gh = tmp_path / "gh"
    monkeypatch.setattr(cli, "check_catalog", lambda c: check_catalog(c, fetch=pages({URL: "<p>nothing here</p>" + "<p>filler</p>" * 50}), allowed=allow_all, pause=0))
    assert cli.main(["--catalog", str(seed), "--tools", "", "--eligibility", str(elig), "--out-dir", str(tmp_path / "out"), "--date", "2026-11-11", "--github-output", str(gh)]) == 0
    out = gh.read_text()
    assert "changes=true" in out and "missing=2" in out, "ended offers are not watched"
    assert "recheck=1" in out
    latest = json.loads((tmp_path / "out/latest.json").read_text())
    assert {r["resource_id"] for r in latest["results"]} == {"x.gone", "z.unverified"}


def test_real_eligibility_file_loads_and_every_watch_url_is_a_listed_source():
    data = json.loads((ROOT / "data/catalog/eligibility.json").read_text(encoding="utf-8"))
    for r in data["resources"]:
        urls = {s["url"] for s in r["sources"]}
        for w in r.get("watch", []):
            assert w["source_url"] in urls, r["id"]
    assert offers_to_recheck(data["resources"], "2026-11-11"), "the unverified offers should be listed"
