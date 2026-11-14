import json

import pytest
import yaml

from freemeans.catalog import load_catalog, validate_catalog
from freemeans.config import load_config
from freemeans.policy import PolicyError

from .conftest import REPO

SCHEMAS = REPO / "packages" / "schema"
SEED = REPO / "data" / "catalog" / "seed.json"


def test_seed_catalog_is_valid_and_has_15_resources():
    data = json.loads(SEED.read_text())
    assert validate_catalog(data, SCHEMAS) == []
    assert len(data["resources"]) == 20


def test_every_limit_has_evidence():
    data = json.loads(SEED.read_text())
    for r in data["resources"]:
        assert r["sources"], r["id"]
        for rule in r["limit_rules"]:
            assert rule["source_url"].startswith("https://"), r["id"]
            assert rule["verified_at"], r["id"]


def test_validation_catches_bad_badge_and_duplicate_id():
    data = json.loads(SEED.read_text())
    data["resources"][0]["badges"] = [{"type": "free_forever", "source_url": "https://x.dev"}]
    data["resources"].append(data["resources"][1])
    errors = validate_catalog(data, SCHEMAS)
    assert any("free_forever" in e for e in errors)
    assert any("duplicate id" in e for e in errors)


def test_lowest_value_wins_for_conditional_limits():
    cat = load_catalog(SEED, SCHEMAS)
    lims = cat.get("openrouter.free-models").limits_for("google/gemma-4-31b-it:free")
    assert lims["rpd"].value == 50  # conservative until the user says they bought credits


def test_override_raises_limit(config_path, keys):
    raw = yaml.safe_load(config_path.read_text())
    for d in raw["deployments"]:
        if d["name"] == "openrouter-gemma":
            d["limits_override"] = {"rpd": 1000}
    config_path.write_text(yaml.safe_dump(raw))
    cfg = load_config(config_path)
    assert cfg.deployments["openrouter-gemma"].limits()["rpd"].value == 1000


def test_config_refuses_pooling_two_keys_for_one_provider(config_path):
    raw = yaml.safe_load(config_path.read_text())
    raw["deployments"].append({"name": "groq-second-account", "resource": "groq.gpt-oss-20b",
                               "model": "openai/gpt-oss-20b", "key_env": "GROQ_API_KEY_2"})
    config_path.write_text(yaml.safe_dump(raw))
    with pytest.raises(PolicyError, match="one account/key per provider"):
        load_config(config_path)


def test_config_refuses_manual_only_resources(config_path):
    raw = yaml.safe_load(config_path.read_text())
    raw["deployments"].append({"name": "colab", "resource": "google.colab-free", "model": "x", "key_env": "X"})
    config_path.write_text(yaml.safe_dump(raw))
    with pytest.raises((PolicyError, ValueError)):
        load_config(config_path)
