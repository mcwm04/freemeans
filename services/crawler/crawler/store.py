"""The review queue in Neon (tool_candidates, migrations 002 + 003), and an in-memory copy for tests."""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Protocol


@dataclass
class Row:
    id: int
    url: str
    domain: str
    source: str
    source_ref: str | None = None
    name: str | None = None
    category: str | None = None
    status: str = "new"
    priority: int = 0
    buzz: float | None = None
    attempts: int = 0
    draft: dict | None = None
    evidence: dict | None = None
    flags: list[str] = field(default_factory=list)
    reject_reason: str | None = None


class Store(Protocol):
    def known_domains(self) -> set[str]: ...
    def add(self, rows: list[dict]) -> int: ...
    def next_batch(self, limit: int) -> list[Row]: ...
    def save(self, row: Row) -> None: ...
    def start_job(self, job: str) -> int: ...
    def finish_job(self, job_id: int, ok: bool, stats: dict) -> None: ...


class MemoryStore:
    def __init__(self):
        self.rows: dict[int, Row] = {}
        self.jobs: list[dict] = []

    def known_domains(self):
        return {r.domain for r in self.rows.values()}

    def add(self, rows):
        n = 0
        for r in rows:
            if r["domain"] in self.known_domains():
                continue
            rid = len(self.rows) + 1
            self.rows[rid] = Row(id=rid, **r)
            n += 1
        return n

    def next_batch(self, limit):
        todo = [r for r in self.rows.values() if r.status == "new" and r.attempts < 3]
        return sorted(todo, key=lambda r: (-r.priority, r.id))[:limit]

    def save(self, row):
        self.rows[row.id] = row

    def start_job(self, job):
        self.jobs.append({"job": job})
        return len(self.jobs)

    def finish_job(self, job_id, ok, stats):
        self.jobs[job_id - 1].update(ok=ok, stats=stats)


class PgStore:
    def __init__(self, dsn: str):
        import psycopg
        self.conn = psycopg.connect(dsn, autocommit=True, connect_timeout=20)

    def close(self):
        self.conn.close()

    def known_domains(self):
        with self.conn.cursor() as cur:
            cur.execute("SELECT domain FROM tool_candidates")
            return {d for (d,) in cur.fetchall()}

    def add(self, rows):
        n = 0
        with self.conn.cursor() as cur:
            for r in rows:
                cur.execute(
                    "INSERT INTO tool_candidates (url, domain, source, source_ref, name, category, priority, buzz) "
                    "VALUES (%s, %s, %s, %s, %s, %s, %s, %s) ON CONFLICT (domain) DO NOTHING",
                    (r["url"], r["domain"], r["source"], r.get("source_ref"), r.get("name"), r.get("category"),
                     r.get("priority", 0), r.get("buzz")))
                n += cur.rowcount
        return n

    def next_batch(self, limit):
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT id, url, domain, source, source_ref, name, category, status, priority, buzz, attempts "
                "FROM tool_candidates WHERE status = 'new' AND attempts < 3 ORDER BY priority DESC, id LIMIT %s", (limit,))
            cols = [d.name for d in cur.description]
            return [Row(**dict(zip(cols, rec))) for rec in cur.fetchall()]

    def save(self, row):
        with self.conn.cursor() as cur:
            cur.execute(
                "UPDATE tool_candidates SET status = %s, priority = %s, attempts = %s, draft = %s::jsonb, evidence = %s::jsonb, "
                "flags = %s, reject_reason = %s, name = COALESCE(%s, name), updated_at = now() WHERE id = %s",
                (row.status, row.priority, row.attempts, json.dumps(row.draft) if row.draft is not None else None,
                 json.dumps(row.evidence) if row.evidence is not None else None, row.flags, row.reject_reason,
                 row.name, row.id))

    def start_job(self, job):
        with self.conn.cursor() as cur:
            cur.execute("INSERT INTO job_runs (job) VALUES (%s) RETURNING id", (job,))
            return cur.fetchone()[0]

    def finish_job(self, job_id, ok, stats):
        with self.conn.cursor() as cur:
            cur.execute("UPDATE job_runs SET ended_at = now(), ok = %s, stats = %s::jsonb WHERE id = %s",
                        (ok, json.dumps(stats, default=str), job_id))
