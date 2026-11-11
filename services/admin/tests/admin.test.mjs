// Editor console tests in plain Node: real Postgres (PGlite + all migrations), fake GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../db/scripts/lib.mjs';
import { createAdmin } from '../src/app.js';
import { queueStore } from '../src/db.js';
import { seal, unseal, SESSION } from '../src/auth.js';
import { checkTool, wordCount } from '../src/validate.js';

const SECRET = 'x'.repeat(40);
const ADMIN = 'https://admin.freemeans.com';
const NOW = new Date('2026-11-10T10:00:00Z');
const ollama = JSON.parse(readFileSync(new URL('../../../data/tools/ollama.json', import.meta.url)));

const goodTool = (over = {}) => ({
  ...structuredClone(ollama), slug: 'voicekit', name: 'VoiceKit', url: 'https://voicekit.ai/', open_source: false, repo_url: null, license: null,
  free_tier: { ...ollama.free_tier, type: 'credits', quota: { value: 10000, unit: 'characters', period: 'month' }, source_url: 'https://voicekit.ai/pricing', verified_at: '2026-11-10' },
  signals: { ...ollama.signals, github_repo: null, hn_domain: 'voicekit.ai' }, alternatives: [], listed_at: '2026-11-10',
  changelog: [{ date: '2026-11-10', field: 'listed', note: 'Listed in the directory' }], ...over,
});

