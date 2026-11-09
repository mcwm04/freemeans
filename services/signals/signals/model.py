"""Shared types."""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, field

# Columns of signal_snapshots that the collector writes (db/migrations/002_directory.sql).
SIGNAL_COLUMNS = ("trends", "wiki_views", "gh_stars", "hn_points", "hf_likes", "hf_downloads", "ph_votes", "our_clicks")


@dataclass
class Outcome:
    """What one source call produced for one tool."""
    status: str                     # ok | not_found | failed | skipped
    values: dict[dt.date, dict[str, int | float]] = field(default_factory=dict)  # day -> {column: value}
    detail: str = ""


def daterange(start: dt.date, end: dt.date):
    """Days from start to end, both included."""
    d = start
    while d <= end:
        yield d
        d += dt.timedelta(days=1)


def merge(into: dict[tuple[str, dt.date], dict], slug: str, outcome: Outcome) -> None:
    for day, cols in outcome.values.items():
        into.setdefault((slug, day), {}).update(cols)
