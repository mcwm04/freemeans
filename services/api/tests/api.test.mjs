// API tests in plain Node: the app is called with real Request objects, against
// (1) the bundled seed, (2) a real Postgres (PGlite) loaded by the db/ scripts, and
// (3) a failing database, to prove the read fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import seed from '../../../data/catalog/seed.json' with { type: 'json' };
import eligibility from '../../../data/catalog/eligibility.json' with { type: 'json' };
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
  assert.equal(b.catalog_version, `${seed.version}+${eligibility.version}`);
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

// ---------- M4: /go/{slug} click counting ----------
import { linkSource } from '../src/links.js';

const LINKS = new Map([['ollama', 'https://ollama.com'], ['comfyui', 'https://www.comfy.org']]);
const BROWSER = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131 Safari/537.36', 'cf-connecting-ip': '203.0.113.7', 'cf-ipcountry': 'PK' };

function memDedupe() {
  const seen = new Set();
  return { seen: async (k) => (seen.has(k) ? true : (seen.add(k), false)) };
}

async function goApp() {
  const pg = new PGlite();
  await migrate(pg);
  const query = (text, params) => pg.query(text, params);
  const pending = [];
  const app = createApp({ store: sqlStore(query), siteUrl: SITE, links: async () => LINKS, dedupe: memDedupe(), waitUntil: (p) => pending.push(p) });
  const flush = () => Promise.all(pending.splice(0));
  const clicks = async () => (await pg.query('SELECT slug, country, clicks FROM tool_clicks_daily ORDER BY slug, country')).rows;
  return { app, flush, clicks };
}

test('/go/{slug} redirects to the tool and counts one click per visitor per day', async () => {
  const { app, flush, clicks } = await goApp();
  const res = await call(app, '/go/ollama', { headers: BROWSER });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://ollama.com');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex, nofollow');
  await call(app, '/go/ollama', { headers: BROWSER }); // same visitor again: not counted twice
  await call(app, '/go/ollama', { headers: { ...BROWSER, 'cf-connecting-ip': '198.51.100.9', 'cf-ipcountry': 'US' } });
  await flush();
  assert.deepEqual(await clicks(), [{ slug: 'ollama', country: 'PK', clicks: 1 }, { slug: 'ollama', country: 'US', clicks: 1 }]);
});

test('/go/ ignores bots, prefetches and HEAD requests, but still redirects them', async () => {
  const { app, flush, clicks } = await goApp();
  for (const headers of [
    { 'user-agent': 'Googlebot/2.1 (+http://www.google.com/bot.html)' },
    { 'user-agent': 'WhatsApp/2.23' },
    { 'user-agent': 'curl/8.5' },
    {},
    { ...BROWSER, 'sec-purpose': 'prefetch' },
  ]) {
    const res = await call(app, '/go/comfyui', { headers });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), 'https://www.comfy.org');
  }
  assert.equal((await call(app, '/go/comfyui', { method: 'HEAD', headers: BROWSER })).status, 302);
  await flush();
  assert.deepEqual(await clicks(), []);
});

test('/go/ never redirects to an address outside the tool list', async () => {
  const { app, flush, clicks } = await goApp();
  const unknown = await call(app, '/go/not-a-tool', { headers: BROWSER });
  assert.equal(unknown.status, 302);
  assert.equal(unknown.headers.get('location'), `${SITE}/tools/`);
  assert.equal((await call(app, '/go/..%2F..%2Fevil.com', { headers: BROWSER })).status, 404);
  assert.equal((await call(app, '/go/ollama', { method: 'POST', headers: BROWSER })).status, 405);
  await flush();
  assert.deepEqual(await clicks(), []);
});

