"""Validate data/tools/*.json and data/taxonomy.json.

Two layers:
1. JSON Schema (packages/schema/tool.schema.json, taxonomy.schema.json) for the shape of each file.
2. Rules a schema cannot express: slug = file name, taxonomy references, word counts,
   marketing words, one tool per domain, dates not in the future, and so on.

Errors fail CI. Warnings are printed but do not fail the build.
"""
from __future__ import annotations

import datetime as dt
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

from jsonschema import Draft202012Validator

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_TOOLS_DIR = REPO_ROOT / "data" / "tools"
DEFAULT_TAXONOMY = REPO_ROOT / "data" / "taxonomy.json"
DEFAULT_SCHEMA_DIR = REPO_ROOT / "packages" / "schema"

# Words a tagline may not use (PRD 5.1: no marketing words).
BANNED_TAGLINE_WORDS = [
    "best", "revolutionary", "ultimate", "#1", "number one", "world's", "worlds",
    "game-changing", "game changer", "cutting-edge", "leading", "unparalleled",
    "amazing", "incredible", "powerful", "seamless", "next-gen", "groundbreaking",
]
DESCRIPTION_WORDS = (80, 150)
MAX_CATEGORIES_IN_TAXONOMY = 40


@dataclass
class Report:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    tools_checked: int = 0

    @property
    def ok(self) -> bool:
        return not self.errors

    def error(self, where: str, msg: str) -> None:
        self.errors.append(f"{where}: {msg}")

    def warn(self, where: str, msg: str) -> None:
        self.warnings.append(f"{where}: {msg}")


@dataclass
class Directory:
    taxonomy: dict | None
    tools: dict[str, dict]          # file stem -> parsed record
    load_errors: list[str]


