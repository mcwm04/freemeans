"""python -m signals collect|backfill [options]

  collect   nightly: one snapshot row per published tool for yesterday (UTC), last 3 days refreshed
  backfill  once per tool: 2 years of Wikipedia and Hacker News history, GitHub star history

Needs DATABASE_URL (Neon pooled string) unless --dry-run. Exit code 1 when the run is not OK,
so GitHub Actions marks it failed and emails the repo owner (PRD 7.7).
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

from .collect import backfill, collect_daily, utc_yesterday
from .http import Http
from .store import MemoryStore, PgStore
from .tools import DEFAULT_TOOLS_DIR, load_tools


def _write_summary(text: str) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if path:
        with open(path, "a", encoding="utf-8") as f:
            f.write(text + "\n")


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="signals", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("collect", "backfill"):
        s = sub.add_parser(name)
        s.add_argument("--tools", type=Path, default=DEFAULT_TOOLS_DIR, help="folder of tool JSON files")
        s.add_argument("--only", help="comma-separated slugs, for testing one tool")
        s.add_argument("--day", type=dt.date.fromisoformat, help="UTC day to collect (default: yesterday)")
        s.add_argument("--dry-run", action="store_true", help="fetch but do not write; print the rows")
        s.add_argument("--pause", type=float, default=0.25, help="seconds between calls to one host")
    b = sub.choices["backfill"]
    b.add_argument("--years", type=int, default=2)
    b.add_argument("--signals", default="wiki,hn,github", help="any of wiki,hn,github")
    b.add_argument("--gh-budget", type=int, default=600, help="max GitHub requests this run")
    args = p.parse_args(argv)

    only = {s.strip() for s in args.only.split(",")} if args.only else None
    tools = load_tools(args.tools, only)
    if not tools:
        print("no published tools found; nothing to do")
        return 0
    day = args.day or utc_yesterday()

    dsn = os.environ.get("DATABASE_URL", "").strip()
    if args.dry_run:
        store = MemoryStore()
    elif not dsn:
        print("DATABASE_URL is not set. Add it as a GitHub Actions secret, or use --dry-run.", file=sys.stderr)
        return 2
    else:
        store = PgStore(dsn)

    http = Http(pause=args.pause)
    job_id = store.start_job("signals" if args.cmd == "collect" else "backfill")
    try:
        if args.cmd == "collect":
            stats = collect_daily(tools, store, http, day)
        else:
            sigs = tuple(s.strip() for s in args.signals.split(",") if s.strip())
            stats = backfill(tools, store, http, day, years=args.years, signals=sigs, gh_budget=args.gh_budget)
    except Exception as e:
        store.finish_job(job_id, False, {"error": f"{type(e).__name__}: {e}"[:500]})
        raise
    store.finish_job(job_id, stats.ok, stats.as_json())

    report = stats.markdown()
    print(report)
    _write_summary(report)
    if args.dry_run:
        shown = sorted(store.snapshots.items())
        print(f"--- dry run: {len(shown)} row(s) not written; last 20:")
        for (slug, d), cols in shown[-20:]:
            print(slug, d, json.dumps({k: v for k, v in cols.items() if v is not None}))
    if isinstance(store, PgStore):
        store.close()
    return 0 if stats.ok else 1
