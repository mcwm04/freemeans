"""Offers that need a person: unverified ones, and ones not checked for a long time.

Eligibility PRD, chapter 6.3: the run summary lists any offer whose last_verified is more than
60 days old under "Re-check by hand". Unverified offers are listed too, whatever their age,
because nobody has read their provider page yet.
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

STALE_AFTER_DAYS = 60


@dataclass
class Recheck:
    resource_id: str
    name: str
    last_verified: str
    reason: str  # "unverified" | "stale"
    age_days: int | None
    file: str


def offers_to_recheck(resources: list[dict], run_date: str, days: int = STALE_AFTER_DAYS) -> list[Recheck]:
    today = dt.date.fromisoformat(run_date)
    out: list[Recheck] = []
    for r in resources:
        if not r.get("eligibility") or r.get("status") == "ended":
            continue
        lv = r.get("last_verified", "")
        try:
            age = (today - dt.date.fromisoformat(lv)).days
        except ValueError:
            age = None
        file = r.get("source_file", "data/catalog/eligibility.json")
        if r.get("status") == "unverified":
            out.append(Recheck(r["id"], r.get("name", r["id"]), lv, "unverified", age, file))
        elif age is None or age > days:
            out.append(Recheck(r["id"], r.get("name", r["id"]), lv, "stale", age, file))
    # Unverified first, then the oldest checks.
    return sorted(out, key=lambda x: (x.reason != "unverified", -(x.age_days or 0), x.resource_id))
