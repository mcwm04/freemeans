// Phase 1 of the admin dashboard: roles, invites, sessions, CSRF, login rate limit and the audit log.
// Real Postgres (PGlite + all migrations), fake GitHub.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../db/scripts/lib.mjs';
import { createAdmin } from '../src/app.js';
import { queueStore } from '../src/db.js';
import { accountStore } from '../src/accounts.js';
import { seal, csrfToken, SESSION } from '../src/auth.js';
import { can, canManage } from '../src/permissions.js';

const SECRET = 'y'.repeat(40);
const ADMIN = 'https://admin.freemeans.com';
const NOW = new Date('2026-11-14T10:00:00Z');
const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: ADMIN };

async function setup() {
  const pg = new PGlite();
  await migrate(pg);
  const q = (t, p) => pg.query(t, p);
  let ghLogin = 'owner1';
  const commits = [];
  const app = createAdmin({
    store: queueStore(q), accounts: accountStore(q), sessionSecret: SECRET, adminUrl: ADMIN, allowedUsers: ['owner1'], now: () => NOW,
    oauth: { authorizeUrl: (state) => `https://github.com/login?state=${state}`, exchange: async () => 'tok' },
    github: () => ({ user: async () => ({ login: ghLogin }), fileExists: async () => false, createFile: async (path) => { commits.push(path); return { commitUrl: 'https://github.com/x/y/commit/1' }; } }),
    siteTools: async () => [],
  });
  const people = {};
  /** Creates a user and a live session for them, and returns request helpers acting as that user. */
  async function actor(login, role, { active = true } = {}) {
    const u = (await pg.query('INSERT INTO admin_users (github_login, role, active) VALUES ($1,$2,$3) RETURNING id', [login, role, active])).rows[0];
    const sid = crypto.randomUUID();
    await pg.query(`INSERT INTO admin_sessions (id, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [sid, u.id]);
    const csrf = await csrfToken(SECRET, sid);
    const cookie = `${SESSION}=${encodeURIComponent(await seal(SECRET, { sid, token: 't', exp: NOW.getTime() + 3_600_000 }))}`;
    const get = (path) => app(new Request(`${ADMIN}${path}`, { headers: { cookie } }));
    const post = (path, fields = {}, { token = csrf, headers = {} } = {}) =>
      app(new Request(`${ADMIN}${path}`, { method: 'POST', headers: { cookie, ...FORM, ...headers }, body: new URLSearchParams({ ...(token === null ? {} : { _csrf: token }), ...fields }).toString() }));
    const postRaw = (path, body) => app(new Request(`${ADMIN}${path}`, { method: 'POST', headers: { cookie, ...FORM }, body }));
    return (people[login] = { id: u.id, sid, csrf, get, post, postRaw });
  }
  const signIn = async (login, ip = '1.2.3.4') => {
    ghLogin = login;
    const first = await app(new Request(`${ADMIN}/login`));
    const state = new URL(first.headers.get('location')).searchParams.get('state');
    return app(new Request(`${ADMIN}/callback?code=c&state=${state}`, { headers: { cookie: first.headers.get('set-cookie').split(';')[0], 'cf-connecting-ip': ip } }));
  };
  const audit = async (action) => (await pg.query('SELECT * FROM admin_audit WHERE action = $1 ORDER BY id', [action])).rows;
  return { app, pg, actor, signIn, audit, commits };
}

test('permission matrix: each role gets exactly its rights', () => {
  const table = {
    viewer: { 'queue.view': 1, 'queue.review': 0, 'users.view': 0, 'users.manage': 0, 'audit.view': 0 },
    editor: { 'queue.view': 1, 'queue.review': 1, 'users.view': 0, 'users.manage': 0, 'audit.view': 0 },
    admin: { 'queue.view': 1, 'queue.review': 1, 'users.view': 1, 'users.manage': 1, 'audit.view': 1 },
    owner: { 'queue.view': 1, 'queue.review': 1, 'users.view': 1, 'users.manage': 1, 'audit.view': 1 },
  };
  for (const [role, perms] of Object.entries(table)) for (const [p, want] of Object.entries(perms)) assert.equal(can(role, p), !!want, `${role} ${p}`);
  assert.equal(can('owner', 'nonsense'), false);
  assert.equal(canManage('admin', 'editor', 'viewer'), true);
  assert.equal(canManage('admin', 'owner'), false, 'admins never touch owners');
  assert.equal(canManage('admin', 'viewer', 'owner'), false, 'admins never create owners');
  assert.equal(canManage('editor', 'viewer'), false);
  assert.equal(canManage('owner', 'owner', 'admin'), true);
});

test('every route is checked against every role', async () => {
  const { actor } = await setup();
  const roles = ['viewer', 'editor', 'admin', 'owner'];
  const gets = [['/', 'viewer'], ['/queue', 'viewer'], ['/account', 'viewer'], ['/users', 'admin'], ['/audit', 'admin']];
  const rank = { viewer: 1, editor: 2, admin: 3, owner: 4 };
  for (const role of roles) {
    const a = await actor(`u-${role}`, role);
    for (const [path, min] of gets) {
      assert.equal((await a.get(path)).status, rank[role] >= rank[min] ? 200 : 403, `GET ${path} as ${role}`);
    }
    const mutating = [['/users/invite', { login: 'newbie', role: 'viewer' }, 'admin'], ['/seed', { url: 'https://x.ai', name: 'X' }, 'editor']];
    for (const [path, fields, min] of mutating) {
      const res = await a.post(path, fields);
      assert.equal(res.status === 403, rank[role] < rank[min], `POST ${path} as ${role} -> ${res.status}`);
    }
  }
});

test('viewers see the queue without review buttons or the add form', async () => {
  const { actor } = await setup();
  const v = await actor('v', 'viewer');
  const body = await (await v.get('/queue')).text();
  assert.doesNotMatch(body, /Add a tool yourself/);
  assert.match(body, /Review queue/);
});

test('CSRF: a post without or with a wrong token is blocked and changes nothing', async () => {
  const { actor, pg } = await setup();
  const a = await actor('adm', 'admin');
  assert.equal((await a.post('/users/invite', { login: 'bob', role: 'viewer' }, { token: null })).status, 403);
  assert.equal((await a.post('/users/invite', { login: 'bob', role: 'viewer' }, { token: 'a'.repeat(64) })).status, 403);
  assert.equal((await pg.query(`SELECT 1 FROM admin_users WHERE github_login = 'bob'`)).rows.length, 0);
  const page = await (await a.get('/users')).text();
  assert.match(page, new RegExp(`name="_csrf" value="${a.csrf}"`), 'forms carry the token');
});

test('invites: admins invite non-owners, the invited person can then sign in, strangers cannot', async () => {
  const { actor, signIn, audit, pg } = await setup();
  const adm = await actor('adm', 'admin');
  assert.equal((await adm.post('/users/invite', { login: 'newbie', role: 'owner' })).status, 403, 'admin cannot invite an owner');
  assert.match(await (await adm.post('/users/invite', { login: 'bad name!', role: 'editor' })).text(), /Enter a GitHub username/);
  assert.match(await (await adm.post('/users/invite', { login: '@newbie', role: 'editor' })).text(), /Invited <b>@newbie<\/b>/);
  assert.match(await (await adm.post('/users/invite', { login: 'NEWBIE', role: 'editor' })).text(), /already has an account/);
  assert.equal((await audit('user.invite')).length, 1);

  assert.equal((await signIn('newbie')).status, 303);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id WHERE u.github_login = 'newbie'`)).rows[0].n, 1);
  const denied = await signIn('stranger');
  assert.equal(denied.status, 403);
  assert.doesNotMatch(await denied.text(), /stranger/, 'no echo of the login, no hint about who exists');
  assert.equal((await audit('login.denied')).length, 1);
});

