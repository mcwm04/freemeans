"""Directory tools in the nightly source check (M3)."""
import json
from pathlib import Path

from source_check.check import Page, check_catalog
from source_check.extract import find_limit
from source_check.report import markdown
from source_check.tools import tools_as_resources


def write(tmp: Path, slug: str, quota, status="published"):
    rec = {"slug": slug, "status": status, "free_tier": {
        "type": "credits", "quota": quota, "source_url": f"https://{slug}.example/pricing", "verified_at": "2026-11-01"}}
    (tmp / f"{slug}.json").write_text(json.dumps(rec))


def test_only_published_tools_with_a_number_are_checked(tmp_path):
    write(tmp_path, "voicey", {"value": 10000, "unit": "characters", "period": "month"})
    write(tmp_path, "vague", None)
    write(tmp_path, "gone", {"value": 5, "unit": "images", "period": "day"}, status="hidden")
    res = tools_as_resources(tmp_path)
    assert [r["id"] for r in res] == ["tools/voicey"]
    rule = res[0]["limit_rules"][0]
    assert rule["metric"] == "tool:characters" and rule["value"] == 10000 and rule["window"] == "month"


def test_quota_found_next_to_its_unit():
    text = "Free plan: 10,000 characters per month. Upgrade for more."
    assert find_limit(text, "tool:characters", 10000).status == "near_unit"
    assert find_limit("Free: 1 credit per character", "tool:credits", 10000).status == "missing"
    assert find_limit("Get 25 image a day", "tool:images", 25).status == "near_unit"


def test_missing_tool_quota_lands_in_the_review_report(tmp_path):
    write(tmp_path, "voicey", {"value": 10000, "unit": "characters", "period": "month"})
    catalog = {"version": "x", "resources": tools_as_resources(tmp_path)}
    pages = {"https://voicey.example/pricing": Page("https://voicey.example/pricing", True, "Free plan now gives 5,000 characters per month.")}
    results = check_catalog(catalog, fetch=lambda u: pages[u], allowed=lambda u: True, pause=0)
    assert results[0].status == "missing"
    md = markdown(results, "2026-11-10", "x")
    assert "data/tools/voicey.json" in md and "5,000 characters" in md