test('/go/ still redirects when the database is down or absent', async () => {
  const broken = createApp({
    store: withFallback(sqlStore(async () => { throw new Error('neon down'); }), seedStore(seed)),
    siteUrl: SITE, links: async () => LINKS, waitUntil: (p) => p,
  });
  const res = await call(broken, '/go/ollama', { headers: BROWSER });
  assert.equal(res.status, 302);
  const noDb = createApp({ store: seedStore(seed), siteUrl: SITE, links: async () => LINKS });
  assert.equal((await call(noDb, '/go/ollama', { headers: BROWSER })).headers.get('location'), 'https://ollama.com');
});

test('link map: live map from the site, bundled copy when the site cannot be read', async () => {
  let t = 0;
  let calls = 0;
  const live = linkSource({
    siteUrl: SITE, now: () => t,
    fetcher: async (url) => { calls++; assert.equal(url, `${SITE}/tools/links.json`); return new Response(JSON.stringify({ 'new-tool': 'https://new.example', bad: 'javascript:alert(1)' })); },
  });
  const m = await live();
  assert.equal(m.get('new-tool'), 'https://new.example');
  assert.equal(m.has('bad'), false, 'only https destinations');
  assert.equal(m.get('ollama'), 'https://ollama.com', 'bundled entries kept');
  await live();
  assert.equal(calls, 1, 'cached for 10 minutes');
  t += 11 * 60 * 1000;
  await live();
  assert.equal(calls, 2);

  const down = linkSource({ siteUrl: SITE, fetcher: async () => { throw new Error('offline'); } });
  assert.equal((await down()).get('llama-cpp'), 'https://github.com/ggml-org/llama.cpp');
});

// ---------- M5: POST /submit ----------
import { siteKey, parseSite } from '../src/domain.js';
import { turnstile } from '../src/index.js';
import cases from '../../../packages/schema/site-key-cases.json' with { type: 'json' };

test('siteKey follows the shared cases (same file as the crawler)', () => {
  for (const [url, key] of cases.cases) assert.equal(siteKey(url), key, url);
  for (const bad of cases.invalid) assert.equal(parseSite(bad), null, bad);
});

async function submitApp({ human = true } = {}) {
  const pg = new PGlite();
  await migrate(pg);
  const app = createApp({
    store: sqlStore((t, p) => pg.query(t, p)), siteUrl: SITE, allowedOrigins: [SITE],
    links: async () => LINKS, verifyHuman: async (token) => human && token === 'ok',
  });
  const rows = async () => (await pg.query('SELECT url, domain, source, name, category, submitter_email, priority, status FROM tool_candidates ORDER BY id')).rows;
  return { app, rows };
}
const form = (fields) => ({ method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() });

test('/submit queues a new tool once, keyed by site', async () => {
  const { app, rows } = await submitApp();
  const res = await call(app, '/submit', post({ url: 'https://www.newtool.ai/?utm_source=x#top', name: '  New   Tool ', category: 'video', email: 'Me@Vendor.ai', 'cf-turnstile-response': 'ok' }));
  assert.equal(res.status, 200);
  assert.deepEqual(await body(res), { ok: true, status: 'queued' });
  await call(app, '/submit', post({ url: 'https://app.newtool.ai', name: 'Again', 'cf-turnstile-response': 'ok' }));
  assert.deepEqual(await rows(), [{ url: 'https://www.newtool.ai/', domain: 'newtool.ai', source: 'submit', name: 'New Tool', category: 'video', submitter_email: 'me@vendor.ai', priority: 40, status: 'new' }]);
});

test('/submit form posts redirect back to the page with a status', async () => {
  const { app, rows } = await submitApp();
  const sent = await call(app, '/submit', form({ url: 'newtool.ai', name: 'New Tool', 'cf-turnstile-response': 'ok' }));
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get('location'), `${SITE}/tools/submit/?sent=1#form`);
  const listed = await call(app, '/submit', form({ url: 'https://ollama.com/download', name: 'Ollama', 'cf-turnstile-response': 'ok' }));
  assert.equal(listed.headers.get('location'), `${SITE}/tools/submit/?status=listed#form`);
  const bad = await call(app, '/submit', form({ url: 'http://localhost', name: 'X', 'cf-turnstile-response': 'ok' }));
  assert.equal(bad.headers.get('location'), `${SITE}/tools/submit/?error=url#form`);
  assert.equal((await rows()).length, 1);
});

