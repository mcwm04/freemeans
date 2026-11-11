"""Markdown report for the pull request, and a JSON record of each run."""
from __future__ import annotations

import json
from dataclasses import asdict

from .check import PHRASE, RuleResult, summary
from .freshness import STALE_AFTER_DAYS, Recheck

LABELS = {
    "missing": "Possibly changed",
    "weak": "Number found, unit unclear",
    "unreachable": "Could not read the page",
    "confirmed": "Still matches",
    "skipped": "Not published",
}


def _fmt(v) -> str:
    if isinstance(v, (int, float)) and float(v).is_integer():
        return f"{int(v):,}"
    return str(v)


def _file_for(resource_id: str) -> str:
    if resource_id.startswith("tools/"):
        return f"data/{resource_id}.json"
    return "data/catalog/seed.json"


def _is_phrase(r: RuleResult) -> bool:
    return r.metric == PHRASE


def markdown(results: list[RuleResult], run_date: str, catalog_version: str, recheck: list[Recheck] | None = None) -> str:
    recheck = recheck or []
    s = summary(results)
    lines = [
        f"# Source check · {run_date}",
        "",
        f"Catalog `{catalog_version}`. Each limit's source page was fetched once and searched for the number on file.",
        "",
        "| Result | Limits |",
        "| --- | ---: |",
    ]
    for key in ["missing", "weak", "unreachable", "confirmed", "skipped"]:
        if s.get(key):
            lines.append(f"| {LABELS[key]} | {s[key]} |")
    if recheck:
        lines.append(f"| Offers to re-check by hand | {len(recheck)} |")
    lines.append("")

    missing = [r for r in results if r.status == "missing"]
    if missing:
        lines += [
            "## Possibly changed: review these",
            "",
            "The number we have on file is no longer on its source page. The provider may have changed the limit,",
            "or the page may have been rewritten. Open the source, then edit the file named under each item in this PR:",
            "update the value, set `verified_at` to today, and keep `source_url` pointing at the page you checked.",
            "For a directory tool, also add a line to its `changelog` (it shows on the tool page).",
            "",
        ]
        for r in missing:
            if _is_phrase(r):
                lines.append(f"### `{r.resource_id}` · watch phrase “{r.value}”")
                lines.append(f"- Source: {r.source_url} (last verified {r.verified_at})")
                lines.append(f"- File: `{r.file or _file_for(r.resource_id)}`")
                lines.append("- The phrase is no longer on the page. The offer may have changed or ended: read the page, then update the dates, amounts and `status` on the record, fix its `watch` list, and set `last_verified` to today.")
                lines.append("")
                continue
            lines.append(f"### `{r.resource_id}` · {r.metric} = {_fmt(r.value)} per {r.window}")
            lines.append(f"- Source: {r.source_url} ({r.signal_type}, last verified {r.verified_at})")
            lines.append(f"- File: `{r.file or _file_for(r.resource_id)}`")
            if r.nearby:
                lines.append("- What the page says nearby now:")
                lines += [f"  > {n}" for n in r.nearby]
            else:
                lines.append("- The page no longer mentions this kind of limit with a number.")
            lines.append("")

    weak = [r for r in results if r.status == "weak"]
    if weak:
        lines += ["## Number found, but not next to its unit", "", "Probably fine; worth a glance.", ""]
        lines += [f"- `{r.resource_id}` {r.metric} = {_fmt(r.value)}: {r.snippet}" for r in weak]
        lines.append("")

    unreachable = [r for r in results if r.status == "unreachable"]
    if unreachable:
        lines += ["## Could not read", ""]
        by_url: dict[str, list[RuleResult]] = {}
        for r in unreachable:
            by_url.setdefault(r.source_url, []).append(r)
        for url, rs in by_url.items():
            lines.append(f"- {url}: {rs[0].detail} ({len(rs)} limit{'s' if len(rs) > 1 else ''})")
        lines.append("")

    if recheck:
        lines += ["## Re-check by hand", "",
                  f"Offers that are unverified, or were last checked more than {STALE_AFTER_DAYS} days ago. Open the provider's own page, confirm who qualifies, where, the dates and the price afterwards,",
                  "then set `last_verified` to today (and `status` to `active` for an unverified offer).", ""]
        for x in recheck:
            why = "unverified" if x.reason == "unverified" else f"last checked {x.last_verified} ({x.age_days} days ago)"
            lines.append(f"- `{x.resource_id}` {x.name}: {why}. File: `{x.file}`")
        lines.append("")

    lines += [
        "---",
        "Opened by the nightly source check (`.github/workflows/source-check.yml`). The bot never edits limits itself;",
        "a person confirms every change. Pages that need JavaScript or block bots show up under *Could not read*.",
    ]
    return "\n".join(lines) + "\n"


def record(results: list[RuleResult], run_date: str, catalog_version: str, recheck: list[Recheck] | None = None) -> str:
    return json.dumps(
        {"run_date": run_date, "catalog_version": catalog_version, "summary": summary(results), "recheck": [asdict(x) for x in recheck or []], "results": [asdict(r) for r in results]},
        indent=2,
        ensure_ascii=False,
    ) + "\n"
