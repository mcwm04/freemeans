// API tests in plain Node: the app is called with real Request objects, against
// (1) the bundled seed, (2) a real Postgres (PGlite) loaded by the db/ scripts, and
// (3) a failing database, to prove the read fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import seed from '../../../data/catalog/seed.json' with { type: 'json' };
import { createApp } from '../src/app.js';
import { seedStore, sqlStore, withFallback } from '../src/store.js';
import { migrate, loadCatalog } from '../../../db/scripts/lib.mjs';
import worker from '../src/index.js';

const SITE = 'https://freemeans.com';
const call = (app, path, init = {}) => app(new Request(`https://api.freemeans.com${path}`, init));
const body = async (res) => res.json();
const post = (data, headers = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(data),
});

async function pgApp() {
  const pg = new PGlite();
  await migrate(pg);
  await loadCatalog(pg, seed);
  const query = (text, params) => pg.query(text, params);
  return { pg, app: createApp({ store: sqlStore(query), siteUrl: SITE, allowedOrigins: [SITE] }) };
}

test('GET /catalog returns summaries for every resource', async () => {
  const app = createApp({ store: seedStore(seed), siteUrl: SITE });
  const res = await call(app, '/catalog');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /max-age=300/);
  const b = await body(res);
  assert.equal(b.version, seed.version);
  assert.equal(b.count, seed.resources.length);
  const groq = b.resources.find((r) => r.id === 'groq.gpt-oss-120b');
  assert.deepEqual(Object.keys(groq).sort(), ['badges', 'id', 'kind', 'last_verified', 'limits', 'name', 'official', 'provider', 'tier_type', 'url']);
  assert.equal(groq.url, `${SITE}/resources/groq.gpt-oss-120b/`);
});

test('catalog filters: kind, provider, q, safe_for and full records', async () => {
  const app = createApp({ store: seedStore(seed), siteUrl: SITE });
  const ids = async (qs) => (await body(await call(app, `/catalog?${qs}`))).resources.map((r) => r.id);

  assert.deepEqual(await ids('kind=speech_api'), ['groq.whisper-large-v3']);
  assert.ok((await ids('provider=groq')).every((id) => id.startsWith('groq.')));
  assert.deepEqual(await ids('q=whisper'), ['groq.whisper-large-v3']);

  const client = await ids('safe_for=client');
  assert.ok(!client.includes('google.gemini-api-free'), 'trains_on_data must be excluded for client work');
  assert.ok(!client.includes('cohere.trial-key'), 'non_commercial must be excluded for client work');
  assert.ok(!client.includes('google.colab-free'), 'manual_only is never offered');
  assert.ok(client.includes('groq.gpt-oss-120b'));

  assert.ok(!(await ids('safe_for=eu')).includes('google.gemini-api-free'));
  assert.ok(!(await ids('safe_for=production')).includes('openrouter.free-models'));

  const full = await body(await call(app, '/catalog?kind=speech_api&full=true'));
  assert.ok(Array.isArray(full.resources[0].limit_rules));
});

test('unknown safe_for values are a 400 with the allowed list', async () => {
  const app = createApp({ store: seedStore(seed), siteUrl: SITE });
  const res = await call(app, '/catalog?safe_for=moon');
  assert.equal(res.status, 400);
  assert.match((await body(res)).error, /client, commercial, eu/);
});

test('GET /resources/:id returns the full record or 404', async () => {
  const app = createApp({ store: seedStore(seed), siteUrl: SITE });
  const ok = await call(app, '/resources/google.colab-free');
  assert.equal(ok.status, 200);
  const r = await body(ok);
  assert.equal(r.id, 'google.colab-free');
  assert.equal(r.badges[0].type, 'manual_only');
  const missing = await call(app, '/resources/nope.nothing');
  assert.equal(missing.status, 404);
  assert.match((await body(missing)).error, /nope\.nothing/);
});

test('waitlist without a database answers 503 with a clear reason', async () => {
  const app = createApp({ store: seedStore(seed), siteUrl: SITE });
  const res = await call(app, '/waitlist', post({ email: 'a@b.pk', consent: true }));
  assert.equal(res.status, 503);
  assert.match((await body(res)).error, /DATABASE_URL/);
});