test('/submit rejects failed spam checks, fills nothing for bots, validates fields', async () => {
  const { app, rows } = await submitApp();
  assert.equal((await call(app, '/submit', post({ url: 'https://x.ai', name: 'X', 'cf-turnstile-response': 'bad' }))).status, 403);
  assert.equal((await call(app, '/submit', post({ url: 'https://x.ai', name: 'X', website: 'spam' }))).status, 200);
  assert.equal((await call(app, '/submit', post({ url: 'https://x.ai', name: '', 'cf-turnstile-response': 'ok' }))).status, 400);
  assert.equal((await call(app, '/submit', post({ url: 'https://x.ai', name: 'X', email: 'nope', 'cf-turnstile-response': 'ok' }))).status, 400);
  assert.equal((await call(app, '/submit')).status, 405);
  assert.deepEqual(await rows(), []);
});

test('Turnstile check posts the token and secret to Cloudflare', async () => {
  let sent;
  const check = turnstile('s3cret', async (url, init) => { sent = { url, body: String(init.body) }; return new Response(JSON.stringify({ success: true })); });
  assert.equal(await check('tok', '1.2.3.4'), true);
  assert.equal(sent.url, 'https://challenges.cloudflare.com/turnstile/v0/siteverify');
  assert.equal(sent.body, 'secret=s3cret&response=tok&remoteip=1.2.3.4');
  assert.equal(await check('', ''), false);
  assert.equal(await turnstile('s', async () => new Response('{"success":false}'))('t'), false);
});

// --- Eligibility filters (M3) ------------------------------------------------

const both = { version: 'test', resources: [...seed.resources, ...eligibility.resources] };
const NOW = '2026-11-11';
const eligApp = (day = NOW) => createApp({ store: seedStore(both), siteUrl: SITE, now: () => new Date(`${day}T12:00:00Z`) });
const idsOf = async (app, qs) => (await body(await call(app, `/catalog?${qs}`))).resources.map((r) => r.id);

test('default catalog hides ended and unverified offers', async () => {
  const ids = await idsOf(eligApp(), '');
  assert.ok(ids.includes('github.copilot-student'));
  assert.ok(ids.includes('groq.gpt-oss-120b'), 'API free tiers without a status stay visible');
  for (const hidden of ['google.ai-plus-student', 'cursor.pro-student', 'aws.educate-credits', 'github.copilot-pro-student']) {
    assert.ok(!ids.includes(hidden), hidden);
  }
});

test('status and include_ended: unverified and ended appear only when asked for', async () => {
  const app = eligApp();
  assert.ok((await idsOf(app, 'status=unverified')).includes('google.ai-plus-student'));
  assert.ok(!(await idsOf(app, 'status=unverified')).includes('github.copilot-student'));
  const withEnded = await idsOf(app, 'include_ended=true');
  assert.ok(withEnded.includes('aws.educate-credits') && withEnded.includes('github.copilot-student'));
  assert.ok(!withEnded.includes('cursor.pro-student'), 'include_ended does not add unverified');
  assert.deepEqual(await idsOf(app, 'status=ended&audience=student_higher_ed&provider=aws'), ['aws.educate-credits']);
});

test('audience and group filters', async () => {
  const app = eligApp();
  const students = await idsOf(app, 'group=students');
  assert.ok(students.includes('github.student-pack') && students.includes('microsoft.azure-for-students'));
  assert.ok(!students.includes('github.nonprofits') && !students.includes('groq.gpt-oss-120b'));
  const nonprofits = await idsOf(app, 'audience=nonprofit');
  assert.ok(nonprofits.includes('google.for-nonprofits') && nonprofits.includes('cloudflare.project-galileo'));
  const both2 = await idsOf(app, 'audience=nonprofit&group=startups');
  assert.ok(both2.includes('github.nonprofits') && both2.includes('aws.activate-founders'));
});

