"""PgStore against a real Postgres with migrations 001 + 002 applied.

Runs when TEST_DATABASE_URL is set (CI starts a Postgres service container); skipped otherwise.
"""
import datetime as dt
import os
from pathlib import Path

import pytest

DSN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")

MIGRATIONS = Path(__file__).resolve().parents[3] / "db" / "migrations"
D = dt.date(2026, 11, 8)


@pytest.fixture
def store():
    import psycopg
    from signals.store import PgStore
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        for f in sorted(MIGRATIONS.glob("*.sql")):
            c.execute(f.read_text())
    s = PgStore(DSN)
    yield s
    s.close()


def test_upsert_coalesces_and_counts(store):
    assert store.upsert_snapshots({("ollama", D): {"gh_stars": 10}, ("ollama", D - dt.timedelta(days=1)): {"wiki_views": 3}}) == 2
    store.upsert_snapshots({("ollama", D): {"wiki_views": 7, "gh_stars": None}})
    with store.conn.cursor() as cur:
        cur.execute("SELECT gh_stars, wiki_views, hn_points FROM signal_snapshots WHERE slug='ollama' AND day=%s", (D,))
        assert cur.fetchone() == (10, 7, None)


def test_clicks_backfills_and_jobs(store):
    with store.conn.cursor() as cur:
        cur.execute("INSERT INTO tool_clicks_daily (slug, day, country, clicks) VALUES "
                    "('a', %s, 'PK', 3), ('a', %s, 'US', 2), ('b', %s, 'PK', 1)", (D, D, D - dt.timedelta(days=9)))
    assert store.clicks(["a", "b"], D - dt.timedelta(days=2), D) == {("a", D): 5}
    store.set_backfill("a", "wiki", "done", D - dt.timedelta(days=730), D, 731, "")
    store.set_backfill("a", "wiki", "done", D - dt.timedelta(days=730), D, 731, "again")
    assert store.backfills() == {("a", "wiki"): "done"}
    jid = store.start_job("signals")
    store.finish_job(jid, True, {"rows": 4, "day": D})
    with store.conn.cursor() as cur:
        cur.execute("SELECT ok, stats->>'rows', ended_at IS NOT NULL FROM job_runs WHERE id=%s", (jid,))
        assert cur.fetchone() == (True, "4", True)