test('the bootstrap list creates the first owner on first sign-in', async () => {
  const { signIn, pg, audit } = await setup();
  assert.equal((await signIn('owner1')).status, 303);
  assert.equal((await pg.query(`SELECT role FROM admin_users WHERE github_login = 'owner1'`)).rows[0].role, 'owner');
  assert.equal((await audit('user.bootstrap')).length, 1);
  assert.equal((await audit('login')).length, 1);
});

test('roles: change, protect owners, no self-change, always one active owner', async () => {
  const { actor, pg, audit } = await setup();
  const owner = await actor('own', 'owner');
  const adm = await actor('adm', 'admin');
  const ed = await actor('ed', 'editor');
  assert.match(await (await adm.post(`/users/${ed.id}/role`, { role: 'viewer' })).text(), /ed is now viewer/);
  assert.equal((await adm.post(`/users/${owner.id}/role`, { role: 'viewer' })).status, 403, 'admin cannot demote an owner');
  assert.equal((await adm.post(`/users/${ed.id}/role`, { role: 'owner' })).status, 403, 'admin cannot promote to owner');
  assert.match(await (await adm.post(`/users/${adm.id}/role`, { role: 'owner' })).text(), /cannot change your own role/);
  assert.match(await (await owner.post(`/users/${owner.id}/role`, { role: 'admin' })).text(), /cannot change your own role/);
  // Another owner may demote an owner; the "at least one owner" guard is a backstop behind the self-change rule.
  const owner2 = await actor('own2', 'owner');
  assert.match(await (await owner2.post(`/users/${owner.id}/role`, { role: 'admin' })).text(), /is now admin/);
  assert.equal((await pg.query(`SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND active`)).rows[0].n, 1);
  const rows = await audit('user.role');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0].detail, { login: 'ed', before: 'editor', after: 'viewer' });
});

