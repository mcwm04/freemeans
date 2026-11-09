"""Tests for the nightly source check. No network: pages come from a fake fetcher."""
import json
from pathlib import Path

import pytest

from source_check import __main__ as cli
from source_check.check import Page, Robots, check_catalog, summary
from source_check.extract import find_limit, number_variants, page_text
from source_check.report import markdown

ROOT = Path(__file__).resolve().parents[3]
SEED = json.loads((ROOT / "data/catalog/seed.json").read_text(encoding="utf-8"))
FIX = Path(__file__).parent / "fixtures"


def rule(metric, value, url="https://example.com/limits", window="minute", **kw):
    return {"metric": metric, "value": value, "window": window, "reset": {"kind": "rolling"}, "published": True,
            "verified_at": "2026-10-22", "source_url": url, "signal_type": "official_docs", **kw}


def catalog(*rules, rid="demo.free"):
    return {"version": "t", "resources": [{"id": rid, "limit_rules": list(rules)}]}


def pages(mapping):
    def fetch(url):
        body = mapping.get(url)
        if body is None:
            return Page(url, False, status=404, error="HTTP 404")
        return Page(url, True, page_text(body, "text/html"))
    return fetch


allow_all = lambda url: True  # noqa: E731


# --- extract ---------------------------------------------------------------

def test_number_variants_cover_common_spellings():
    v = number_variants(14400)
    for s in ["14400", "14,400", "14 400", "14.4K", "14.4k"]:
        assert s in v
    assert "1M" in number_variants(1_000_000)
    assert number_variants(0.5) == ["0.5"]


def test_page_text_drops_scripts_and_keeps_table_text():
    html = (FIX / "groq_limits.html").read_text(encoding="utf-8")
    text = page_text(html, "text/html")
    assert "tracking" not in text  # inside <script>
    assert "14,400" in text
    assert "llama-3.1-8b-instant" in text


def test_number_must_not_be_part_of_a_bigger_number():
    assert find_limit("Limit: 10,000 requests per day", "rpd", 1000).status == "missing"
    assert find_limit("Limit: 1,000.5 per day", "rpd", 1000).status == "missing"
    assert find_limit("Up to 1,000 requests per day", "rpd", 1000).status == "near_unit"


def test_unit_proximity_decides_confirmed_or_weak():
    assert find_limit("Free plan: 30 requests per minute.", "rpm", 30).status == "near_unit"
    far = "Founded in 30 AD. " + "x " * 200 + " requests per minute vary."
    assert find_limit(far, "rpm", 30).status == "number_only"


def test_missing_number_collects_what_the_page_says_now():
    m = find_limit("Free tier: 20 requests per minute and 25 requests per day.", "rpd", 50)
    assert m.status == "missing"
    assert any("25 requests per day" in n for n in m.nearby)


# --- check -----------------------------------------------------------------

def test_check_confirms_unchanged_and_flags_changed_limits():
    html = (FIX / "groq_limits.html").read_text(encoding="utf-8")
    url = "https://console.groq.com/docs/rate-limits"
    cat = catalog(
        rule("rpm", 30, url),
        rule("rpd", 14400, url, window="day"),
        rule("tpm", 6000, url),          # page now says 8,000 → changed
    )
    res = check_catalog(cat, fetch=pages({url: html}), allowed=allow_all, pause=0)
    assert [r.status for r in res] == ["confirmed", "confirmed", "missing"]
    assert any("8,000" in n for n in res[2].nearby)


def test_each_page_is_fetched_once():
    calls = []

    def fetch(url):
        calls.append(url)
        return Page(url, True, "30 requests per minute, 1,000 requests per day")

    cat = catalog(rule("rpm", 30), rule("rpd", 1000, window="day"))
    check_catalog(cat, fetch=fetch, allowed=allow_all, pause=0)
    assert calls == ["https://example.com/limits"]


def test_unreachable_pages_robots_and_unpublished_limits():
    cat = catalog(
        rule("rpm", 30, "https://gone.example/x"),
        rule("rpm", 30, "https://private.example/x"),
        rule("rpm", None, "https://example.com/limits", published=False),
    )
    res = check_catalog(cat, fetch=pages({}), allowed=lambda u: "private" not in u, pause=0)
    assert [r.status for r in res] == ["unreachable", "unreachable", "skipped"]
    assert "robots.txt" in res[1].detail
    assert res[0].detail == "HTTP 404"


def test_real_seed_catalog_runs_end_to_end_offline():
    """Every seed rule gets a result; with no network all published rules are 'unreachable'."""
    res = check_catalog(SEED, fetch=pages({}), allowed=allow_all, pause=0)
    total = sum(len(r["limit_rules"]) for r in SEED["resources"])
    assert len(res) == total
    s = summary(res)
    assert set(s) <= {"unreachable", "skipped"}
    assert s.get("skipped", 0) == sum(
        1 for r in SEED["resources"] for l in r["limit_rules"] if l.get("value") is None or l.get("published") is False
    )


