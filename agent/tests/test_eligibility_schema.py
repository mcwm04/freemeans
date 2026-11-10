"""Eligibility-based offers (Eligibility PRD, Chapter 4): schema and semantic rules."""
import copy
import json

from freemeans.catalog import validate_catalog

from .conftest import REPO

SCHEMAS = REPO / "packages" / "schema"
EXAMPLE = json.loads((REPO / "packages" / "schema" / "examples" / "eligibility.example.json").read_text())


def _one(rid: str) -> dict:
    data = copy.deepcopy(EXAMPLE)
    data["resources"] = [r for r in data["resources"] if r["id"] == rid]
    return data


def test_example_offers_are_valid():
    assert validate_catalog(EXAMPLE, SCHEMAS) == []


def test_auto_renewing_trial_must_carry_the_red_badge():
    data = _one("google.ai-plus-student")
    r = data["resources"][0]
    r["badges"] = [b for b in r["badges"] if b["type"] != "auto_renews_paid"]
    errors = validate_catalog(data, SCHEMAS)
    assert any("needs the auto_renews_paid badge" in e for e in errors)


def test_red_badge_without_auto_renewal_is_rejected():
    data = _one("google.ai-plus-student")
    data["resources"][0]["offer_window"]["after"]["auto_renews"] = False
    errors = validate_catalog(data, SCHEMAS)
    assert any("needs offer_window.after.auto_renews" in e for e in errors)


def test_new_kinds_need_an_eligibility_block():
    data = _one("github.nonprofits")
    del data["resources"][0]["eligibility"]
    errors = validate_catalog(data, SCHEMAS)
    assert any("needs an eligibility block" in e for e in errors)


def test_country_rules():
    data = _one("google.ai-plus-student")
    c = data["resources"][0]["eligibility"]["countries"]
    c["codes"] = ["pk"]  # must be upper-case ISO codes
    assert validate_catalog(data, SCHEMAS)
    c["codes"] = []  # include/exclude needs at least one code
    assert validate_catalog(data, SCHEMAS)
    c["mode"] = "global"  # global with no codes is fine
    assert validate_catalog(data, SCHEMAS) == []
    c["codes"] = ["PK"]  # global must not list codes
    assert validate_catalog(data, SCHEMAS)


def test_unknown_audience_and_proof_are_rejected():
    data = _one("github.nonprofits")
    data["resources"][0]["eligibility"]["audiences"] = ["everyone"]
    data["resources"][0]["eligibility"]["proof"] = ["fake_id"]
    errors = validate_catalog(data, SCHEMAS)
    assert any("everyone" in e for e in errors)
    assert any("fake_id" in e for e in errors)


def test_replaced_by_only_for_ended_offers():
    data = _one("aws.educate-credits")
    assert validate_catalog(data, SCHEMAS) == []
    data["resources"][0]["status"] = "active"
    assert any("only for ended offers" in e for e in validate_catalog(data, SCHEMAS))


def test_watch_phrase_must_use_a_listed_source():
    data = _one("microsoft.azure-for-students")
    data["resources"][0]["watch"][0]["source_url"] = "https://example.com/elsewhere"
    assert any("not in sources" in e for e in validate_catalog(data, SCHEMAS))


def test_year_window_and_seats_metric_are_allowed():
    data = _one("microsoft.azure-for-students")
    rule = copy.deepcopy(data["resources"][0]["limit_rules"][0])
    rule.update(metric="seats", value=300, window="one_time")
    data["resources"][0]["limit_rules"].append(rule)
    assert validate_catalog(data, SCHEMAS) == []
