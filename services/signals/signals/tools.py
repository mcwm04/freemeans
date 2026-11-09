"""Read the published tools from data/tools/*.json (Git is the source of truth, PRD 4.4).

The files are fully validated by services/toolcheck in CI, so this loader only takes what the
collector needs and skips anything it cannot use.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_TOOLS_DIR = REPO_ROOT / "data" / "tools"


@dataclass(frozen=True)
class Tool:
    slug: str
    url: str
    signals: dict = field(default_factory=dict)

    def sig(self, key: str) -> str | None:
        value = self.signals.get(key)
        return value if isinstance(value, str) and value.strip() else None


def load_tools(tools_dir: Path = DEFAULT_TOOLS_DIR, only: set[str] | None = None) -> list[Tool]:
    tools = []
    for path in sorted(tools_dir.glob("*.json")):
        try:
            rec = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue  # toolcheck reports broken files; the collector just skips them
        if rec.get("status") != "published" or not rec.get("slug"):
            continue
        if only and rec["slug"] not in only:
            continue
        tools.append(Tool(rec["slug"], rec.get("url", ""), dict(rec.get("signals") or {})))
    return tools
