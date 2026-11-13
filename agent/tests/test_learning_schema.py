"""Free courses and certifications (Eligibility PRD, Chapter 11): schema and semantic rules."""
import copy
import json

from freemeans.catalog import validate_catalog

from .conftest import REPO

SCHEMAS = REPO / "packages" / "schema"
EXAMPLE = json.loads((SCHEMAS / "examples" / "learning.example.json").read_text())


def _one(rid: str) -> dict:
    data = copy.deepcopy(EXAMPLE)
    data["resources"] = [r for r in data["resources"] if r["id"] == rid]
    return data


def test_example_courses_are_valid():
    assert validate_catalog(EXAMPLE, SCHEMAS) == []


def test_real_eligibility_file_is_still_valid_with_the_learning_rules():
    data = json.loads((REPO / "data" / "catalog" / "eligibility.json").read_text(encoding="utf-8"))
    assert validate_catalog(data, SCHEMAS) == []
    courses = [r for r in data["resources"] if r["kind"] in ("course", "certification") and r.get("status") not in ("unverified", "ended")]
    assert courses and all("learning" in r for r in courses)


def test_course_needs_a_learning_block():
    data = _one("example.cohort-course")
    del data["resources"][0]["learning"]
    assert any("needs a learning block" in e for e in validate_catalog(data, SCHEMAS))


def test_unverified_and_ended_courses_may_leave_the_learning_block_out():
    for status in ("unverified", "ended"):
        data = _one("example.cohort-course")
        r = data["resources"][0]
        del r["learning"]
        r["status"] = status
        assert validate_catalog(data, SCHEMAS) == [], status


def test_learning_block_is_only_for_courses_and_certifications():
    data = _one("example.cohort-course")
    data["resources"][0]["kind"] = "saas_plan"
    assert any("only for kinds course and certification" in e for e in validate_catalog(data, SCHEMAS))


def test_paid_certificate_is_flagged_both_ways():
    data = _one("example.paid-certificate-course")
    data["resources"][0]["badges"] = []
    assert any("needs the paid_certificate badge" in e for e in validate_catalog(data, SCHEMAS))

    data = _one("example.cohort-course")  # certificate: free
    data["resources"][0]["badges"] = [{"type": "paid_certificate", "source_url": "https://example.com/p"}]
    assert any("needs learning.certificate = paid_required" in e for e in validate_catalog(data, SCHEMAS))

    data = _one("example.paid-certificate-course")
    data["resources"][0]["learning"]["certificate"] = "paid_optional"  # optional is not a trap, so no red flag
    assert any("needs learning.certificate = paid_required" in e for e in validate_catalog(data, SCHEMAS))


def test_enums_and_formats_are_enforced():
    data = _one("example.cohort-course")
    learning = data["resources"][0]["learning"]
    learning["format"] = "video"
    learning["certificate"] = "maybe"
    learning["languages"] = ["English"]
    learning["hours"] = 0
    learning["roles"] = ["Data Analyst"]
    errors = " ".join(validate_catalog(data, SCHEMAS))
    for needle in ("video", "maybe", "English", "Data Analyst"):
        assert needle in errors, needle
    assert "0 is less than or equal to the minimum of 0" in errors or "exclusiveMinimum" in errors or "greater than" in errors


def test_format_and_certificate_are_required():
    data = _one("example.badge-only-training")
    del data["resources"][0]["learning"]["certificate"]
    assert any("certificate" in e and "required" in e for e in validate_catalog(data, SCHEMAS))


def test_real_learning_file_is_valid_and_sourced():
    data = json.loads((REPO / "data" / "catalog" / "learning.json").read_text(encoding="utf-8"))
    assert validate_catalog(data, SCHEMAS) == []
    ids = [r["id"] for r in data["resources"]]
    assert len(ids) == len(set(ids))
    eligibility = json.loads((REPO / "data" / "catalog" / "eligibility.json").read_text(encoding="utf-8"))
    seed = json.loads((REPO / "data" / "catalog" / "seed.json").read_text(encoding="utf-8"))
    other = {r["id"] for r in eligibility["resources"]} | {r["id"] for r in seed["resources"]}
    assert not set(ids) & other, "ids must be unique across the three catalog files"
    for r in data["resources"]:
        assert r["learning"], r["id"]
        assert r["sources"] and r["last_verified"], r["id"]
