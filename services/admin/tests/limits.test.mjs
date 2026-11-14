// Cloudflare's free plan allows 50 subrequests per Worker request. Every database query (Neon over HTTP),
// GitHub call and outside fetch counts as one. These tests count them for the heaviest requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../db/scripts/lib.mjs';
import { createAdmin } from '../src/app.js';
import { queueStore } from '../src/db.js';
import { accountStore } from '../src/accounts.js';
import { seal, csrfToken, SESSION } from '../src/auth.js';

const SECRET = 'q'.repeat(40);
const ADMIN = 'https://admin.freemeans.com';
const NOW = new Date('2026-11-14T10:00:00Z');
const LIMIT = 50;
const MARGIN = 40; // stay well under the limit
const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
const ollama = JSON.parse(read('data/tools/ollama.json'));

async function setup() {
  const pg = new PGlite();
  await migrate(pg);
  let calls = 0;
  const q = (t, p) => { calls++; return pg.query(t, p); };
  const files = new Map([['data/catalog/eligibility.json', read('data/catalog/eligibility.json')], ['data/catalog/learning.json', read('data/catalog/learning.json')]]);
  const github = () => ({
    user: async () => ({ login: 'x' }),
    fileExists: async () => { calls++; return false; },
    createFile: async () => { calls++; return { commitUrl: 'https://github.com/x/y/commit/1' }; },
    readFile: async (path) => { calls++; return files.has(path) ? { text: files.get(path), sha: 's' } : null; },
    listDir: async () => { calls++; return ['a.json']; },
  });
  const app = createAdmin({
    store: queueStore(q), accounts: accountStore(q), sessionSecret: SECRET, adminUrl: ADMIN, allowedUsers: [], now: () => NOW, github,
    oauth: { authorizeUrl: () => '', exchange: async () => '' },
    siteTools: async () => { calls++; return []; },
  });
  const u = (await pg.query(`INSERT INTO admin_users (github_login, role) VALUES ('own', 'owner') RETURNING id`)).rows[0];
  const sid = crypto.randomUUID();
  await pg.query(`INSERT INTO admin_sessions (id, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [sid, u.id]);
  const csrf = await csrfToken(SECRET, sid);
  const cookie = `${SESSION}=${encodeURIComponent(await seal(SECRET, { sid, token: 't', exp: NOW.getTime() + 3_600_000 }))}`;
  const counted = async (fn) => { calls = 0; const res = await fn(); return { res, calls }; };
  return {
    pg,
    get: (path) => counted(() => app(new Request(`${ADMIN}${path}`, { headers: { cookie } }))),
    post: (path, pairs) => counted(() => app(new Request(`${ADMIN}${path}`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded', origin: ADMIN }, body: new URLSearchParams([['_csrf', csrf], ...pairs]).toString() }))),
  };
}

const addCandidates = (pg, n, withDraft) => Promise.all(Array.from({ length: n }, async (_, i) => {
  const slug = `tool-${i}`;
  const draft = withDraft ? { ...structuredClone(ollama), slug, name: `Tool ${i}`, url: `https://tool${i}.example.ai/`, signals: { ...ollama.signals, github_repo: null, hn_domain: `tool${i}.example.ai` }, open_source: false, repo_url: null, license: null,
    free_tier: { ...ollama.free_tier, type: 'credits', quota: { value: 100, unit: 'requests', period: 'month' }, source_url: `https://tool${i}.example.ai/pricing`, verified_at: '2026-11-14' }, alternatives: [], listed_at: '2026-11-14', changelog: [{ date: '2026-11-14', field: 'listed', note: 'Listed in the directory' }] } : null;
  return (await pg.query(`INSERT INTO tool_candidates (url, domain, source, name, status, draft) VALUES ($1,$2,'hn',$3,'drafted',$4) RETURNING id`,
    [`https://tool${i}.example.ai`, `tool${i}.example.ai`, `Tool ${i}`, draft ? JSON.stringify(draft) : null])).rows[0].id;
}));

test('bulk reject of 50 tools makes a handful of subrequests, not 150', async () => {
  const { pg, post } = await setup();
  const ids = await addCandidates(pg, 50, false);
  const { res, calls } = await post('/queue/bulk', [['action', 'reject'], ['reason', 'parked'], ...ids.map((id) => ['id', String(id)])]);
  assert.match(await res.text(), /Rejected 50\./);
  assert.ok(calls < 15, `used ${calls} subrequests`);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM tool_candidates WHERE status = 'rejected'`)).rows[0].n, 50);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM admin_audit WHERE action = 'queue.reject'`)).rows[0].n, 50, 'still one audit row per tool');
});

test('bulk approve of 10 drafts stays under the limit and still records every result', async () => {
  const { pg, post } = await setup();
  const ids = await addCandidates(pg, 10, true);
  const { res, calls } = await post('/queue/bulk', [['action', 'approve'], ['confirm', '1'], ...ids.map((id) => ['id', String(id)])]);
  assert.match(await res.text(), /Published 10:/);
  assert.ok(calls < MARGIN, `used ${calls} subrequests (limit ${LIMIT})`);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM tool_candidates WHERE status = 'approved' AND published_slug LIKE 'tool-%'`)).rows[0].n, 10);
  const audit = (await pg.query(`SELECT detail FROM admin_audit WHERE action = 'queue.approve'`)).rows;
  assert.equal(audit.length, 10);
  assert.ok(audit.every((r) => r.detail.bulk === true && r.detail.slug.startsWith('tool-')));
});

test('every page of the console stays well under the subrequest limit', async () => {
  const { pg, get } = await setup();
  await addCandidates(pg, 60, false);
  await pg.query(`INSERT INTO job_runs (job, ok) VALUES ('crawler', true)`);
  for (const path of ['/', '/queue', '/queue?status=done&q=tool', '/tools', '/offers', '/offers?show=recheck', '/users', '/audit', '/waitlist', '/analytics', '/health', '/controls', '/settings', '/account']) {
    const { res, calls } = await get(path);
    assert.equal(res.status, 200, path);
    assert.ok(calls < MARGIN, `${path} used ${calls} subrequests (limit ${LIMIT})`);
  }
});