test('waitlist on Postgres: stores once, lower-cases, records country, same answer twice', async () => {
  const { pg, app } = await pgApp();
  const r1 = await call(app, '/waitlist', post({ email: '  Ali@Example.PK ', consent: true, source: 'home' }, { 'cf-ipcountry': 'pk' }));
  assert.equal(r1.status, 200);
  assert.deepEqual(await body(r1), { ok: true });
  const r2 = await call(app, '/waitlist', post({ email: 'ali@example.pk', consent: true }));
  assert.deepEqual(await body(r2), { ok: true });
  const { rows } = await pg.query('SELECT email, source, country FROM waitlist');
  assert.deepEqual(rows, [{ email: 'ali@example.pk', source: 'home', country: 'PK' }]);
});

test('waitlist validation: bad email, missing consent, honeypot, wrong method, big body', async () => {
  const { pg, app } = await pgApp();
  assert.equal((await call(app, '/waitlist', post({ email: 'not-an-email', consent: true }))).status, 400);
  const noConsent = await call(app, '/waitlist', post({ email: 'x@y.pk' }));
  assert.equal(noConsent.status, 400);
  assert.match((await body(noConsent)).error, /tick the box/);
  const bot = await call(app, '/waitlist', post({ email: 'bot@spam.io', consent: true, website: 'http://spam' }));
  assert.equal(bot.status, 200);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM waitlist')).rows[0].n, 0);
  assert.equal((await call(app, '/waitlist')).status, 405);
  const big = await call(app, '/waitlist', post({ email: 'x@y.pk', consent: true, pad: 'x'.repeat(5000) }));
  assert.equal(big.status, 413);
  const bad = await call(app, '/waitlist', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'hi' });
  assert.equal(bad.status, 415);
});

test('a plain HTML form post is stored and redirected back to the site', async () => {
  const { pg, app } = await pgApp();
  const res = await call(app, '/waitlist', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: 'email=sana%40uaf.edu.pk&consent=true&source=home&website=',
  });
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), `${SITE}/?joined=1#waitlist`);
  assert.equal((await pg.query('SELECT email FROM waitlist')).rows[0].email, 'sana@uaf.edu.pk');
});

test('catalog from Postgres matches the seed exactly', async () => {
  const { app } = await pgApp();
  const b = await body(await call(app, '/catalog?full=true'));
  assert.equal(b.version, seed.version);
  const byId = Object.fromEntries(b.resources.map((r) => [r.id, r]));
  for (const r of seed.resources) assert.deepEqual(byId[r.id], r);
});

test('if Neon fails, reads fall back to the bundled seed and say so; writes do not', async () => {
  const broken = sqlStore(async () => { throw new Error('connection refused'); });
  const app = createApp({ store: withFallback(broken, seedStore(seed)), siteUrl: SITE });
  const res = await call(app, '/catalog');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-freemeans-fallback'), 'seed');
  assert.equal((await body(res)).count, seed.resources.length);
  assert.equal((await call(app, '/resources/groq.gpt-oss-20b')).status, 200);
  assert.match((await body(await call(app, '/health'))).store, /fallback/);
  const w = await call(app, '/waitlist', post({ email: 'a@b.pk', consent: true }));
  assert.equal(w.status, 500);
  assert.equal((await body(w)).error, 'Something went wrong on our side.'); // no internals leaked
});

test('CORS: allowed origins get headers and preflight; others do not', async () => {
  const app = createApp({ store: seedStore(seed), siteUrl: SITE, allowedOrigins: [SITE] });
  const pre = await call(app, '/waitlist', { method: 'OPTIONS', headers: { origin: SITE } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), SITE);
  const other = await call(app, '/catalog', { headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
});

test('Worker entry point serves the seed when DATABASE_URL is not set', async () => {
  const res = await worker.fetch(new Request('https://api.freemeans.com/health'), { SITE_URL: SITE });
  const b = await res.json();
  assert.equal(b.store, 'seed');
  assert.equal(b.catalog_version, seed.version);
  const nf = await worker.fetch(new Request('https://api.freemeans.com/nothing'), {});
  assert.equal(nf.status, 404);
});

test('every API answer tells search engines not to index it', async () => {
  const app = createApp({ store: seedStore(seed), siteUrl: SITE });
  for (const path of ['/health', '/catalog', '/resources/groq.gpt-oss-120b', '/nope']) {
    const res = await call(app, path);
    assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow', path);
  }
});
