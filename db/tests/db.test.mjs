// Runs the real migration and loader against PGlite: Postgres compiled to WebAssembly,
// in memory, no server and no network. Same SQL that runs on Neon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrate, loadCatalog, readSeed, checkCatalog } from '../scripts/lib.mjs';

async function freshDb() {
  const pg = new PGlite();
  await pg.waitReady;
  return pg; // PGlite already has exec(sql) and query(sql, params) → { rows }
}

test('migration creates every table and is idempotent', async () => {
  const db = await freshDb();
  assert.deepEqual(await migrate(db), ['001_init.sql', '002_directory.sql', '003_review_queue.sql']);
  assert.deepEqual(await migrate(db), []);
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name`,
  );
  assert.deepEqual(rows.map((r) => r.table_name), [
    'badges', 'catalog_versions', 'job_runs', 'limit_rules', 'resources', 'schema_migrations',
    'signal_backfills', 'signal_snapshots', 'sources', 'sponsorships', 'tool_candidates',
    'tool_clicks_daily', 'trending_scores', 'vendor_claims', 'waitlist',
  ]);
});

test('seed loads every resource, rule, badge and source', async () => {
  const db = await freshDb();
  await migrate(db);
  const seed = readSeed();
  const out = await loadCatalog(db, seed);
  assert.equal(out.resources, seed.resources.length);

  const count = async (t) => Number((await db.query(`SELECT count(*)::int AS n FROM ${t}`)).rows[0].n);
  assert.equal(await count('resources'), seed.resources.length);
  assert.equal(await count('limit_rules'), seed.resources.reduce((n, r) => n + r.limit_rules.length, 0));
  assert.equal(await count('badges'), seed.resources.reduce((n, r) => n + r.badges.length, 0));
  assert.equal(await count('sources'), seed.resources.reduce((n, r) => n + r.sources.length, 0));

  const { rows } = await db.query('SELECT record FROM resources WHERE id = $1', ['groq.gpt-oss-120b']);
  assert.deepEqual(rows[0].record, seed.resources.find((r) => r.id === 'groq.gpt-oss-120b'));
});

test('unpublished limits are stored as NULL, not 0', async () => {
  const db = await freshDb();
  await migrate(db);
  await loadCatalog(db, readSeed());
  const { rows } = await db.query(
    `SELECT value, published FROM limit_rules WHERE resource_id = 'google.gemini-api-free' ORDER BY position`,
  );
  assert.ok(rows.length > 0);
  for (const r of rows) {
    assert.equal(r.value, null);
    assert.equal(r.published, false);
  }
});

test('reloading is idempotent and removes resources dropped from the catalog', async () => {
  const db = await freshDb();
  await migrate(db);
  const seed = readSeed();
  await loadCatalog(db, seed);
  await loadCatalog(db, seed);
  const n = (await db.query('SELECT count(*)::int AS n FROM limit_rules')).rows[0].n;
  assert.equal(n, seed.resources.reduce((s, r) => s + r.limit_rules.length, 0));

  const smaller = { ...seed, version: seed.version + '-b', resources: seed.resources.slice(1) };
  await loadCatalog(db, smaller);
  const ids = (await db.query('SELECT id FROM resources')).rows.map((r) => r.id);
  assert.ok(!ids.includes(seed.resources[0].id));
  const orphan = await db.query('SELECT count(*)::int AS n FROM limit_rules WHERE resource_id = $1', [seed.resources[0].id]);
  assert.equal(orphan.rows[0].n, 0);
});

test('a bad catalog is refused before any write', async () => {
  const db = await freshDb();
  await migrate(db);
  const seed = readSeed();
  const bad = { ...seed, resources: [seed.resources[0], seed.resources[0]] };
  assert.deepEqual(checkCatalog(bad), [`duplicate id ${seed.resources[0].id}`]);
  await assert.rejects(loadCatalog(db, bad), /duplicate id/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM resources')).rows[0].n, 0);
});

test('a failing insert rolls back the whole load', async () => {
  const db = await freshDb();
  await migrate(db);
  const seed = readSeed();
  await loadCatalog(db, seed);
  const broken = structuredClone(seed);
  broken.version = 'broken';
  broken.resources[3].limit_rules[0].metric = 'not_a_metric'; // violates the CHECK constraint
  await assert.rejects(loadCatalog(db, broken));
  const v = await db.query(`SELECT count(*)::int AS n FROM catalog_versions WHERE version = 'broken'`);
  assert.equal(v.rows[0].n, 0);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM resources')).rows[0].n, seed.resources.length);
});

test('waitlist keeps one lower-case row per email', async () => {
  const db = await freshDb();
  await migrate(db);
  const ins = `INSERT INTO waitlist (email, source, consent_at) VALUES ($1, 'test', now()) ON CONFLICT (email) DO NOTHING`;
  await db.query(ins, ['ali@example.pk']);
  await db.query(ins, ['ali@example.pk']);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM waitlist')).rows[0].n, 1);
  await assert.rejects(db.query(ins, ['Ali@Example.pk'])); // must be lower-cased by the API first
});

// ---- 002_directory.sql (AI tools directory) ----

test('002 can run on a database that already has 001 applied (the live Neon case)', async () => {
  const db = await freshDb();
  const dir001 = mkdtempSync(join(tmpdir(), 'mig-'));
  copyFileSync(new URL('../migrations/001_init.sql', import.meta.url), join(dir001, '001_init.sql'));
  assert.deepEqual(await migrate(db, dir001), ['001_init.sql']);
  await db.query(`INSERT INTO waitlist (email, consent_at) VALUES ('old@example.com', now())`);
  assert.deepEqual(await migrate(db), ['002_directory.sql', '003_review_queue.sql']);
  const { rows } = await db.query(`SELECT lists FROM waitlist WHERE email = 'old@example.com'`);
  assert.deepEqual(rows[0].lists, ['waitlist']);
});

test('signal_snapshots keeps NULL for unmeasured signals and rejects bad rows', async () => {
  const db = await freshDb();
  await migrate(db);
  await db.query(`INSERT INTO signal_snapshots (slug, day, wiki_views) VALUES ('ollama', '2026-11-08', 1200)`);
  const { rows } = await db.query(`SELECT wiki_views, gh_stars, hn_points FROM signal_snapshots`);
  assert.deepEqual(rows[0], { wiki_views: 1200, gh_stars: null, hn_points: null });
  await assert.rejects(db.query(`INSERT INTO signal_snapshots (slug, day) VALUES ('ollama', '2026-11-08')`), /duplicate key/);
  await assert.rejects(db.query(`INSERT INTO signal_snapshots (slug, day, gh_stars) VALUES ('ollama', '2026-11-09', -1)`), /check constraint/);
  await assert.rejects(db.query(`INSERT INTO signal_snapshots (slug, day) VALUES ('Bad Slug', '2026-11-09')`), /check constraint/);
});

test('directory enums are enforced', async () => {
  const db = await freshDb();
  await migrate(db);
  await assert.rejects(db.query(`INSERT INTO trending_scores (slug, window_kind, period, score, breakdown) VALUES ('a', 'decade', '2026', 50, '{}')`), /check constraint/);
  await assert.rejects(db.query(`INSERT INTO trending_scores (slug, window_kind, period, score, breakdown) VALUES ('a', 'week', '2026-W46', 101, '{}')`), /check constraint/);
  await assert.rejects(db.query(`INSERT INTO tool_candidates (url, domain, source) VALUES ('https://x.ai', 'x.ai', 'twitter')`), /check constraint/);
  await assert.rejects(db.query(`INSERT INTO tool_clicks_daily (slug, day, country) VALUES ('a', '2026-11-09', 'pk')`), /check constraint/);
  await assert.rejects(db.query(`INSERT INTO job_runs (job) VALUES ('mystery')`), /check constraint/);
  await db.query(`INSERT INTO tool_candidates (url, domain, source) VALUES ('https://x.ai', 'x.ai', 'hn')`);
  await assert.rejects(db.query(`INSERT INTO tool_candidates (url, domain, source) VALUES ('https://www.x.ai', 'x.ai', 'github')`), /duplicate key/);
});

test('003 review queue: fixed reject reasons, flags default to empty', async () => {
  const db = await freshDb();
  await migrate(db);
  await db.query(`INSERT INTO tool_candidates (url, domain, source, name) VALUES ('https://a.ai', 'a.ai', 'submit', 'A')`);
  const { rows } = await db.query(`SELECT flags, attempts, status FROM tool_candidates`);
  assert.deepEqual(rows[0], { flags: [], attempts: 0, status: 'new' });
  await assert.rejects(db.query(`UPDATE tool_candidates SET status='rejected', reject_reason='meh'`), /check constraint/);
  await db.query(`UPDATE tool_candidates SET status='rejected', reject_reason='dead_site'`);
});
