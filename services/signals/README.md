# services/signals: nightly signal collector

Measures public attention for every **published** tool in `data/tools/` and writes one wide row
per tool per day to Neon (`signal_snapshots`, migration `002_directory.sql`). The scorer
(Phase 2) turns these rows into Trending Scores. PRD Chapters 6–7.

| Signal | Source | Column | Daily | History (backfill) |
| --- | --- | --- | --- | --- |
| Wikipedia attention | Wikimedia Pageviews API (`agent=user`) | `wiki_views` | last 3 days refreshed | 2 years, 1 call per tool |
| Developer discussion | Algolia HN Search API | `hn_points` | last 3 days refreshed | 2 years, split under Algolia's 1,000-hit cap |
| Code adoption | GitHub REST API | `gh_stars` (total) | 1 call per tool | star timestamps, repos up to ~40,000 stars |
| Model adoption | Hugging Face Hub API | `hf_likes`, `hf_downloads` (30-day) | 1 call per tool | none (totals only) |
| Freemeans interest | `tool_clicks_daily` | `our_clicks` | from `FREEMEANS_CLICKS_SINCE` | none |
| Search interest | Google Trends API | `trends` | **off** until alpha access | – |
| Launch buzz | Product Hunt API | `ph_votes` | **off** until Product Hunt allows commercial use | – |

Rules the code follows:

- **NULL is not zero.** A signal that is not configured, not found or not yet live stays NULL and
  is skipped by the scorer. Zero is written only when we really measured zero (no HN stories that
  day; no clicks once `/go` is live).
- **Upserts never erase.** Each source fills only its own columns; a value is never replaced by NULL.
- **Days are UTC days.** The run at 19:34 UTC (00:34 PKT) collects the UTC day that just ended.
- **Polite.** User agent `FreemeansBot/1.0 (+https://freemeans.com/bot; hello@freemeans.com)`,
  a pause between calls to one host, retries on 5xx, and a host is dropped for the run after
  3 rate-limit answers.
- **Monitored.** Every run writes a `job_runs` row. More than 30% failed calls marks the run not OK,
  exits 1, and GitHub emails the repo owner. A wrong Wikipedia title or repo shows up under
  "Needs a look" in the run summary without failing the run.

## Commands

```bash
pip install -e ".[dev]"
python -m signals collect --dry-run                 # fetch, print, write nothing
python -m signals collect --only ollama --dry-run   # one tool
DATABASE_URL=postgresql://... python -m signals collect
DATABASE_URL=postgresql://... python -m signals backfill --gh-budget 600
python -m pytest -q        # no network; the Postgres tests run when TEST_DATABASE_URL is set
```

Matching a tool on Hacker News: set `signals.hn_domain` (e.g. `ollama.com`, or
`github.com/openai/whisper` for repo-hosted tools). Use `signals.hn_query` (title search) only when
the tool has no domain of its own, and never for ambiguous names.