test('deactivating a user ends their sessions at once', async () => {
  const { actor, audit } = await setup();
  const adm = await actor('adm', 'admin');
  const ed = await actor('ed', 'editor');
  assert.equal((await ed.get('/')).status, 200);
  assert.match(await (await adm.post(`/users/${ed.id}/deactivate`)).text(), /deactivated and signed out everywhere/);
  assert.equal((await ed.get('/')).status, 303, 'old cookie no longer works');
  assert.equal((await audit('user.deactivate')).length, 1);
  assert.match(await (await adm.post(`/users/${adm.id}/deactivate`)).text(), /cannot deactivate yourself/);
});

test('logout revokes the session on the server, so a copied cookie is dead', async () => {
  const { actor, audit, pg } = await setup();
  const a = await actor('ed', 'editor');
  assert.equal((await a.post('/logout')).status, 303);
  assert.equal((await a.get('/')).status, 303);
  assert.ok((await pg.query('SELECT revoked_at FROM admin_sessions WHERE id = $1', [a.sid])).rows[0].revoked_at);
  assert.equal((await audit('logout')).length, 1);
});

test('"sign out everywhere else" keeps this session and ends the others', async () => {
  const { actor, pg } = await setup();
  const a = await actor('ed', 'editor');
  await pg.query(`INSERT INTO admin_sessions (id, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [crypto.randomUUID(), a.id]);
  assert.match(await (await a.get('/account')).text(), /Other device/);
  assert.match(await (await a.post('/account/sign-out-others')).text(), /Signed out 1 other session\./);
  assert.equal((await a.get('/')).status, 200);
});

test('expired sessions are refused', async () => {
  const { actor, pg } = await setup();
  const a = await actor('ed', 'editor');
  await pg.query(`UPDATE admin_sessions SET expires_at = now() - interval '1 minute' WHERE id = $1`, [a.sid]);
  assert.equal((await a.get('/')).status, 303);
});

test('login rate limit: 10 failed sign-ins from one IP lock that IP out, others are fine', async () => {
  const { signIn } = await setup();
  for (let i = 0; i < 10; i++) assert.equal((await signIn('stranger', '9.9.9.9')).status, 403);
  const locked = await signIn('owner1', '9.9.9.9');
  assert.equal(locked.status, 429);
  assert.equal(locked.headers.get('retry-after'), '900');
  assert.equal((await signIn('owner1', '8.8.8.8')).status, 303);
});

test('audit log: every mutation is recorded, filtered by actor and action, and cannot be edited or deleted', async () => {
  const { actor, pg } = await setup();
  const adm = await actor('adm', 'admin');
  const ed = await actor('ed', 'editor');
  await adm.post('/users/invite', { login: 'newbie', role: 'viewer' });
  await ed.post('/seed', { url: 'https://voicekit.ai/', name: 'VoiceKit' });
  const id = (await pg.query(`SELECT id FROM tool_candidates WHERE domain = 'voicekit.ai'`)).rows[0].id;
  await ed.post(`/c/${id}/reject`, { reason: 'duplicate' });
  const actions = (await pg.query('SELECT action FROM admin_audit ORDER BY id')).rows.map((r) => r.action);
  assert.deepEqual(actions, ['user.invite', 'queue.seed', 'queue.reject']);
  const page = await (await adm.get('/audit?actor=ED&action=queue.')).text();
  assert.match(page, /queue\.seed/);
  assert.doesNotMatch(page, /user\.invite/);
  await assert.rejects(() => pg.query(`UPDATE admin_audit SET action = 'x'`), /append-only/);
  await assert.rejects(() => pg.query('DELETE FROM admin_audit'), /append-only/);
});

test('audit entries never contain tokens or cookies', async () => {
  const { actor, pg } = await setup();
  const ed = await actor('ed', 'editor');
  await ed.post('/seed', { url: 'https://voicekit.ai/', name: 'VoiceKit' });
  const all = JSON.stringify((await pg.query('SELECT * FROM admin_audit')).rows);
  assert.doesNotMatch(all, /gho_|fm_session|csrf/i);
});

// ---- phase 2: overview, filters, bulk actions ----

test('overview shows KPI numbers, clicks and the activity feed only to admins', async () => {
  const { actor, pg } = await setup();
  await pg.query(`INSERT INTO tool_clicks_daily (slug, day, country, clicks) VALUES ('a', current_date, 'PK', 5), ('a', current_date - 3, 'US', 7), ('b', current_date - 20, 'PK', 100)`);
  await pg.query(`INSERT INTO tool_candidates (url, domain, source, status) VALUES ('https://a.ai','a.ai','hn','drafted'), ('https://b.ai','b.ai','hn','needs_manual'), ('https://c.ai','c.ai','hn','approved')`);
  await pg.query(`INSERT INTO job_runs (job, ok) VALUES ('crawler', false)`);
  const adm = await actor('adm', 'admin');
  await adm.post('/users/invite', { login: 'newbie', role: 'viewer' });
  const body = await (await adm.get('/')).text();
  assert.match(body, /<b>2<\/b><span>pending reviews/);
  assert.match(body, /<b>12<\/b><span>outbound clicks, 7 days/);
  assert.match(body, /<b>112<\/b><span>outbound clicks, 30 days/);
  assert.match(body, /<b>1<\/b><span>failed jobs/);
  assert.match(body, /user\.invite/);
  const ed = await actor('ed', 'editor');
  assert.doesNotMatch(await (await ed.get('/')).text(), /Recent activity/);
});

test('queue filters by status, source and search text, and pages', async () => {
  const { actor, pg } = await setup();
  const ed = await actor('ed', 'editor');
  await pg.query(`INSERT INTO tool_candidates (url, domain, source, name, status) VALUES
    ('https://voice.ai','voice.ai','hn','VoiceKit','drafted'), ('https://img.ai','img.ai','submit','ImgGen','needs_manual'),
    ('https://old.ai','old.ai','hn','Old','approved'), ('https://p.ai','p.ai','hn','50%_off','drafted')`);
  const list = async (qs) => await (await ed.get(`/queue${qs}`)).text();
  const rowsOf = (b) => (b.match(/href="\/c\/\d+"/g) || []).length;
  assert.equal(rowsOf(await list('')), 3, 'default shows open items only');
  assert.equal(rowsOf(await list('?status=approved')), 1);
  assert.equal(rowsOf(await list('?source=submit')), 1);
  assert.equal(rowsOf(await list('?q=VOICE')), 1, 'search is case-insensitive');
  assert.equal(rowsOf(await list('?q=%25_')), 1, '% and _ in the search are literal');
  assert.equal(rowsOf(await list('?status=nonsense')), 3, 'bad status falls back');
  for (let i = 0; i < 55; i++) await pg.query(`INSERT INTO tool_candidates (url, domain, source, status) VALUES ($1,$2,'hn','new')`, [`https://x${i}.ai`, `x${i}.ai`]);
  const p1 = await list('');
  assert.equal(rowsOf(p1), 50);
  assert.match(p1, /Page 1 of 2/);
  assert.equal(rowsOf(await list('?page=2')), 8);
});

test('bulk reject closes the selected open items with a reason and one audit row each', async () => {
  const { actor, pg, audit } = await setup();
  const ed = await actor('ed', 'editor');
  const ids = [];
  for (const d of ['a.ai', 'b.ai']) ids.push((await pg.query(`INSERT INTO tool_candidates (url, domain, source, status) VALUES ($1,$2,'hn','drafted') RETURNING id`, [`https://${d}`, d])).rows[0].id);
  const approved = (await pg.query(`INSERT INTO tool_candidates (url, domain, source, status) VALUES ('https://c.ai','c.ai','hn','approved') RETURNING id`)).rows[0].id;
  const body = new URLSearchParams({ _csrf: ed.csrf, action: 'reject', reason: 'parked' });
  for (const id of [...ids, approved]) body.append('id', id);
  const raw = await ed.postRaw('/queue/bulk', body.toString());
  assert.match(await raw.text(), /Rejected 2\./);
  const { rows } = await pg.query('SELECT status, reject_reason FROM tool_candidates ORDER BY id');
  assert.deepEqual(rows.map((r) => r.status), ['rejected', 'rejected', 'approved']);
  assert.ok(rows.slice(0, 2).every((r) => r.reject_reason === 'parked'));
  assert.equal((await audit('queue.reject')).length, 2);
  const none = await ed.postRaw('/queue/bulk', new URLSearchParams({ _csrf: ed.csrf, action: 'reject', reason: 'parked' }).toString());
  assert.match(await none.text(), /Select at least one/);
});

test('viewers cannot use bulk actions', async () => {
  const { actor } = await setup();
  const v = await actor('v', 'viewer');
  const res = await v.postRaw('/queue/bulk', new URLSearchParams({ _csrf: v.csrf, action: 'reject', reason: 'parked', id: '1' }).toString());
  assert.equal(res.status, 403);
});

test('bulk approve publishes valid drafts only, needs the confirm box, and reports what it skipped', async () => {
  const { actor, pg, commits, audit } = await setup();
  const ollama = JSON.parse(readFileSync(new URL('../../../data/tools/ollama.json', import.meta.url)));
  const good = { ...structuredClone(ollama), slug: 'voicekit', name: 'VoiceKit', url: 'https://voicekit.ai/', open_source: false, repo_url: null, license: null,
    free_tier: { ...ollama.free_tier, type: 'credits', quota: { value: 10000, unit: 'characters', period: 'month' }, source_url: 'https://voicekit.ai/pricing', verified_at: '2026-11-14' },
    signals: { ...ollama.signals, github_repo: null, hn_domain: 'voicekit.ai' }, alternatives: [], listed_at: '2026-11-14',
    changelog: [{ date: '2026-11-14', field: 'listed', note: 'Listed in the directory' }] };
  const add = async (domain, draft) => (await pg.query(`INSERT INTO tool_candidates (url, domain, source, name, status, draft) VALUES ($1,$2,'hn',$3,'drafted',$4) RETURNING id`,
    [`https://${domain}`, domain, domain, draft ? JSON.stringify(draft) : null])).rows[0].id;
  const okId = await add('voicekit.ai', good);
  const badId = await add('bad.ai', { ...good, slug: 'bad', name: 'BadTool', tagline: 'The best tool ever made for you' });
  const emptyId = await add('empty.ai', null);
  const ed = await actor('ed', 'editor');
  const send = (extra) => ed.postRaw('/queue/bulk', new URLSearchParams([['_csrf', ed.csrf], ['action', 'approve'], ...extra, ...[okId, badId, emptyId].map((i) => ['id', String(i)])]).toString());
  assert.match(await (await send([])).text(), /Tick "Yes, publish"/);
  assert.equal(commits.length, 0, 'nothing published without the confirm box');
  const body = await (await send([['confirm', '1']])).text();
  assert.match(body, /Published 1: VoiceKit\. Skipped 2\./);
  assert.match(body, /BadTool: tagline/);
  assert.match(body, /empty\.ai: no draft to publish/);
  assert.deepEqual(commits, ['data/tools/voicekit.json']);
  assert.deepEqual((await pg.query('SELECT status FROM tool_candidates ORDER BY id')).rows.map((r) => r.status), ['approved', 'drafted', 'drafted']);
  const a = await audit('queue.approve');
  assert.equal(a.length, 1);
  assert.equal(a[0].detail.bulk, true);
});
