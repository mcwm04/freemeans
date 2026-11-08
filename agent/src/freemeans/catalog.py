"""Load and validate the free-tier catalog (see packages/schema)."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator
from referencing import Registry, Resource as RefResource


@dataclass(frozen=True)
class Limit:
    metric: str
    value: float | None  # None = provider does not publish it
    window: str
    reset_kind: str
    reset_tz: str | None
    reset_at: str | None
    published: bool
    signal_type: str
    verified_at: str


@dataclass
class CatalogResource:
    id: str
    provider: str
    name: str
    kind: str
    tier_type: str
    base_url: str | None
    endpoint_style: str
    models: list[str]
    limits: list[Limit]
    badges: set[str]
    last_verified: str
    raw: dict[str, Any] = field(repr=False, default_factory=dict)

    def limits_for(self, model: str | None = None) -> dict[str, Limit]:
        """Return one limit per metric for a model.

        When the catalog holds several values for one metric (e.g. OpenRouter's
        50 vs 1,000 requests/day depending on credits bought), the *lowest*
        published value wins. Users override it in freemeans.yaml.
        """
        out: dict[str, Limit] = {}
        for rule, lim in zip(self.raw.get("limit_rules", []), self.limits):
            applies = rule.get("applies_to") or []
            if model and applies and model not in applies:
                continue
            prev = out.get(lim.metric)
            if prev is None:
                out[lim.metric] = lim
            elif lim.value is not None and (prev.value is None or lim.value < prev.value):
                out[lim.metric] = lim
        return out


class Catalog:
    def __init__(self, data: dict[str, Any]):
        self.version: str = data["version"]
        self.generated_at: str = data["generated_at"]
        self.resources: dict[str, CatalogResource] = {}
        for r in data["resources"]:
            ep = r.get("endpoint") or {}
            limits = [
                Limit(
                    metric=x["metric"],
                    value=x["value"],
                    window=x["window"],
                    reset_kind=(x.get("reset") or {}).get("kind", "unknown"),
                    reset_tz=(x.get("reset") or {}).get("tz"),
                    reset_at=(x.get("reset") or {}).get("at"),
                    published=x["published"],
                    signal_type=x["signal_type"],
                    verified_at=x["verified_at"],
                )
                for x in r["limit_rules"]
            ]
            self.resources[r["id"]] = CatalogResource(
                id=r["id"],
                provider=r["provider"],
                name=r["name"],
                kind=r["kind"],
                tier_type=r["tier_type"],
                base_url=ep.get("base_url"),
                endpoint_style=ep.get("style", "none"),
                models=r.get("models", []),
                limits=limits,
                badges={b["type"] for b in r["badges"]},
                last_verified=r["last_verified"],
                raw=r,
            )

    def get(self, resource_id: str) -> CatalogResource:
        try:
            return self.resources[resource_id]
        except KeyError as exc:
            raise KeyError(f"Unknown catalog resource '{resource_id}'") from exc


def find_repo_root(start: Path | None = None) -> Path | None:
    p = (start or Path.cwd()).resolve()
    for candidate in [p, *p.parents]:
        if (candidate / "packages" / "schema" / "catalog.schema.json").exists():
            return candidate
    return None


def build_validator(schema_dir: Path) -> Draft202012Validator:
    schemas = {p.name: json.loads(p.read_text(encoding="utf-8")) for p in schema_dir.glob("*.schema.json")}
    registry = Registry()
    for name, schema in schemas.items():
        res = RefResource.from_contents(schema)
        registry = registry.with_resource(schema["$id"], res).with_resource(name, res)
    return Draft202012Validator(
        schemas["catalog.schema.json"],
        registry=registry,
        format_checker=Draft202012Validator.FORMAT_CHECKER,
    )


def validate_catalog(data: dict[str, Any], schema_dir: Path) -> list[str]:
    """Return a list of human-readable errors (empty = valid)."""
    v = build_validator(schema_dir)
    errors = []
    for e in sorted(v.iter_errors(data), key=lambda e: list(e.absolute_path)):
        path = "/".join(str(p) for p in e.absolute_path) or "<root>"
        errors.append(f"{path}: {e.message}")
    # Semantic checks the schema cannot express
    seen: set[str] = set()
    for i, r in enumerate(data.get("resources", [])):
        rid = r.get("id")
        if rid in seen:
            errors.append(f"resources/{i}/id: duplicate id '{rid}'")
        seen.add(rid)
    return errors


def load_catalog(path: Path, schema_dir: Path | None = None) -> Catalog:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if schema_dir is not None:
        errors = validate_catalog(data, schema_dir)
        if errors:
            raise ValueError("Catalog failed validation:\n  " + "\n  ".join(errors))
    return Catalog(data)
