// Phase 4 of the admin dashboard: analytics, health, settings and controls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../db/scripts/lib.mjs';
import { createAdmin } from '../src/app.js';
import { queueStore } from '../src/db.js';
import { accountStore } from '../src/accounts.js';
import { seal, csrfToken, SESSION } from '../src/auth.js';
import { parseSetting, resolve } from '../src/settings.js';

const SECRET = 'w'.repeat(40);
const ADMIN = 'https://admin.freemeans.com';
const NOW = new Date('2026-11-14T10:00:00Z');
const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: ADMIN };

async function setup({ hook = true, hookFails = false } = {}) {
  const pg = new PGlite();
  await migrate(pg);
  const q = (t, p) => pg.query(t, p);
  const calls = { rebuild: 0, dispatched: [] };
  let ghLogin = 'owner1';
  const github = () => ({
    user: async () => ({ login: ghLogin }),
    listDir: async () => ['crawler.yml', 'ci.yml', 'README.md'],
    dispatchWorkflow: async (file) => { if (file === 'ci.yml') throw new Error('GitHub: Workflow does not have workflow_dispatch trigger'); calls.dispatched.push(file); return true; },
  });
  const app = createAdmin({
    store: queueStore(q), accounts: accountStore(q), sessionSecret: SECRET, adminUrl: ADMIN, allowedUsers: ['owner1'], now: () => NOW, github,
    oauth: { authorizeUrl: (state) => `https://github.com/login?state=${state}`, exchange: async () => 'tok' },
    siteTools: async () => [{ slug: 'old-tool', name: 'Old Tool', url: 'https://old.ai', verified_at: '2026-10-01' }],
    rebuild: hook ? async () => { calls.rebuild++; if (hookFails) throw new Error('the deploy hook answered 500'); } : null,
  });
  async function actor(login, role) {
    const u = (await pg.query('INSERT INTO admin_users (github_login, role) VALUES ($1,$2) RETURNING id', [login, role])).rows[0];
    const sid = crypto.randomUUID();
    await pg.query(`INSERT INTO admin_sessions (id, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [sid, u.id]);
    const csrf = await csrfToken(SECRET, sid);
    const cookie = `${SESSION}=${encodeURIComponent(await seal(SECRET, { sid, token: 't', exp: NOW.getTime() + 3_600_000 }))}`;
    return {
      get: (path) => app(new Request(`${ADMIN}${path}`, { headers: { cookie } })),
      post: (path, fields = {}) => app(new Request(`${ADMIN}${path}`, { method: 'POST', headers: { cookie, ...FORM }, body: new URLSearchParams({ _csrf: csrf, ...fields }).toString() })),
    };
  }
  const signIn = async (login, ip = '1.2.3.4') => {
    ghLogin = login;
    const first = await app(new Request(`${ADMIN}/login`));
    const state = new URL(first.headers.get('location')).searchParams.get('state');
    return app(new Request(`${ADMIN}/callback?code=c&state=${state}`, { headers: { cookie: first.headers.get('set-cookie').split(';')[0], 'cf-connecting-ip': ip } }));
  };
  const audit = async (action) => (await pg.query('SELECT * FROM admin_audit WHERE action = $1 ORDER BY id', [action])).rows;
  return { pg, actor, signIn, audit, calls };
}

test('settings: values are validated against bounds and fall back to defaults', () => {
  assert.deepEqual(parseSetting('stale_days', '45'), { ok: true, value: 45 });
  for (const bad of ['6', '181', 'abc', '', '4.5', '-3', '1e2']) assert.equal(parseSetting('stale_days', bad).ok, false, bad);
  assert.equal(parseSetting('nope', '1').ok, false);
  assert.deepEqual(resolve({ stale_days: 999, session_hours: 12, junk: 1 }), { stale_days: 30, session_hours: 12, max_failed_logins: 10 });
});

test('role matrix for the phase 4 pages', async () => {
  const { actor } = await setup();
  const want = {
    viewer: { '/analytics': 200, '/analytics.csv': 200, '/health': 403, '/controls': 403, '/settings': 403 },
    editor: { '/analytics': 200, '/analytics.csv': 200, '/health': 403, '/controls': 403, '/settings': 403 },
    admin: { '/analytics': 200, '/analytics.csv': 200, '/health': 200, '/controls': 200, '/settings': 200 },
    owner: { '/analytics': 200, '/analytics.csv': 200, '/health': 200, '/controls': 200, '/settings': 200 },
  };
  for (const [role, paths] of Object.entries(want)) {
    const a = await actor(`u-${role}`, role);
    for (const [path, status] of Object.entries(paths)) assert.equal((await a.get(path)).status, status, `${role} ${path}`);
  }
  const adm = await actor('adm2', 'admin');
  assert.equal((await adm.post('/settings', { stale_days: '40', session_hours: '8', max_failed_logins: '10' })).status, 403, 'admins cannot change settings');
  assert.equal((await adm.post('/controls/cleanup', { confirm: 'CLEANUP' })).status, 403, 'admins cannot use the danger zone');
  assert.doesNotMatch(await (await adm.get('/controls')).text(), /Danger zone/);
  assert.match(await (await adm.get('/settings')).text(), /Only owners can change settings/);
});

test('analytics: totals, top tools, countries, date range, CSV and bad ranges', async () => {
  const { actor, pg } = await setup();
  await pg.query(`INSERT INTO tool_clicks_daily (slug, day, country, clicks) VALUES
    ('alpha','2026-11-10','PK',5), ('alpha','2026-11-11','US',3), ('beta','2026-11-11','PK',2), ('beta','2026-09-01','PK',50)`);
  const v = await actor('v', 'viewer');
  const page = await (await v.get('/analytics?from=2026-11-01&to=2026-11-14')).text();
  assert.match(page, /<b>10<\/b><span>outbound clicks/);
  assert.match(page, /<b>2<\/b><span>tools clicked/);
  assert.ok(page.indexOf('>alpha<') < page.indexOf('>beta<'), 'top tools are ordered by clicks');
  assert.match(page, /<td>PK<\/td>[^]*?<td>7<\/td>/);
  assert.doesNotMatch(await (await v.get('/analytics?from=2026-11-01&to=2026-11-14')).text(), /class="msg bad"/);
  for (const q of ['from=2026-11-20&to=2026-11-01', 'from=nonsense&to=2026-11-01', 'from=2024-01-01&to=2026-11-14']) {
    assert.match(await (await v.get(`/analytics?${q}`)).text(), /class="msg bad"/, q);
  }
  const csv = await v.get('/analytics.csv?from=2026-11-01&to=2026-11-14');
  assert.match(csv.headers.get('content-disposition'), /freemeans-clicks-2026-11-01-to-2026-11-14\.csv/);
  assert.equal(await csv.text(), 'day,slug,country,clicks\r\n2026-11-10,alpha,PK,5\r\n2026-11-11,alpha,US,3\r\n2026-11-11,beta,PK,2\r\n');
});

test('health: database size, table counts, recent runs and failures', async () => {
  const { actor, pg } = await setup();
  await pg.query(`INSERT INTO job_runs (job, started_at, ended_at, ok, stats) VALUES ('crawler', now() - interval '1 hour', now() - interval '59 minutes', false, '{"drafted": 3}'), ('signals', now(), now(), true, '{}')`);
  const adm = await actor('adm', 'admin');
  const page = await (await adm.get('/health')).text();
  assert.match(page, /of the 1 GB database used \(\d+\.\d MB\)/);
  assert.match(page, /<b>1<\/b><span>failed runs/);
  assert.match(page, /crawler<\/td>[^]*?60 s[^]*?<span class="bad">not OK/);
  assert.match(page, /tool_candidates<\/td><td>0 rows/);
  assert.match(page, /github\.com\/mcwm04\/freemeans\/actions/);
});

test('settings: owner changes are validated, saved, audited with before and after, and take effect', async () => {
  const { actor, audit, pg } = await setup();
  const owner = await actor('own', 'owner');
  const bad = await (await owner.post('/settings', { stale_days: '3', session_hours: '8', max_failed_logins: '10' })).text();
  assert.match(bad, /whole number from 7 to 180/);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM admin_settings')).rows[0].n, 0, 'nothing stored on error');
  assert.match(await (await owner.get('/')).text(), /<b>1<\/b><span>free tiers not checked/, 'default 30 days: the 44 day old tool is stale');
  assert.match(await (await owner.post('/settings', { stale_days: '60', session_hours: '8', max_failed_logins: '10' })).text(), /Settings saved/);
  assert.match(await (await owner.get('/')).text(), /<b>0<\/b><span>free tiers not checked/, '60 days: no longer stale');
  assert.deepEqual((await audit('settings.update'))[0].detail, { stale_days: { before: 30, after: 60 } });
  assert.match(await (await owner.post('/settings', { stale_days: '60', session_hours: '8', max_failed_logins: '10' })).text(), /Nothing changed/);
  assert.equal((await audit('settings.update')).length, 1);
});

test('settings are used: sign-in length and the failed-login lock-out', async () => {
  const { actor, signIn } = await setup();
  const owner = await actor('own', 'owner');
  await owner.post('/settings', { stale_days: '30', session_hours: '2', max_failed_logins: '3' });
  const ok = await signIn('owner1');
  assert.match(ok.headers.get('set-cookie'), /Max-Age=7200/);
  for (let i = 0; i < 3; i++) assert.equal((await signIn('stranger', '7.7.7.7')).status, 403);
  assert.equal((await signIn('owner1', '7.7.7.7')).status, 429);
});

test('controls: rebuild runs once, is audited, rate limited, and reports a failing hook', async () => {
  const { actor, audit, calls } = await setup();
  const adm = await actor('adm', 'admin');
  assert.match(await (await adm.post('/controls/rebuild')).text(), /Rebuild started/);
  assert.equal(calls.rebuild, 1);
  assert.match(await (await adm.post('/controls/rebuild')).text(), /less than 2 minutes ago/);
  assert.equal(calls.rebuild, 1);
  assert.equal((await audit('control.rebuild')).length, 1);
  const ed = await actor('ed', 'editor');
  assert.equal((await ed.post('/controls/rebuild')).status, 403);

  const broken = await setup({ hookFails: true });
  const b = await broken.actor('adm', 'admin');
  assert.match(await (await b.post('/controls/rebuild')).text(), /did not start: the deploy hook answered 500/);
  assert.equal((await broken.audit('control.rebuild')).length, 0, 'a failed start is not recorded as a rebuild');

  const none = await setup({ hook: false });
  const n = await none.actor('adm', 'admin');
  assert.match(await (await n.get('/controls')).text(), /DEPLOY_HOOK_URL/);
  assert.match(await (await n.post('/controls/rebuild')).text(), /deploy hook is not set up/);
});

test('controls: workflows come from the repo list, run once a minute, and errors are shown', async () => {
  const { actor, audit, calls } = await setup();
  const adm = await actor('adm', 'admin');
  const page = await (await adm.get('/controls')).text();
  assert.match(page, /<code>crawler\.yml<\/code>/);
  assert.doesNotMatch(page, /README\.md/);
  assert.match(await (await adm.post('/controls/workflow', { file: 'crawler.yml' })).text(), /Started <code>crawler\.yml<\/code>/);
  assert.match(await (await adm.post('/controls/workflow', { file: 'crawler.yml' })).text(), /less than a minute ago/);
  assert.match(await (await adm.post('/controls/workflow', { file: '../../evil.yml' })).text(), /Unknown workflow/);
  assert.match(await (await adm.post('/controls/workflow', { file: 'ci.yml' })).text(), /Could not start ci\.yml: GitHub: Workflow does not have workflow_dispatch/);
  assert.deepEqual(calls.dispatched, ['crawler.yml']);
  assert.equal((await audit('control.workflow')).length, 1);
});

test('controls: cleanup needs the typed word, removes only old sessions and failures, never the audit log', async () => {
  const { actor, pg, audit } = await setup();
  const owner = await actor('own', 'owner');
  const old = (await pg.query(`SELECT id FROM admin_users LIMIT 1`)).rows[0].id;
  await pg.query(`INSERT INTO admin_sessions (id, user_id, expires_at, revoked_at) VALUES ($1,$2, now() - interval '40 days', now() - interval '40 days')`, [crypto.randomUUID(), old]);
  await pg.query(`INSERT INTO admin_login_failures (ip, at) VALUES ('1.1.1.1', now() - interval '10 days'), ('1.1.1.1', now())`);
  await owner.post('/users/invite', { login: 'someone', role: 'viewer' });
  const auditBefore = (await pg.query('SELECT count(*)::int AS n FROM admin_audit')).rows[0].n;
  assert.match(await (await owner.post('/controls/cleanup', { confirm: 'cleanup' })).text(), /Type CLEANUP exactly/);
  assert.match(await (await owner.post('/controls/cleanup', { confirm: 'CLEANUP' })).text(), /Removed 1 old sessions and 1 old sign-in failures/);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM admin_login_failures')).rows[0].n, 1);
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM admin_sessions')).rows[0].n, 1, 'the live session stays');
  assert.equal((await pg.query('SELECT count(*)::int AS n FROM admin_audit')).rows[0].n, auditBefore + 1, 'only the cleanup itself was added');
  assert.deepEqual((await audit('control.cleanup'))[0].detail, { sessions: 1, failures: 1 });
});