# --- report and CLI --------------------------------------------------------

def test_report_lists_changes_first_with_fix_instructions():
    url = "https://example.com/limits"
    cat = catalog(rule("rpd", 50, url, window="day"), rule("rpm", 20, url))
    res = check_catalog(cat, fetch=pages({url: "<p>Free: 20 requests per minute and 25 requests per day.</p>" + "<p>filler</p>" * 50}),
                        allowed=allow_all, pause=0)
    md = markdown(res, "2026-11-09", "t")
    assert md.index("Possibly changed") < md.index("Still matches")
    assert "`demo.free` · rpd = 50 per day" in md
    assert "25 requests per day" in md
    assert "edit `data/catalog/seed.json`" in md


def test_cli_writes_reports_and_github_output(tmp_path, monkeypatch):
    url = "https://example.com/limits"
    cat = catalog(rule("rpm", 30, url), rule("rpd", 50, url, window="day"))
    cat_file = tmp_path / "cat.json"
    cat_file.write_text(json.dumps(cat))
    gh = tmp_path / "gh_out"
    monkeypatch.setattr(cli, "check_catalog", lambda c: check_catalog(
        c, fetch=pages({url: "<p>30 requests per minute; 25 requests per day</p>"}), allowed=allow_all, pause=0))
    assert cli.main(["--catalog", str(cat_file), "--out-dir", str(tmp_path / "out"), "--date", "2026-11-09", "--github-output", str(gh)]) == 0
    out = gh.read_text()
    assert "changes=true" in out and "missing=1" in out
    assert (tmp_path / "out/2026-11-09.md").exists()
    assert json.loads((tmp_path / "out/latest.json").read_text())["summary"] == {"confirmed": 1, "missing": 1}


def test_cli_no_changes_writes_no_dated_report(tmp_path, monkeypatch):
    url = "https://example.com/limits"
    cat_file = tmp_path / "cat.json"
    cat_file.write_text(json.dumps(catalog(rule("rpm", 30, url))))
    gh = tmp_path / "gh_out"
    monkeypatch.setattr(cli, "check_catalog", lambda c: check_catalog(
        c, fetch=pages({url: "<p>30 requests per minute</p>"}), allowed=allow_all, pause=0))
    cli.main(["--catalog", str(cat_file), "--out-dir", str(tmp_path / "out"), "--date", "2026-11-09", "--github-output", str(gh)])
    assert "changes=false" in gh.read_text()
    assert not (tmp_path / "out/2026-11-09.md").exists()
    assert (tmp_path / "out/latest.md").exists()


# --- robots.txt (RFC 9309) ----------------------------------------------------

def robots_from(table):
    calls = []

    def fetch(url):
        calls.append(url)
        return table.get(url, (404, ""))
    return fetch, calls


def test_robots_403_on_robots_txt_means_allowed_not_blocked():
    """The bug from the first live run: a 403 on robots.txt itself is not a ban (RFC 9309 §2.3.1.3)."""
    fetch, _ = robots_from({"https://docs.example.com/robots.txt": (403, "")})
    assert Robots(fetch)("https://docs.example.com/limits.md") is True


def test_robots_rules_are_obeyed_for_our_agent_and_for_everyone():
    fetch, _ = robots_from({
        "https://a.example/robots.txt": (200, "User-agent: FreemeansBot\nDisallow: /private/\n"),
        "https://b.example/robots.txt": (200, "User-agent: *\nDisallow: /\n"),
        "https://c.example/robots.txt": (200, "User-agent: GPTBot\nDisallow: /\n"),
    })
    r = Robots(fetch)
    assert r("https://a.example/private/x") == "robots.txt does not allow this page"
    assert r("https://a.example/docs/limits") is True
    assert r("https://b.example/anything") == "robots.txt does not allow this page"
    assert r("https://c.example/limits") is True  # a rule for another bot does not apply to us


def test_robots_server_error_or_no_connection_means_closed():
    fetch, _ = robots_from({"https://down.example/robots.txt": (503, ""), "https://gone.example/robots.txt": (None, "")})
    r = Robots(fetch)
    assert "HTTP 503" in r("https://down.example/x")
    assert "no connection" in r("https://gone.example/x")


def test_robots_txt_is_fetched_once_per_site():
    fetch, calls = robots_from({"https://a.example/robots.txt": (200, "User-agent: *\nAllow: /\n")})
    r = Robots(fetch)
    r("https://a.example/1"), r("https://a.example/2")
    assert calls == ["https://a.example/robots.txt"]


def test_check_reports_the_robots_reason():
    url = "https://b.example/limits"
    fetch, _ = robots_from({"https://b.example/robots.txt": (200, "User-agent: *\nDisallow: /\n")})
    res = check_catalog(catalog(rule("rpm", 30, url)), fetch=pages({url: "30 requests per minute"}), allowed=Robots(fetch), pause=0)
    assert res[0].status == "unreachable"
    assert res[0].detail == "robots.txt does not allow this page"
