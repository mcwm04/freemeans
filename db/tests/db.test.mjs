// Runs the real migration and loader against PGlite: Postgres compiled to WebAssembly,
// in memory, no server and no network. Same SQL that runs on Neon.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { migrate, loadCatalog, readSeed, checkCatalog, mergeCatalogs, readCatalogs, SEED_PATH } from '../scripts/lib.mjs';

async function freshDb() {
  const pg = new PGlite();
  await pg.waitReady;
  return pg; // PGlite already has exec(sql) and query(sql, params) → { rows }
}

test('migration creates every table and is idempotent', async () => {
  const db = await freshDb();
  assert.deepEqual(await migrate(db), ['001_init.sql', '002_directory.sql', '003_review_queue.sql', '004_eligibility.sql', '005_learning.sql']);
  assert.deepEqual(await migrate(db), []);
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`,
  );
  assert.deepEqual(rows.map((r) => r.table_name), [
    'badges', 'catalog_versions', 'job_runs', 'limit_rules', 'resources', 'schema_migrations',
    'signal_backfills', 'signal_snapshots', 'sources', 'sponsorships', 'tool_candidates',
    'tool_clicks_daily', 'trending_scores', 'vendor_claims', 'waitlist', 'watch_phrases',
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
  assert.deepEqual(await migrate(db), ['002_directory.sql', '003_review_queue.sql', '004_eligibility.sql', '005_learning.sql']);
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

// ---- 004_eligibility.sql (students, teachers, nonprofits, startups, countries) ----

const EXAMPLE_URL = new URL('../../packages/schema/examples/eligibility.example.json', import.meta.url);
const example = () => JSON.parse(readFileSync(EXAMPLE_URL, 'utf8'));
const schema = (name) => JSON.parse(readFileSync(new URL(`../../packages/schema/${name}`, import.meta.url), 'utf8'));

test('004 runs on a database that already has 001, 002 and 003 with the live seed loaded', async () => {
  const db = await freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const f of ['001_init.sql', '002_directory.sql', '003_review_queue.sql'])
    copyFileSync(new URL(`../migrations/${f}`, import.meta.url), join(dir, f));
  await migrate(db, dir);
  // Old loader shape: no eligibility columns yet.
  await db.query(`INSERT INTO catalog_versions (version, resource_count) VALUES ('old', 1)`);
  await db.query(`INSERT INTO resources (id, provider, name, kind, tier_type, last_verified, record, catalog_version)
                  VALUES ('groq.x', 'Groq', 'X', 'llm_api', 'free', '2026-11-01', '{}', 'old')`);
  assert.deepEqual(await migrate(db), ['004_eligibility.sql', '005_learning.sql']);
  const { rows } = await db.query(`SELECT status, audiences, country_mode, countries FROM resources WHERE id = 'groq.x'`);
  assert.deepEqual(rows[0], { status: 'active', audiences: [], country_mode: 'global', countries: [] });
});

test('SQL CHECK lists match the JSON schemas exactly', async () => {
  const db = await freshDb();
  await migrate(db);
  const resource = schema('resource.schema.json');
  const lists = {
    'resources.kind': resource.properties.kind.enum,
    'resources.status': resource.properties.status.enum,
    'badges.type': schema('badge.schema.json').properties.type.enum,
    'limit_rules.metric': schema('limit_rule.schema.json').properties.metric.enum,
    'limit_rules.window': schema('limit_rule.schema.json').properties.window.enum,
  };
  const names = {
    'resources.kind': 'resources_kind_check', 'resources.status': 'resources_status_check',
    'badges.type': 'badges_type_check', 'limit_rules.metric': 'limit_rules_metric_check',
    'limit_rules.window': 'limit_rules_window_check',
  };
  for (const [field, values] of Object.entries(lists)) {
    const { rows } = await db.query(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = $1`, [names[field]]);
    assert.equal(rows.length, 1, `${names[field]} exists`);
    const inSql = [...rows[0].def.matchAll(/'([a-z0-9_]+)'/g)].map((m) => m[1]);
    assert.deepEqual([...inSql].sort(), [...values].sort(), `${field}: SQL and schema differ`);
  }
});

test('eligibility offers load with their columns and watch phrases', async () => {
  const db = await freshDb();
  await migrate(db);
  const catalog = mergeCatalogs([readSeed(), example()]);
  assert.equal(catalog.version, '0.1.0-seed+0.0.0-example');
  await loadCatalog(db, catalog);

  const { rows } = await db.query(
    `SELECT status, redeem_by::text, audiences, country_mode, countries FROM resources WHERE id = 'google.ai-plus-student'`);
  assert.deepEqual(rows[0], {
    status: 'active', redeem_by: '2026-12-31', audiences: ['student_higher_ed'], country_mode: 'exclude', countries: ['US'],
  });
  const badges = (await db.query(`SELECT type FROM badges WHERE resource_id = 'google.ai-plus-student' ORDER BY type`)).rows;
  assert.deepEqual(badges.map((b) => b.type), ['auto_renews_paid', 'payment_method_required']);
  const watch = (await db.query(`SELECT text FROM watch_phrases WHERE resource_id = 'google.ai-plus-student'`)).rows;
  assert.deepEqual(watch, [{ text: 'December 31, 2026' }]);
  const azure = (await db.query(`SELECT metric, "window", value FROM limit_rules WHERE resource_id = 'microsoft.azure-for-students'`)).rows;
  assert.deepEqual(azure, [{ metric: 'credit_usd', window: 'year', value: '100' }]);

  // API-tier rows keep the defaults.
  const groq = (await db.query(`SELECT status, country_mode FROM resources WHERE id = 'groq.gpt-oss-120b'`)).rows[0];
  assert.deepEqual(groq, { status: 'active', country_mode: 'global' });
});

