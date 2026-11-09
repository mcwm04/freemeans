"""Where snapshots go: Neon Postgres in production, memory in tests and --dry-run.

Upserts never overwrite a stored value with NULL: each source fills only its own columns, so a
backfill of Wikipedia views cannot erase GitHub stars collected for the same day.
"""
from __future__ import annotations

import datetime as dt
import json
from typing import Protocol

from .model import SIGNAL_COLUMNS


class Store(Protocol):
    def upsert_snapshots(self, rows: dict[tuple[str, dt.date], dict]) -> int: ...
    def clicks(self, slugs: list[str], start: dt.date, end: dt.date) -> dict[tuple[str, dt.date], int]: ...
    def backfills(self) -> dict[tuple[str, str], str]: ...
    def set_backfill(self, slug: str, signal: str, status: str, first_day: dt.date | None,
                     last_day: dt.date | None, rows: int, note: str) -> None: ...
    def start_job(self, job: str) -> int: ...
    def finish_job(self, job_id: int, ok: bool, stats: dict) -> None: ...


def _check_columns(cols: dict) -> None:
    bad = set(cols) - set(SIGNAL_COLUMNS)
    if bad:
        raise ValueError(f"unknown snapshot columns: {sorted(bad)}")


class MemoryStore:
    def __init__(self, click_rows: dict[tuple[str, dt.date], int] | None = None):
        self.snapshots: dict[tuple[str, dt.date], dict] = {}
        self.click_rows = click_rows or {}
        self.backfill_rows: dict[tuple[str, str], dict] = {}
        self.jobs: list[dict] = []

    def upsert_snapshots(self, rows):
        for key, cols in rows.items():
            _check_columns(cols)
            current = self.snapshots.setdefault(key, {c: None for c in SIGNAL_COLUMNS})
            for c, v in cols.items():
                if v is not None:
                    current[c] = v
        return len(rows)

    def clicks(self, slugs, start, end):
        return {k: v for k, v in self.click_rows.items() if k[0] in slugs and start <= k[1] <= end}

    def backfills(self):
        return {k: v["status"] for k, v in self.backfill_rows.items()}

    def set_backfill(self, slug, signal, status, first_day, last_day, rows, note):
        self.backfill_rows[(slug, signal)] = dict(status=status, first_day=first_day, last_day=last_day, rows=rows, note=note)

    def start_job(self, job):
        self.jobs.append({"job": job, "ok": None, "stats": None})
        return len(self.jobs)

    def finish_job(self, job_id, ok, stats):
        self.jobs[job_id - 1].update(ok=ok, stats=stats)


class PgStore:
    """psycopg 3 against Neon (pooled connection string, sslmode=verify-full)."""

    def __init__(self, dsn: str):
        import psycopg  # imported here so tests and --dry-run need no driver
        self.conn = psycopg.connect(dsn, autocommit=True, connect_timeout=20)

    def close(self) -> None:
        self.conn.close()

    def upsert_snapshots(self, rows):
        if not rows:
            return 0
        cols = list(SIGNAL_COLUMNS)
        sets = ", ".join(f"{c} = COALESCE(EXCLUDED.{c}, signal_snapshots.{c})" for c in cols)
        sql = (f"INSERT INTO signal_snapshots (slug, day, {', '.join(cols)}) "
               f"VALUES (%s, %s, {', '.join(['%s'] * len(cols))}) "
               f"ON CONFLICT (slug, day) DO UPDATE SET {sets}, updated_at = now()")
        params = []
        for (slug, day), values in sorted(rows.items()):
            _check_columns(values)
            params.append((slug, day, *[values.get(c) for c in cols]))
        with self.conn.transaction(), self.conn.cursor() as cur:
            cur.executemany(sql, params)
        return len(params)

    def clicks(self, slugs, start, end):
        if not slugs:
            return {}
        with self.conn.cursor() as cur:
            cur.execute("SELECT slug, day, sum(clicks)::int FROM tool_clicks_daily "
                        "WHERE slug = ANY(%s) AND day BETWEEN %s AND %s GROUP BY slug, day",
                        (list(slugs), start, end))
            return {(s, d): n for s, d, n in cur.fetchall()}

    def backfills(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT slug, signal, status FROM signal_backfills")
            return {(s, sig): st for s, sig, st in cur.fetchall()}

    def set_backfill(self, slug, signal, status, first_day, last_day, rows, note):
        with self.conn.cursor() as cur:
            cur.execute(
                "INSERT INTO signal_backfills (slug, signal, status, first_day, last_day, rows_written, note) "
                "VALUES (%s, %s, %s, %s, %s, %s, %s) ON CONFLICT (slug, signal) DO UPDATE SET "
                "status = EXCLUDED.status, first_day = EXCLUDED.first_day, last_day = EXCLUDED.last_day, "
                "rows_written = EXCLUDED.rows_written, note = EXCLUDED.note, updated_at = now()",
                (slug, signal, status, first_day, last_day, rows, note[:500]))

    def start_job(self, job):
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO job_runs (job) VALUES (%s) RETURNING id", (job,))
            return cur.fetchone()[0]

    def finish_job(self, job_id, ok, stats):
        with self.conn.cursor() as cur:
            cur.execute("UPDATE job_runs SET ended_at = now(), ok = %s, stats = %s::jsonb WHERE id = %s",
                        (ok, json.dumps(stats, default=str), job_id))
