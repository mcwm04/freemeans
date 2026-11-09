"""toolcheck: schema + cross-file rules. No network."""
import copy
import datetime as dt
import json
from pathlib import Path

import pytest

from toolcheck.check import (DEFAULT_SCHEMA_DIR, DEFAULT_TAXONOMY, DEFAULT_TOOLS_DIR, Directory,
                             check_directory, load_directory, site_key, word_count)

TODAY = dt.date(2026, 11, 9)
TAXONOMY = json.loads(DEFAULT_TAXONOMY.read_text())
GOOD = json.loads((DEFAULT_TOOLS_DIR / "ollama.json").read_text())


def run(tools: dict, taxonomy=None):
    d = Directory(taxonomy if taxonomy is not None else TAXONOMY, tools, [])
    return check_directory(d, DEFAULT_SCHEMA_DIR, today=TODAY)


def variant(**changes):
    t = copy.deepcopy(GOOD)
    for path, value in changes.items():
        node = t
        keys = path.split("__")
        for k in keys[:-1]:
            node = node[k]
        if value is DELETE:
            del node[keys[-1]]
        else:
            node[keys[-1]] = value
    return t


DELETE = object()


def test_repo_directory_is_valid():
    report = check_directory(load_directory(), DEFAULT_SCHEMA_DIR)
    assert report.errors == []
    assert report.tools_checked >= 4


def test_taxonomy_size_matches_plan():
    assert len(TAXONOMY["categories"]) == 25
    assert len(TAXONOMY["tasks"]) >= 80


def test_good_record_passes():
    assert run({"ollama": GOOD}).errors == []


@pytest.mark.parametrize("changes, needle", [
    ({"slug": "other"}, "must equal the file name"),
    ({"slug": "Bad_Slug"}, "does not match"),
    ({"categories": ["not-a-category"]}, "unknown category"),
    ({"tasks": ["fly-to-mars"]}, "unknown task"),
    ({"categories": ["chat", "coding", "image", "video"]}, "is too long"),
    ({"tagline": "The best way to run models on your laptop"}, "marketing word 'best'"),
    ({"tagline": "x" * 121}, "is too long"),
    ({"description": "Too short."}, "words; it needs 80"),
    ({"free_tier__type": "free"}, "is not one of"),
    ({"free_tier__source_url": DELETE}, "'source_url' is a required property"),
    ({"free_tier__verified_at": DELETE}, "'verified_at' is a required property"),
    ({"free_tier__verified_at": "2027-01-01"}, "is in the future"),
    ({"free_tier__verified_at": "9 Nov 2026"}, "does not match"),
    ({"repo_url": None}, "repo_url is required"),
    ({"url": "http://ollama.com"}, "does not match"),
    ({"alternatives": ["ollama"]}, "cannot list itself"),
    ({"status": "draft"}, "is not one of"),
    ({"signals__github_repo": "not a repo"}, "does not match"),
    ({"signals__hf_id": "models/x"}, None),  # owner/name shape is allowed; real existence is checked by the collector
    ({"surprise": 1}, "Additional properties"),
])
def test_bad_records_fail(changes, needle):
    report = run({"ollama": variant(**changes)})
    if needle is None:
        assert report.errors == []
    else:
        assert any(needle in e for e in report.errors), report.errors


def test_quota_requires_period_shape():
    t = variant(free_tier__type="credits", open_source=False, free_tier__quota={"value": 10000, "unit": "characters", "period": "week"})
    assert any("is not one of" in e for e in run({"ollama": t}).errors)


def test_type_none_cannot_have_quota():
    t = variant(free_tier__type="none", free_tier__quota={"value": 5, "unit": "images", "period": "day"})
    assert any("type is 'none'" in e for e in run({"ollama": t}).errors)


def test_unpublished_quota_is_null_not_zero():
    t = variant(free_tier__type="forever_free", free_tier__quota=None)
    assert run({"ollama": t}).errors == []


def test_two_files_for_one_site_fail():
    other = variant(slug="ollama-two")
    report = run({"ollama": GOOD, "ollama-two": other})
    assert any("same site as" in e for e in report.errors)


def test_github_hosted_tools_are_keyed_by_repo():
    assert site_key("https://github.com/openai/whisper") != site_key("https://github.com/ggml-org/llama.cpp")
    assert site_key("https://www.example.ai/pricing") == site_key("https://example.ai")
    assert site_key("https://huggingface.co/spaces/a/b") != site_key("https://huggingface.co/spaces/a/c")


def test_no_external_signal_is_a_warning_not_error():
    t = variant(signals={"trends_term": None, "wikipedia_article": None, "github_repo": None, "hf_id": None,
                         "producthunt_slug": None, "hn_domain": None, "hn_query": None})
    report = run({"ollama": t})
    assert report.errors == []
    assert any("will not be ranked" in w for w in report.warnings)


def test_unknown_alternative_is_a_warning():
    report = run({"ollama": variant(alternatives=["missing-tool"])})
    assert report.errors == []
    assert any("missing-tool" in w for w in report.warnings)


def test_taxonomy_cross_checks():
    tax = copy.deepcopy(TAXONOMY)
    tax["tasks"].append({"id": "orphan", "name": "Orphan", "category": "nope"})
    tax["tasks"].append({"id": "chat", "name": "Clash", "category": "chat"})
    report = run({}, tax)
    assert any("unknown category 'nope'" in e for e in report.errors)
    assert any("also a category id" in e for e in report.errors)


def test_invalid_json_file_is_reported(tmp_path: Path):
    (tmp_path / "broken.json").write_text("{ nope")
    d = load_directory(tmp_path, DEFAULT_TAXONOMY)
    report = check_directory(d, DEFAULT_SCHEMA_DIR, today=TODAY)
    assert any("not valid JSON" in e for e in report.errors)


def test_word_count():
    assert word_count("Free, open-source app's thing") == 4
