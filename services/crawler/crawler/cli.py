"""python -m crawler run|discover|draft [--limit N] [--dry-run]

  discover  find new candidates (Hacker News, GitHub, Hugging Face) and queue them
  draft     fetch queued sites, draft listings with Groq (Gemini fallback), number-check, queue for review
  run       both, as the nightly workflow does

Needs DATABASE_URL (Neon) unless --dry-run, and GROQ_API_KEY and/or GEMINI_API_KEY for drafting.
Exit code 1 when more than 30% of drafts failed, so GitHub emails the repo owner.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys

from signals.http import Http

from .fetch import Fetcher
from .llm import Drafter, providers_from_env
from .run import REPO, Stats, run_discover, run_draft
from .store import MemoryStore, PgStore


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="crawler", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("cmd", choices=["run", "discover", "draft"])
    p.add_argument("--limit", type=int, default=40, help="max candidates to draft this run")
    p.add_argument("--sources", default="hn,github,hf")
    p.add_argument("--dry-run", action="store_true", help="use an in-memory queue; print what would be queued")
    args = p.parse_args(argv)

    dsn = os.environ.get("DATABASE_URL", "").strip()
    if args.dry_run:
        store = MemoryStore()
    elif not dsn:
        print("DATABASE_URL is not set. Add it as a GitHub Actions secret, or use --dry-run.", file=sys.stderr)
        return 2
    else:
        store = PgStore(dsn)

    taxonomy = json.loads((REPO / "data" / "taxonomy.json").read_text(encoding="utf-8"))
    now = dt.datetime.now(dt.timezone.utc)
    stats = Stats()
    job = store.start_job("crawler")
    try:
        if args.cmd in ("run", "discover"):
            run_discover(Http(pause=0.5), store, now, stats, tuple(s for s in args.sources.split(",") if s))
        if args.cmd in ("run", "draft"):
            providers = providers_from_env()
            if not providers:
                stats.problems.append("no GROQ_API_KEY or GEMINI_API_KEY: drafting skipped, candidates stay queued")
            else:
                run_draft(store, Fetcher(), Drafter(providers), taxonomy, now.date(), stats, args.limit)
    except Exception as e:
        store.finish_job(job, False, {"error": f"{type(e).__name__}: {e}"[:500]})
        raise
    store.finish_job(job, stats.ok, stats.as_json())

    report = stats.markdown()
    print(report)
    if path := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(path, "a", encoding="utf-8") as f:
            f.write(report)
    if args.dry_run and isinstance(store, MemoryStore):
        for r in list(store.rows.values())[:30]:
            print(f"{r.status:12} p{r.priority:<3} {r.source:7} {r.domain}  {r.name}")
    if isinstance(store, PgStore):
        store.close()
    return 0 if stats.ok else 1
