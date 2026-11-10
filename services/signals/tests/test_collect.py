import datetime as dt

import pytest

from signals.cli import main
from signals.collect import backfill, collect_daily, utc_yesterday
from signals.http import Response
from signals.store import MemoryStore
from signals.tools import DEFAULT_TOOLS_DIR, load_tools

from conftest import tool, ts, wiki_items

D = dt.date(2026, 11, 8)


def full_web(web):
    web.add(r"wikimedia\.org", lambda url: Response(200, wiki_items("X", {D - dt.timedelta(days=i): 100 + i for i in range(800)})))
    web.add(r"hn\.algolia\.com", Response(200, {"hits": [{"url": "https://ollama.com", "points": 9, "created_at_i": ts(D)}], "nbHits": 1}))
    web.add(r"api\.github\.com/repos/[^/]+/[^/]+$", Response(200, {"full_name": "ollama/ollama", "stargazers_count": 1000}))
    web.add(r"huggingface\.co/api/models", Response(200, {"likes": 10, "downloads": 20}))


def test_utc_yesterday():
    assert utc_yesterday(dt.datetime(2026, 11, 9, 19, 34, tzinfo=dt.timezone.utc)) == D
    # 00:34 in Pakistan on 10 Nov is still 9 Nov in UTC
    pkt = dt.timezone(dt.timedelta(hours=5))
    assert utc_yesterday(dt.datetime(2026, 11, 10, 0, 34, tzinfo=pkt)) == D


def test_daily_collection_writes_one_wide_row_per_tool_and_day(web, http):
    full_web(web)
    tools = [tool("ollama", wikipedia_article="Ollama", hn_domain="ollama.com", github_repo="ollama/ollama", hf_id="a/b"),
             tool("bare")]
    store = MemoryStore()
    stats = collect_daily(tools, store, http, D)
    assert stats.ok and stats.failure_rate == 0
    row = store.snapshots[("ollama", D)]
    assert row["wiki_views"] == 100 and row["hn_points"] == 9 and row["gh_stars"] == 1000
    assert row["hf_likes"] == 10 and row["hf_downloads"] == 20
    assert row["trends"] is None and row["ph_votes"] is None and row["our_clicks"] is None
    # refreshed days carry wiki and HN only
    assert store.snapshots[("ollama", D - dt.timedelta(days=2))]["gh_stars"] is None
    # a tool with nothing configured still gets an all-NULL row for the day
    assert all(v is None for v in store.snapshots[("bare", D)].values())
    assert "✅ OK" in stats.markdown()


def test_values_are_never_overwritten_with_null():
    store = MemoryStore()
    store.upsert_snapshots({("a", D): {"gh_stars": 5}})
    store.upsert_snapshots({("a", D): {"wiki_views": 7, "gh_stars": None}})
    assert store.snapshots[("a", D)]["gh_stars"] == 5 and store.snapshots[("a", D)]["wiki_views"] == 7
    with pytest.raises(ValueError):
        store.upsert_snapshots({("a", D): {"sponsor_paid": 1}})


def test_run_is_not_ok_above_30_percent_failures(web, http):
    web.add(r"api\.github\.com", Response(500, None, "HTTP 500"))
    web.add(r"wikimedia\.org", Response(200, wiki_items("X", {D: 1})))
    tools = [tool(f"t{i}", github_repo=f"o/r{i}", wikipedia_article="X") for i in range(4)]
    stats = collect_daily(tools, MemoryStore(), http, D)
    assert stats.failure_rate == 0.5 and not stats.ok
    assert "NOT OK" in stats.markdown() and "t0 · github · failed" in stats.markdown()


def test_wrong_wikipedia_title_is_listed_but_does_not_fail_the_run(web, http):
    stats = collect_daily([tool("x", wikipedia_article="Nope")], MemoryStore(), http, D)
    assert stats.ok
    assert any("x · wiki · not_found" in p for p in stats.problems)


def test_clicks_are_null_until_go_links_are_live(web, http, monkeypatch):
    store = MemoryStore(click_rows={("a", D): 4})
    monkeypatch.delenv("FREEMEANS_CLICKS_SINCE", raising=False)
    collect_daily([tool("a"), tool("b")], store, http, D)
    assert store.snapshots[("a", D)]["our_clicks"] is None
    monkeypatch.setenv("FREEMEANS_CLICKS_SINCE", (D - dt.timedelta(days=1)).isoformat())
    collect_daily([tool("a"), tool("b")], store, http, D)
    assert store.snapshots[("a", D)]["our_clicks"] == 4
    assert store.snapshots[("b", D)]["our_clicks"] == 0                       # measured: really zero
    assert ("b", D - dt.timedelta(days=2)) not in store.snapshots                 # before launch: no value


def test_backfill_loads_two_years_once(web, http):
    full_web(web)
    store = MemoryStore()
    t = tool("ollama", wikipedia_article="Ollama", hn_domain="ollama.com")
    stats = backfill([t], store, http, D, years=2, signals=("wiki", "hn"))
    assert stats.ok
    days = sorted(d for (s, d) in store.snapshots)
    assert days[0] == D - dt.timedelta(days=730) and days[-1] == D
    assert store.backfills() == {("ollama", "wiki"): "done", ("ollama", "hn"): "done"}
    calls = len(web.calls)
    backfill([t], store, http, D, years=2, signals=("wiki", "hn"))
    assert len(web.calls) == calls          # finished work is skipped


def test_backfill_github_respects_budget(web, http):
    web.add(r"/repos/o/r\d$", Response(200, {"full_name": "x", "stargazers_count": 250}))
    web.add(r"/stargazers", Response(200, [{"starred_at": f"{D}T00:00:00Z"}] * 100))
    store = MemoryStore()
    tools = [tool(f"t{i}", github_repo=f"o/r{i}") for i in range(3)]
    stats = backfill(tools, store, http, D, signals=("github",), gh_budget=6)
    assert store.backfills() == {("t0", "github"): "done"}     # t0 used 4, t1 needs 4 > 2 left
    assert stats.ok


def test_cli_dry_run_on_repo_tools(web, monkeypatch, capsys, tmp_path):
    full_web(web)
    monkeypatch.setattr("signals.cli.Http", lambda pause: __import__("signals.http", fromlist=["Http"]).Http(web, pause=0, sleep=lambda s: None))
    summary = tmp_path / "summary.md"
    monkeypatch.setenv("GITHUB_STEP_SUMMARY", str(summary))
    assert main(["collect", "--dry-run", "--day", D.isoformat()]) == 0
    out = capsys.readouterr().out
    assert "Signal collection" in out and "dry run" in out
    assert "Signal collection" in summary.read_text()


def test_cli_needs_database_url(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main(["collect"]) == 2


def test_repo_tools_load():
    tools = load_tools(DEFAULT_TOOLS_DIR)
    starters = {"ollama", "llama-cpp", "openai-whisper", "comfyui"}
    assert {t.slug for t in tools} >= starters
    # Tools added later (a website, a blog post) may have no repo; a missing signal is skipped, not counted as zero.
    assert all(t.sig("github_repo") for t in tools if t.slug in starters)