test('country filter: global, include and exclude', async () => {
  const db = await freshDb();
  await migrate(db);
  await loadCatalog(db, mergeCatalogs([readSeed(), example()]));
  // The rule the API will use in Module 3.
  const forCountry = async (cc) => (await db.query(
    `SELECT id FROM resources
     WHERE cardinality(audiences) > 0 AND (
       country_mode = 'global' OR
       (country_mode = 'include' AND $1 = ANY(countries)) OR
       (country_mode = 'exclude' AND NOT ($1 = ANY(countries))))
     ORDER BY id`, [cc])).rows.map((r) => r.id);
  assert.ok((await forCountry('PK')).includes('google.ai-plus-student'));
  assert.ok(!(await forCountry('US')).includes('google.ai-plus-student'));
  assert.ok((await forCountry('US')).includes('github.nonprofits'));
});

test('an offer past its redeem-by date reads as ended, whatever the stored status', async () => {
  const db = await freshDb();
  await migrate(db);
  const cat = example();
  cat.resources[0].offer_window.redeem_by = '2020-01-31';
  await loadCatalog(db, cat);
  const row = async (id) => (await db.query(
    `SELECT status, effective_status FROM resources_live WHERE id = $1`, [id])).rows[0];
  assert.deepEqual(await row('google.ai-plus-student'), { status: 'active', effective_status: 'ended' });
  assert.deepEqual(await row('microsoft.azure-for-students'), { status: 'active', effective_status: 'active' });
  assert.deepEqual(await row('aws.educate-credits'), { status: 'ended', effective_status: 'ended' });
});

test('auto-renewing offers without the red badge are refused before any write', async () => {
  const db = await freshDb();
  await migrate(db);
  const cat = example();
  cat.resources[0].badges = cat.resources[0].badges.filter((b) => b.type !== 'auto_renews_paid');
  await assert.rejects(loadCatalog(db, cat), /auto_renews_paid/);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM resources')).rows[0].n, 0);
});

test('merging catalog files: missing files are skipped, duplicate ids across files are caught', async () => {
  const seedOnly = readCatalogs([SEED_PATH, '/no/such/eligibility.json']);
  assert.equal(seedOnly.version, readSeed().version);
  const seed = readSeed();
  const clash = mergeCatalogs([seed, { version: 'x', generated_at: '2026-11-09', resources: [seed.resources[0]] }]);
  assert.deepEqual(checkCatalog(clash), [`duplicate id ${seed.resources[0].id}`]);
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

test('a free course with a paid certificate loads with its badge (migration 005)', async () => {
  const db = await freshDb();
  await migrate(db);
  const learning = JSON.parse(readFileSync(new URL('../../packages/schema/examples/learning.example.json', import.meta.url), 'utf8'));
  await loadCatalog(db, mergeCatalogs([readSeed(), learning]));
  const badges = (await db.query(`SELECT type FROM badges WHERE resource_id = 'example.paid-certificate-course'`)).rows;
  assert.deepEqual(badges.map((b) => b.type), ['paid_certificate']);
  const { rows } = await db.query(`SELECT record FROM resources WHERE id = 'example.cohort-course'`);
  const record = typeof rows[0].record === 'string' ? JSON.parse(rows[0].record) : rows[0].record;
  assert.equal(record.learning.format, 'cohort', 'the learning block stays in the stored record');
});

test('005 runs on a database that already has 001 to 004 and keeps existing badges', async () => {
  const db = await freshDb();
  const dir = mkdtempSync(join(tmpdir(), 'mig-'));
  for (const f of ['001_init.sql', '002_directory.sql', '003_review_queue.sql', '004_eligibility.sql'])
    copyFileSync(new URL(`../migrations/${f}`, import.meta.url), join(dir, f));
  await migrate(db, dir);
  await db.query(`INSERT INTO catalog_versions (version, resource_count) VALUES ('old', 1)`);
  await db.query(`INSERT INTO resources (id, provider, name, kind, tier_type, last_verified, record, catalog_version)
                  VALUES ('google.x', 'Google', 'X', 'ai_subscription', 'trial', '2026-11-01', '{}', 'old')`);
  await db.query(`INSERT INTO badges (resource_id, type, source_url) VALUES ('google.x', 'auto_renews_paid', 'https://example.com')`);
  await assert.rejects(db.query(`INSERT INTO badges (resource_id, type, source_url) VALUES ('google.x', 'paid_certificate', 'https://example.com')`));
  assert.deepEqual(await migrate(db), ['005_learning.sql']);
  await db.query(`INSERT INTO badges (resource_id, type, source_url) VALUES ('google.x', 'paid_certificate', 'https://example.com')`);
  const { rows } = await db.query(`SELECT type FROM badges WHERE resource_id = 'google.x' ORDER BY type`);
  assert.deepEqual(rows.map((r) => r.type), ['auto_renews_paid', 'paid_certificate']);
});
