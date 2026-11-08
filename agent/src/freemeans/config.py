"""Load freemeans.yaml and join it with the catalog."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

from .catalog import Catalog, CatalogResource, Limit, find_repo_root, load_catalog
from .policy import PolicyError, ProjectPolicy, check_one_account_per_provider


@dataclass
class Deployment:
    name: str
    resource: CatalogResource
    model: str
    key_env: str
    quality: float = 1.0
    context_tokens: int | None = None
    supports_tools: bool = True
    limit_overrides: dict[str, float] = field(default_factory=dict)

    @property
    def provider(self) -> str:
        return self.resource.provider

    def limits(self) -> dict[str, Limit]:
        lims = dict(self.resource.limits_for(self.model))
        for metric, value in self.limit_overrides.items():
            base = lims.get(metric)
            lims[metric] = Limit(
                metric=metric,
                value=float(value),
                window=base.window if base else _window_for(metric),
                reset_kind=base.reset_kind if base else "unknown",
                reset_tz=base.reset_tz if base else None,
                reset_at=base.reset_at if base else None,
                published=True,
                signal_type="user_override",
                verified_at=base.verified_at if base else "",
            )
        return lims


def _window_for(metric: str) -> str:
    return {"rps": "second", "rpm": "minute", "tpm": "minute", "rpd": "day", "tpd": "day"}.get(metric, "day")


@dataclass
class Config:
    host: str
    port: int
    db_path: Path
    catalog: Catalog
    deployments: dict[str, Deployment]
    models: dict[str, list[str]]
    projects: dict[str, ProjectPolicy]

    def project(self, name: str | None) -> ProjectPolicy:
        name = name or "default"
        if name not in self.projects:
            raise PolicyError(f"Unknown project '{name}'. Define it under 'projects:' in freemeans.yaml.")
        return self.projects[name]


def load_config(path: Path) -> Config:
    path = Path(path).resolve()
    raw: dict[str, Any] = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    base = path.parent

    catalog_path = (base / raw.get("catalog", "../data/catalog/seed.json")).resolve()
    root = find_repo_root(catalog_path.parent)
    schema_dir = root / "packages" / "schema" if root else None
    catalog = load_catalog(catalog_path, schema_dir)

    listen = raw.get("listen") or {}
    host = listen.get("host", "127.0.0.1")
    port = int(listen.get("port", 4000))

    dep_raw = raw.get("deployments") or []
    deployments: dict[str, Deployment] = {}
    flat = []
    for d in dep_raw:
        res = catalog.get(d["resource"])
        if res.endpoint_style != "openai_compatible":
            raise ValueError(
                f"Deployment '{d['name']}': resource '{res.id}' has no OpenAI-compatible endpoint; "
                "the prototype router only supports those."
            )
        if "manual_only" in res.badges:
            raise PolicyError(f"Deployment '{d['name']}': '{res.id}' is manual_only and cannot be routed.")
        dep = Deployment(
            name=d["name"],
            resource=res,
            model=d["model"],
            key_env=d["key_env"],
            quality=float(d.get("quality", 1.0)),
            context_tokens=d.get("context_tokens"),
            supports_tools=bool(d.get("supports_tools", True)),
            limit_overrides={k: float(v) for k, v in (d.get("limits_override") or {}).items()},
        )
        if dep.name in deployments:
            raise ValueError(f"Duplicate deployment name '{dep.name}'")
        deployments[dep.name] = dep
        flat.append({"provider": res.provider, "key_env": dep.key_env})
    check_one_account_per_provider(flat)

    models = {k: list(v) for k, v in (raw.get("models") or {}).items()}
    for logical, names in models.items():
        for n in names:
            if n not in deployments:
                raise ValueError(f"Model '{logical}' refers to unknown deployment '{n}'")

    projects = {n: ProjectPolicy.from_dict(n, p) for n, p in (raw.get("projects") or {}).items()}
    projects.setdefault("default", ProjectPolicy())

    db_path = Path(raw.get("db_path", "~/.freemeans/usage.sqlite3")).expanduser()
    if not db_path.is_absolute():
        db_path = (base / db_path).resolve()

    return Config(host, port, db_path, catalog, deployments, models, projects)