test('country filter: global, include and exclude rules', async () => {
  const app = eligApp();
  const pk = await idsOf(app, 'country=PK&group=students');
  assert.ok(pk.includes('github.copilot-student'), 'global offers match');
  assert.ok(!pk.includes('google.ai-pro-student-us'), 'include [US] excludes Pakistan');
  assert.ok((await idsOf(app, 'country=pk&audience=resident')).includes('digiskills.dstp3'), 'lower case is accepted');
  assert.ok(!(await idsOf(app, 'country=US&audience=resident')).includes('digiskills.dstp3'));
  assert.ok((await idsOf(app, 'country=US&group=students')).includes('google.ai-pro-student-us'));
  // an exclude rule: Google AI Plus excludes US but is unverified, so ask for it explicitly
  assert.ok((await idsOf(app, 'status=unverified&country=PK&group=students')).includes('google.ai-plus-student'));
  assert.ok(!(await idsOf(app, 'status=unverified&country=US&group=students')).includes('google.ai-plus-student'));
  assert.ok((await idsOf(app, 'country=PK')).includes('groq.gpt-oss-120b'), 'API tiers have no country rule');
});

test('expiry is worked out at read time, whatever status is stored', async () => {
  const live = eligApp('2026-12-31'); // last day to claim
  assert.ok((await idsOf(live, 'group=students&country=US')).includes('google.ai-pro-student-us'));
  const after = eligApp('2027-01-01');
  assert.ok(!(await idsOf(after, 'group=students&country=US')).includes('google.ai-pro-student-us'));
  const ended = await idsOf(after, 'status=ended&group=students&country=US');
  assert.ok(ended.includes('google.ai-pro-student-us'));
  const one = await body(await call(after, '/resources/google.ai-pro-student-us'));
  assert.equal(one.status ?? 'active', 'active', 'the stored status is left alone');
  assert.equal(one.effective_status, 'ended');
});

test('ending_within_days lists offers whose redeem-by date is close', async () => {
  const app = eligApp('2026-11-11');
  const soon = await idsOf(app, 'ending_within_days=60');
  assert.ok(soon.includes('google.ai-pro-student-us'));
  assert.ok(!soon.includes('github.student-pack'), 'no end date');
  assert.deepEqual(await idsOf(app, 'ending_within_days=10'), []);
  assert.ok((await idsOf(eligApp('2027-02-01'), 'ending_within_days=60')).length === 0, 'already past');
});

test('eligibility summaries carry status, audiences and redeem_by; API tiers are unchanged', async () => {
  const b = await body(await call(eligApp(), '/catalog?audience=student_higher_ed&country=US'));
  const g = b.resources.find((r) => r.id === 'google.ai-pro-student-us');
  assert.equal(g.status, 'active');
  assert.deepEqual(g.audiences, ['student_higher_ed']);
  assert.equal(g.redeem_by, '2026-12-31');
  const groq = (await body(await call(eligApp(), '/catalog?provider=groq'))).resources[0];
  assert.ok(!('status' in groq) && !('audiences' in groq));
});

test('bad filter values are a 400 that names the allowed values', async () => {
  const app = eligApp();
  for (const [qs, re] of [
    ['group=moon', /students, teachers/], ['audience=everyone', /unknown audience/], ['country=Pakistan', /two-letter/],
    ['status=live', /active, paused, ended, unverified/], ['ending_within_days=soon', /whole number/], ['ending_within_days=0', /whole number/],
  ]) {
    const res = await call(app, `/catalog?${qs}`);
    assert.equal(res.status, 400, qs);
    assert.match((await body(res)).error, re, qs);
  }
});

test('Worker without a database serves the seed and the eligibility offers together', async () => {
  const res = await worker.fetch(new Request('https://api.freemeans.com/catalog?group=students&country=PK'), {}, {});
  const b = await body(res);
  assert.ok(b.resources.some((r) => r.id === 'github.copilot-student'));
  assert.match(b.version, /\+/);
});
