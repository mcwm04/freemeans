"""Directory tools in the source check (PRD M3).

Each published tool in data/tools/ whose free quota has a number becomes one "limit" with the
same shape as a catalog limit, so the same fetch, search and report code checks it. Tools whose
provider publishes no number (quota null) have nothing to compare and are left out.
"""
from __future__ import annotations

import json
from pathlib import Path

PREFIX = "tool:"     # metric prefix: "tool:<unit>", e.g. "tool:characters"


def tools_as_resources(tools_dir: Path) -> list[dict]:
    out = []
    if not tools_dir.is_dir():
        return out
    for path in sorted(tools_dir.glob("*.json")):
        try:
            t = json.loads(path.read_text(encoding="utf-8"))
        except ValueError:
            continue
        if t.get("status") != "published":
            continue
        ft = t.get("free_tier") or {}
        q = ft.get("quota") or {}
        if q.get("value") is None or not ft.get("source_url"):
            continue
        out.append({
            "id": f"tools/{t['slug']}",
            "limit_rules": [{
                "metric": PREFIX + str(q.get("unit") or "units"),
                "value": q["value"],
                "window": q.get("period") or "once",
                "source_url": ft["source_url"],
                "signal_type": "official_docs",
                "verified_at": ft.get("verified_at", ""),
            }],
        })
    return out


def unit_patterns(metric: str) -> list[str]:
    """Unit words for a tool quota: the unit as written, and its singular."""
    import re
    unit = metric[len(PREFIX):].strip().lower()
    words = {unit}
    if unit.endswith("s"):
        words.add(unit[:-1])
    return [re.escape(w) for w in sorted(words) if w]
