"""PgStore against real Postgres with all migrations (runs when TEST_DATABASE_URL is set)."""
import os
from pathlib import Path

import pytest

DSN = os.environ.get("TEST_DATABASE_URL")
pytestmark = pytest.mark.skipif(not DSN, reason="TEST_DATABASE_URL not set")
MIGRATIONS = Path(__file__).resolve().parents[3] / "db" / "migrations"


@pytest.fixture
def store():
    import psycopg
    from crawler.store import PgStore
    with psycopg.connect(DSN, autocommit=True) as c:
        c.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")
        for f in sorted(MIGRATIONS.glob("*.sql")):
            c.execute(f.read_text())
    s = PgStore(DSN)
    yield s
    s.close()


def test_queue_round_trip(store):
    row = {"url": "https://v.ai/", "domain": "v.ai", "source": "hn", "source_ref": "1", "name": "V", "category": None, "priority": 30, "buzz": 12.0}
    assert store.add([row, row | {"url": "https://www.v.ai/"}]) == 1
    batch = store.next_batch(10)
    assert [r.domain for r in batch] == ["v.ai"]
    r = batch[0]
    r.status, r.attempts, r.draft, r.evidence, r.flags = "drafted", 1, {"slug": "v"}, {"q": "s"}, ["number_blanked:free_tier.quota"]
    store.save(r)
    assert store.next_batch(10) == []
    assert store.known_domains() == {"v.ai"}
    with store.conn.cursor() as cur:
        cur.execute("SELECT status, draft->>'slug', flags FROM tool_candidates")
        assert cur.fetchone() == ("drafted", "v", ["number_blanked:free_tier.quota"])
    jid = store.start_job("crawler")
    store.finish_job(jid, True, {"drafted": 1})