async function setup({ users = ['mcwm04'], ghLogin = 'mcwm04', existing = [] } = {}) {
  const pg = new PGlite();
  await migrate(pg);
  const store = queueStore((t, p) => pg.query(t, p));
  const commits = [];
  const github = (token) => ({
    user: async () => ({ login: ghLogin }),
    fileExists: async (path) => existing.includes(path),
    createFile: async (path, content, message) => { commits.push({ token, path, content, message }); return { commitUrl: 'https://github.com/mcwm04/freemeans/commit/abc' }; },
  });
  const oauth = { authorizeUrl: (state, cb) => `https://github.com/login/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent(cb)}`, exchange: async (code) => `tok-${code}` };
  const app = createAdmin({
    store, oauth, github, sessionSecret: SECRET, adminUrl: ADMIN, allowedUsers: users, now: () => NOW,
    siteTools: async () => [{ slug: 'ollama', name: 'Ollama', url: 'https://ollama.com', verified_at: '2026-09-01' },
      { slug: 'comfyui', name: 'ComfyUI', url: 'https://www.comfy.org', verified_at: '2026-11-09' }],
  });
  const session = await seal(SECRET, { login: 'mcwm04', token: 'gho_secret', exp: NOW.getTime() + 3_600_000 });
  const as = (path, init = {}) => app(new Request(`${ADMIN}${path}`, { ...init, headers: { cookie: `${SESSION}=${encodeURIComponent(session)}`, ...(init.headers || {}) } }));
  const postForm = (path, fields, origin = ADMIN) => as(path, { method: 'POST', body: new URLSearchParams(fields).toString(), headers: { origin, 'content-type': 'application/x-www-form-urlencoded' } });
  const add = async (fields) => (await pg.query(
    `INSERT INTO tool_candidates (url, domain, source, name, status, priority, draft, flags, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [fields.url, fields.domain, fields.source ?? 'hn', fields.name ?? null, fields.status ?? 'drafted', fields.priority ?? 50,
      fields.draft ? JSON.stringify(fields.draft) : null, fields.flags ?? [], fields.evidence ? JSON.stringify(fields.evidence) : null])).rows[0].id;
  return { app, as, postForm, add, pg, commits };
}

test('signed-out visitors are sent to GitHub sign-in with a state cookie', async () => {
  const { app } = await setup();
  const res = await app(new Request(`${ADMIN}/`));
  assert.equal(res.status, 303);
  assert.equal(res.headers.get('location'), '/login');
  const login = await app(new Request(`${ADMIN}/login`));
  assert.match(login.headers.get('location'), /^https:\/\/github\.com\/login\/oauth\/authorize\?state=[0-9a-f-]+&redirect_uri=https%3A%2F%2Fadmin\.freemeans\.com%2Fcallback$/);
  assert.match(login.headers.get('set-cookie'), /^fm_oauth_state=.+; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=600$/);
  assert.equal(login.headers.get('x-robots-tag'), 'noindex, nofollow');
});

async function callback(app, { tamper = false } = {}) {
  const login = await app(new Request(`${ADMIN}/login`));
  const state = new URL(login.headers.get('location')).searchParams.get('state');
  const stateCookie = login.headers.get('set-cookie').split(';')[0];
  return app(new Request(`${ADMIN}/callback?code=abc&state=${tamper ? 'other' : state}`, { headers: { cookie: stateCookie } }));
}

test('the GitHub callback signs in allowed editors only, and checks the state', async () => {
  const ok = await callback((await setup()).app);
  assert.equal(ok.status, 303);
  const sealed = decodeURIComponent(ok.headers.get('set-cookie').split(';')[0].split('=')[1]);
  const s = await unseal(SECRET, sealed, NOW.getTime());
  assert.equal(s.login, 'mcwm04');
  assert.equal(s.token, 'tok-abc');
  assert.doesNotMatch(ok.headers.get('set-cookie'), /tok-abc/, 'token is encrypted in the cookie');
  assert.equal((await callback((await setup()).app, { tamper: true })).status, 400);
  assert.equal((await callback((await setup({ ghLogin: 'stranger' })).app)).status, 403);
});

test('a session for a user who is no longer allowed is refused', async () => {
  const { as } = await setup({ users: ['someone-else'] });
  assert.equal((await as('/')).status, 303);
});

test('queue lists candidates (drafted first), escapes crawled text, shows stale tools and jobs', async () => {
  const { as, add, pg } = await setup();
  await add({ url: 'https://evil.ai/', domain: 'evil.ai', name: '<script>alert(1)</script>', status: 'needs_manual', priority: 90 });
  await add({ url: 'https://voicekit.ai/', domain: 'voicekit.ai', draft: goodTool(), priority: 10 });
  await pg.query(`INSERT INTO job_runs (job, ok) VALUES ('crawler', true)`);
  const res = await as('/');
  const body = await res.text();
  assert.equal(res.status, 200);
  assert.ok(!body.includes('<script>alert(1)'), 'crawled names are escaped');
  assert.ok(body.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(body.indexOf('VoiceKit') < body.indexOf('&lt;script&gt;'), 'drafted before needs manual');
  assert.match(body, /Ollama<\/a> <small>checked 2026-09-01/);
  assert.doesNotMatch(body, /ComfyUI<\/a> <small>checked/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
});

test('review page shows the draft, flags, evidence and problems', async () => {
  const { as, add } = await setup();
  const id = await add({ url: 'https://voicekit.ai/', domain: 'voicekit.ai', draft: goodTool({ description: 'Too short.' }),
    flags: ['number_blanked:free_tier.quota'], evidence: { 'free_tier.quota': 'Free: 10,000 characters per month' } });
  const body = await (await as(`/c/${id}`)).text();
  assert.match(body, /description: has 2 words; it needs 80–150/);
  assert.match(body, /number_blanked:free_tier\.quota/);
  assert.match(body, /Free: 10,000 characters per month/);
  assert.match(body, /<iframe src="https:\/\/voicekit\.ai\/" sandbox=/);
});

test('approve validates, then commits data/tools/{slug}.json as the editor and closes the candidate', async () => {
  const { postForm, add, pg, commits } = await setup();
  const id = await add({ url: 'https://voicekit.ai/', domain: 'voicekit.ai', draft: goodTool() });
  const bad = await postForm(`/c/${id}`, { action: 'approve', json: JSON.stringify(goodTool({ tagline: 'The best voice tool ever made for you' })) });
  assert.match(await bad.text(), /marketing word &quot;best&quot;/);
  assert.equal(commits.length, 0);
  const broken = await postForm(`/c/${id}`, { action: 'approve', json: '{ nope' });
  assert.match(await broken.text(), /not valid JSON/);

  const shuffled = Object.fromEntries(Object.entries(goodTool()).reverse());
  const res = await postForm(`/c/${id}`, { action: 'approve', json: JSON.stringify(shuffled) });
  assert.match(await res.text(), /Published <b>VoiceKit<\/b>/);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].path, 'data/tools/voicekit.json');
  assert.equal(commits[0].token, 'gho_secret');
  assert.deepEqual(JSON.parse(commits[0].content), goodTool());
  assert.deepEqual(Object.keys(JSON.parse(commits[0].content)), Object.keys(ollama), 'keys in the same order as other tool files');
  assert.match(commits[0].message, /^Add tool: VoiceKit\n\nApproved in the editor console by @mcwm04/);
  const { rows } = await pg.query('SELECT status, published_slug, reviewed_by FROM tool_candidates WHERE id = $1', [id]);
  assert.deepEqual(rows[0], { status: 'approved', published_slug: 'voicekit', reviewed_by: 'mcwm04' });
});

test('approve refuses an existing file or an already listed site', async () => {
  const { postForm, add, commits } = await setup({ existing: ['data/tools/voicekit.json'] });
  const id = await add({ url: 'https://voicekit.ai/', domain: 'voicekit.ai', draft: goodTool() });
  assert.match(await (await postForm(`/c/${id}`, { action: 'approve', json: JSON.stringify(goodTool()) })).text(), /already exists/);
  const dup = await postForm(`/c/${id}`, { action: 'approve', json: JSON.stringify(goodTool({ slug: 'ollama-2', url: 'https://www.ollama.com/' })) });
  assert.match(await dup.text(), /already listed as &quot;Ollama&quot;/);
  assert.equal(commits.length, 0);
});

test('form posts: same-origin browsers that send Origin null are accepted, cross-site ones are not', async () => {
  const { as, add } = await setup();
  const id = await add({ url: 'https://voicekit.ai/', domain: 'voicekit.ai', draft: goodTool() });
  const post = (headers) => as(`/c/${id}/reject`, { method: 'POST', body: 'reason=duplicate', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } });
  assert.equal((await post({ origin: 'null', 'sec-fetch-site': 'cross-site' })).status, 403, 'sandboxed cross-site form');
  assert.equal((await post({})).status, 403, 'no Origin and no Fetch Metadata');
  assert.equal((await post({ origin: 'null', 'sec-fetch-site': 'same-origin' })).status, 303, 'browser with no-referrer sends null');
});

test('save keeps edits; reject stores a fixed reason; forms from other sites are blocked', async () => {
  const { postForm, add, pg, as } = await setup();
  const id = await add({ url: 'https://voicekit.ai/', domain: 'voicekit.ai', draft: goodTool() });
  await postForm(`/c/${id}`, { action: 'save', json: JSON.stringify(goodTool({ name: 'VoiceKit Pro' })) });
  assert.equal((await pg.query('SELECT draft FROM tool_candidates WHERE id=$1', [id])).rows[0].draft.name, 'VoiceKit Pro');
  assert.equal((await postForm(`/c/${id}/reject`, { reason: 'unsafe' }, 'https://evil.example')).status, 403);
  const r = await postForm(`/c/${id}/reject`, { reason: 'duplicate' });
  assert.equal(r.status, 303);
  assert.deepEqual((await pg.query('SELECT status, reject_reason FROM tool_candidates WHERE id=$1', [id])).rows[0], { status: 'duplicate', reject_reason: 'duplicate' });
  assert.doesNotMatch(await (await as(`/c/${id}`)).text(), /Approve and publish/, 'reviewed candidates are read-only');
});

test('editor can add a tool to the queue by hand', async () => {
  const { postForm, pg } = await setup();
  const res = await postForm('/seed', { url: 'https://www.voicekit.ai/x', name: 'VoiceKit' });
  assert.equal(res.status, 303);
  assert.deepEqual((await pg.query('SELECT domain, source, priority FROM tool_candidates')).rows, [{ domain: 'voicekit.ai', source: 'editor', priority: 70 }]);
  assert.match(await (await postForm('/seed', { url: 'https://voicekit.ai', name: 'Again' })).text(), /already in the queue/);
});

test('console validation agrees with toolcheck on the repo tools', () => {
  const dir = new URL('../../../data/tools/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    // Real files are checked against today's date: a fixed date breaks whenever a tool is added later.
    assert.deepEqual(checkTool(JSON.parse(readFileSync(new URL(f, dir))), new Date().toISOString().slice(0, 10)), [], f);
  }
  assert.ok(checkTool(goodTool({ slug: 'submit' }), '2026-11-10').some((e) => e.includes('reserved')));
  assert.ok(checkTool(goodTool({ categories: ['nope'] }), '2026-11-10').some((e) => e.includes('unknown category')));
  assert.ok(checkTool(goodTool({ listed_at: '2027-01-01' }), '2026-11-10').some((e) => e.includes('future')));
  assert.ok(checkTool({ ...goodTool(), extra: 1 }, '2026-11-10').length > 0);
  assert.equal(wordCount("Free, open-source app's thing"), 4);
});