def load_directory(tools_dir: Path = DEFAULT_TOOLS_DIR, taxonomy_path: Path = DEFAULT_TAXONOMY) -> Directory:
    errors: list[str] = []
    taxonomy = None
    try:
        taxonomy = json.loads(taxonomy_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        errors.append(f"{taxonomy_path.name}: file not found")
    except json.JSONDecodeError as e:
        errors.append(f"{taxonomy_path.name}: not valid JSON ({e})")

    tools: dict[str, dict] = {}
    if tools_dir.is_dir():
        for path in sorted(tools_dir.glob("*.json")):
            try:
                tools[path.stem] = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as e:
                errors.append(f"tools/{path.name}: not valid JSON ({e})")
    return Directory(taxonomy, tools, errors)


def _validator(schema_dir: Path, name: str) -> Draft202012Validator:
    schema = json.loads((schema_dir / name).read_text(encoding="utf-8"))
    Draft202012Validator.check_schema(schema)
    return Draft202012Validator(schema, format_checker=Draft202012Validator.FORMAT_CHECKER)


def _schema_errors(validator: Draft202012Validator, data: object) -> list[str]:
    out = []
    for err in sorted(validator.iter_errors(data), key=lambda e: list(e.absolute_path)):
        where = "/".join(str(p) for p in err.absolute_path) or "(root)"
        out.append(f"{where}: {err.message}")
    return out


# Shared platforms where one host holds many tools: key them by host + owner/name (PRD 7.1).
PATH_KEYED_HOSTS = {"github.com", "huggingface.co", "gitlab.com", "codeberg.org"}


def registrable_host(url: str) -> str:
    """Host without a leading www."""
    host = (urlsplit(url).hostname or "").lower()
    return host[4:] if host.startswith("www.") else host


def site_key(url: str) -> str:
    """Identity of a tool's site for de-duplication: the host, or host/owner/name on shared platforms."""
    host = registrable_host(url)
    parts = [p for p in urlsplit(url).path.lower().split("/") if p]
    if host == "huggingface.co" and parts[:1] == ["spaces"]:
        return "/".join([host] + parts[:3])
    if host in PATH_KEYED_HOSTS:
        return "/".join([host] + parts[:2])
    return host  # subdomains such as x.vercel.app stay distinct because the full host is kept


def word_count(text: str) -> int:
    return len(re.findall(r"[\w'’-]+", text))


def _parse_date(value: str) -> dt.date | None:
    try:
        return dt.date.fromisoformat(value)
    except (TypeError, ValueError):
        return None


def check_taxonomy(taxonomy: dict, report: Report, validator: Draft202012Validator) -> tuple[set[str], set[str]]:
    for msg in _schema_errors(validator, taxonomy):
        report.error("taxonomy.json", msg)
    cats = [c.get("id") for c in taxonomy.get("categories", []) if isinstance(c, dict)]
    tasks = [t for t in taxonomy.get("tasks", []) if isinstance(t, dict)]
    cat_ids, task_ids = set(), set()
    for c in cats:
        if c in cat_ids:
            report.error("taxonomy.json", f"duplicate category id {c!r}")
        cat_ids.add(c)
    for t in tasks:
        tid = t.get("id")
        if tid in task_ids:
            report.error("taxonomy.json", f"duplicate task id {tid!r}")
        if tid in cat_ids:
            report.error("taxonomy.json", f"task id {tid!r} is also a category id (URLs would clash)")
        task_ids.add(tid)
        if t.get("category") not in cat_ids:
            report.error("taxonomy.json", f"task {tid!r} points to unknown category {t.get('category')!r}")
    used = {t.get("category") for t in tasks}
    for c in sorted(cat_ids - used):
        report.warn("taxonomy.json", f"category {c!r} has no tasks yet")
    return cat_ids, task_ids


def check_tool(stem: str, tool: dict, report: Report, validator: Draft202012Validator,
               cat_ids: set[str], task_ids: set[str], today: dt.date) -> None:
    where = f"tools/{stem}.json"
    schema_msgs = _schema_errors(validator, tool)
    for msg in schema_msgs:
        report.error(where, msg)
    if not isinstance(tool, dict):
        return

    slug = tool.get("slug")
    if slug != stem:
        report.error(where, f"slug {slug!r} must equal the file name {stem!r}")

    for c in tool.get("categories") or []:
        if c not in cat_ids:
            report.error(where, f"unknown category {c!r} (add it to taxonomy.json first)")
    for t in tool.get("tasks") or []:
        if t not in task_ids:
            report.error(where, f"unknown task {t!r} (add it to taxonomy.json first)")

    tagline = tool.get("tagline") or ""
    low = tagline.lower()
    for w in BANNED_TAGLINE_WORDS:
        if re.search(rf"(?<![\w-]){re.escape(w)}(?![\w-])", low):
            report.error(where, f"tagline uses the marketing word {w!r}")

    desc = tool.get("description") or ""
    n = word_count(desc)
    if not (DESCRIPTION_WORDS[0] <= n <= DESCRIPTION_WORDS[1]):
        report.error(where, f"description has {n} words; it needs {DESCRIPTION_WORDS[0]}–{DESCRIPTION_WORDS[1]}")

    ft = tool.get("free_tier") or {}
    ftype = ft.get("type")
    if ftype == "none" and ft.get("quota"):
        report.error(where, "free_tier.type is 'none' but a quota is set")
    if ftype == "trial" and not ft.get("trial_days"):
        report.warn(where, "free_tier.type is 'trial' but trial_days is empty")
    if ftype != "trial" and ft.get("trial_days"):
        report.error(where, "trial_days is set but free_tier.type is not 'trial'")
    if ftype == "open_source" and tool.get("open_source") is not True:
        report.error(where, "free_tier.type is 'open_source' but open_source is not true")
    if tool.get("open_source") is True:
        if not tool.get("repo_url"):
            report.error(where, "open_source is true, so repo_url is required")
        if not tool.get("license"):
            report.warn(where, "open_source is true but license is empty")
    quota = ft.get("quota")
    if isinstance(quota, dict) and quota.get("value") is not None and quota.get("period") is None and ftype != "open_source":
        report.warn(where, "quota has a value but no period (day, month or once)")

    for label, value in (("listed_at", tool.get("listed_at")),
                         ("free_tier.verified_at", ft.get("verified_at")),
                         ("pricing.verified_at", (tool.get("pricing") or {}).get("verified_at"))):
        d = _parse_date(value) if value else None
        if d and d > today:
            report.error(where, f"{label} {value} is in the future")
    for entry in tool.get("changelog") or []:
        d = _parse_date(entry.get("date"))
        if d and d > today:
            report.error(where, f"changelog date {entry.get('date')} is in the future")

    if tool.get("affiliate_url") and registrable_host(tool["affiliate_url"]) == "":
        report.error(where, "affiliate_url has no host")

    sig = tool.get("signals") or {}
    external = [k for k in ("trends_term", "wikipedia_article", "github_repo", "hf_id", "producthunt_slug")
                if sig.get(k)]
    if sig.get("hn_domain") or sig.get("hn_query"):
        external.append("hn")
    if sig.get("hn_domain") and sig.get("hn_query"):
        report.warn(where, "both hn_domain and hn_query are set; the collector uses hn_domain")
    if tool.get("status") == "published" and not external:
        report.warn(where, "no external signal configured; the tool can only rank on our own clicks, so it will not be ranked")
    if sig.get("github_repo") and tool.get("repo_url"):
        expected = f"https://github.com/{sig['github_repo']}".lower()
        if tool["repo_url"].rstrip("/").lower() != expected:
            report.warn(where, f"signals.github_repo ({sig['github_repo']}) does not match repo_url")

    alts = tool.get("alternatives") or []
    if slug in alts:
        report.error(where, "a tool cannot list itself as an alternative")


def check_directory(directory: Directory, schema_dir: Path = DEFAULT_SCHEMA_DIR,
                    today: dt.date | None = None) -> Report:
    report = Report()
    today = today or dt.date.today()
    report.errors.extend(directory.load_errors)

    tool_v = _validator(schema_dir, "tool.schema.json")
    tax_v = _validator(schema_dir, "taxonomy.schema.json")

    cat_ids: set[str] = set()
    task_ids: set[str] = set()
    if directory.taxonomy is not None:
        cat_ids, task_ids = check_taxonomy(directory.taxonomy, report, tax_v)

    hosts: dict[str, str] = {}
    for stem, tool in directory.tools.items():
        report.tools_checked += 1
        check_tool(stem, tool, report, tool_v, cat_ids, task_ids, today)
        if isinstance(tool, dict) and isinstance(tool.get("url"), str):
            host = site_key(tool["url"])
            if host in hosts:
                report.error(f"tools/{stem}.json", f"same site as tools/{hosts[host]}.json ({host}); one file per tool")
            else:
                hosts[host] = stem

    known = set(directory.tools)
    for stem, tool in directory.tools.items():
        if not isinstance(tool, dict):
            continue
        for alt in tool.get("alternatives") or []:
            if alt not in known:
                report.warn(f"tools/{stem}.json", f"alternative {alt!r} is not in the directory yet (link hidden until it is)")
    return report
