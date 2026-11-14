// Phase 3 of the admin dashboard: directory tools, eligibility offers, waitlist and reviewer notes.
// Real Postgres (PGlite + all migrations); GitHub is an in-memory fake holding copies of the real data files.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../../../db/scripts/lib.mjs';
import { createAdmin } from '../src/app.js';
import { queueStore } from '../src/db.js';
import { accountStore } from '../src/accounts.js';
import { seal, csrfToken, SESSION } from '../src/auth.js';
import { checkOffer, offerFlags } from '../src/offers.js';

const SECRET = 'z'.repeat(40);
const ADMIN = 'https://admin.freemeans.com';
const NOW = new Date('2026-11-14T10:00:00Z');
const FORM = { 'content-type': 'application/x-www-form-urlencoded', origin: ADMIN };
const read = (rel) => readFileSync(new URL(`../../../${rel}`, import.meta.url), 'utf8');
const pretty = (v) => JSON.stringify(v, null, 2);

async function setup() {
  const pg = new PGlite();
  await migrate(pg);
  const q = (t, p) => pg.query(t, p);
  const files = new Map([
    ['data/tools/ollama.json', read('data/tools/ollama.json')],
    ['data/tools/comfyui.json', read('data/tools/comfyui.json')],
    ['data/catalog/eligibility.json', read('data/catalog/eligibility.json')],
    ['data/catalog/learning.json', read('data/catalog/learning.json')],
  ].map(([k, v]) => [k, { text: v.replace(/\r\n/g, '\n'), version: 1 }]));
  const commits = [];
  const sha = (f) => `sha-${f.version}`;
  const github = () => ({
    user: async () => ({ login: 'x' }),
    listDir: async (dir) => [...files.keys()].filter((k) => k.startsWith(`${dir}/`)).map((k) => k.slice(dir.length + 1)),
    readFile: async (path) => (files.has(path) ? { text: files.get(path).text, sha: sha(files.get(path)) } : null),
    updateFile: async (path, content, message, given) => {
      const f = files.get(path);
      if (given !== sha(f)) throw new Error('This file changed on GitHub after you opened it. Reload the page and apply your edit again.');
      f.text = content; f.version++;
      commits.push({ path, content, message });
      return { commitUrl: 'https://github.com/x/y/commit/9', sha: sha(f) };
    },
  });
  const app = createAdmin({
    store: queueStore(q), accounts: accountStore(q), sessionSecret: SECRET, adminUrl: ADMIN, allowedUsers: [], now: () => NOW, github,
    oauth: { authorizeUrl: () => '', exchange: async () => '' },
    siteTools: async () => [{ slug: 'ollama', name: 'Ollama', url: 'https://ollama.com', verified_at: '2026-11-01' }],
  });
  async function actor(login, role) {
    const u = (await pg.query('INSERT INTO admin_users (github_login, role) VALUES ($1,$2) RETURNING id', [login, role])).rows[0];
    const sid = crypto.randomUUID();
    await pg.query(`INSERT INTO admin_sessions (id, user_id, expires_at) VALUES ($1,$2, now() + interval '1 hour')`, [sid, u.id]);
    const csrf = await csrfToken(SECRET, sid);
    const cookie = `${SESSION}=${encodeURIComponent(await seal(SECRET, { sid, token: 't', exp: NOW.getTime() + 3_600_000 }))}`;
    return {
      csrf,
      get: (path) => app(new Request(`${ADMIN}${path}`, { headers: { cookie } })),
      post: (path, fields = {}) => app(new Request(`${ADMIN}${path}`, { method: 'POST', headers: { cookie, ...FORM }, body: new URLSearchParams({ _csrf: csrf, ...fields }).toString() })),
    };
  }
  const audit = async (action) => (await pg.query('SELECT * FROM admin_audit WHERE action = $1 ORDER BY id', [action])).rows;
  const shaOf = (path) => sha(files.get(path));
  return { pg, files, commits, actor, audit, shaOf };
}

const ollama = JSON.parse(read('data/tools/ollama.json'));

test('every real offer record passes the console checks, and the files round-trip byte for byte', () => {
  for (const f of ['eligibility', 'learning']) {
    const raw = read(`data/catalog/${f}.json`).replace(/\r\n/g, '\n');
    const data = JSON.parse(raw);
    assert.equal(pretty(data) + '\n', raw, `${f}.json keeps its formatting`);
    for (const r of data.resources) assert.deepEqual(checkOffer(r, { today: '2026-11-14' }), [], r.id);
  }
});

test('offer rules: auto-renew badge, paid certificate, ended-only replaced_by, ids, watch urls', () => {
  const rec = JSON.parse(read('data/catalog/eligibility.json')).resources[0];
  const bad = (over, re) => assert.match(checkOffer({ ...rec, ...over }, { today: '2026-11-14' }).join('|'), re);
  bad({ offer_window: { after: { auto_renews: true } } }, /needs the auto_renews_paid badge/);
  bad({ badges: [{ type: 'auto_renews_paid', source_url: 'https://x.com' }] }, /needs offer_window\.after\.auto_renews = true/);
  bad({ replaced_by: 'a.b' }, /only for ended offers/);
  bad({ watch: [{ text: 'x', source_url: 'https://nowhere.example' }] }, /not in sources/);
  bad({ last_verified: '2027-01-01' }, /in the future/);
  assert.match(checkOffer(rec, { otherIds: [rec.id] }).join('|'), /already used/);
  assert.ok(checkOffer({ ...rec, kind: 'nonsense' }).length > 0, 'schema errors are reported');
});

test('offer flags: re-check after 30 days, ending soon, past redeem date, unverified, ended', () => {
  const t = '2026-11-14';
  assert.deepEqual(offerFlags({ last_verified: '2026-11-10' }, t), []);
  assert.deepEqual(offerFlags({ last_verified: '2026-09-01' }, t), ['re-check']);
  assert.deepEqual(offerFlags({ last_verified: t, offer_window: { redeem_by: '2026-12-01' } }, t), ['ends in 17 days']);
  assert.deepEqual(offerFlags({ last_verified: t, offer_window: { redeem_by: '2026-11-01' } }, t), ['past redeem date']);
  assert.deepEqual(offerFlags({ last_verified: '2020-01-01', status: 'ended' }, t), ['ended']);
  assert.ok(offerFlags({ last_verified: t, status: 'unverified' }, t).includes('unverified'));
});

test('tools: list, edit, save as a commit with a diff summary in the audit log', async () => {
  const { actor, commits, audit, shaOf } = await setup();
  const ed = await actor('ed', 'editor');
  const list = await (await ed.get('/tools')).text();
  assert.match(list, /Ollama<\/a><br><small>ollama/);
  assert.match(list, /hidden or removed/, 'a tool missing from the live site is labelled');
  const page = await (await ed.get('/tools/ollama')).text();
  assert.match(page, /Save to GitHub/);
  const edited = { ...ollama, tagline: 'Run open models on your own computer' };
  const res = await ed.post('/tools/ollama', { action: 'save', sha: shaOf('data/tools/ollama.json'), json: JSON.stringify(edited) });
  assert.match(await res.text(), /Saved/);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].path, 'data/tools/ollama.json');
  assert.deepEqual(JSON.parse(commits[0].content).tagline, edited.tagline);
  assert.match(commits[0].message, /^Update tool: Ollama\n\nEdited in the editor console by @ed/);
  const row = (await audit('tool.update'))[0];
  assert.deepEqual(row.detail.changed, ['tagline']);
});

test('tools: invalid edits, stale versions and renames are refused and nothing is committed', async () => {
  const { actor, commits, shaOf } = await setup();
  const ed = await actor('ed', 'editor');
  const sha = shaOf('data/tools/ollama.json');
  const send = (over, extra = {}) => ed.post('/tools/ollama', { action: 'save', sha, json: JSON.stringify({ ...ollama, ...over }), ...extra });
  assert.match(await (await send({ tagline: 'The best way to run models locally' })).text(), /marketing word &quot;best&quot;/);
  assert.match(await (await send({ slug: 'renamed' })).text(), /must stay &quot;ollama&quot;/);
  assert.match(await (await send({}, { json: '{ nope' })).text(), /not valid JSON/);
  assert.match(await (await send({}, { sha: 'old-sha' })).text(), /changed on GitHub after you opened it/);
  assert.equal(commits.length, 0);
  assert.equal((await (await ed.get('/tools/not-a-tool')).text()).includes('does not exist'), true);
  assert.equal((await ed.get('/tools/..%2Fetc')).status, 404);
});

test('tools: hide and publish change only the status and add a changelog line', async () => {
  const { actor, commits, audit, shaOf } = await setup();
  const ed = await actor('ed', 'editor');
  assert.match(await (await ed.post('/tools/ollama', { action: 'status:hidden', sha: shaOf('data/tools/ollama.json'), json: '' })).text(), /Saved/);
  const saved = JSON.parse(commits[0].content);
  assert.equal(saved.status, 'hidden');
  assert.deepEqual(saved.changelog.at(-1), { date: '2026-11-14', field: 'status', note: 'Status changed from published to hidden' });
  assert.equal(commits[0].message.split('\n')[0], 'Update tool: Ollama (published to hidden)');
  const row = (await audit('tool.status'))[0];
  assert.deepEqual([row.detail.before, row.detail.after], ['published', 'hidden']);
  assert.match(await (await ed.post('/tools/ollama', { action: 'status:nonsense', sha: shaOf('data/tools/ollama.json'), json: '' })).text(), /Unknown status/);
});

test('offers: list with flags, filter, edit one record and leave the rest of the file untouched', async () => {
  const { actor, commits, files, audit, shaOf } = await setup();
  const ed = await actor('ed', 'editor');
  const seeded = JSON.parse(files.get('data/catalog/eligibility.json').text);
  seeded.resources[1].last_verified = '2026-08-01'; // long ago, so it is flagged
  files.get('data/catalog/eligibility.json').text = `${pretty(seeded)}\n`;
  const all = await (await ed.get('/offers')).text();
  const original = JSON.parse(files.get('data/catalog/eligibility.json').text);
  assert.match(all, /github\.copilot-student/);
  assert.match(all, /re-check/, 'offers last verified long ago are flagged');
  const recheck = await (await ed.get('/offers?show=recheck')).text();
  const count = (b) => (b.match(/href="\/offers\//g) || []).length;
  assert.ok(count(recheck) >= 1 && count(recheck) < count(all), 'the filter narrows the list');
  assert.ok(recheck.includes(`href="/offers/${seeded.resources[1].id}"`));

  const rec = original.resources[0];
  const edited = { ...rec, name: `${rec.name} (updated)` };
  const res = await ed.post(`/offers/${rec.id}`, { action: 'save', sha: shaOf('data/catalog/eligibility.json'), json: JSON.stringify(edited) });
  assert.match(await res.text(), /Saved/);
  const after = JSON.parse(commits[0].content);
  assert.equal(after.resources[0].name, edited.name);
  assert.deepEqual(after.resources.slice(1), original.resources.slice(1), 'other records are untouched');
  assert.equal(commits[0].content.endsWith('}\n'), true);
  assert.deepEqual((await audit('offer.update'))[0].detail.changed, ['name']);
});

test('offers: re-check needs the confirm box, then sets last_verified to today', async () => {
  const { actor, commits, audit, shaOf, files } = await setup();
  const ed = await actor('ed', 'editor');
  const id = JSON.parse(files.get('data/catalog/eligibility.json').text).resources[0].id;
  const sha = shaOf('data/catalog/eligibility.json');
  assert.match(await (await ed.post(`/offers/${id}`, { action: 'verified', sha, json: '' })).text(), /Tick the box/);
  assert.equal(commits.length, 0);
  assert.match(await (await ed.post(`/offers/${id}`, { action: 'verified', sha, confirm: '1', json: '' })).text(), /Saved/);
  assert.equal(JSON.parse(commits[0].content).resources[0].last_verified, '2026-11-14');
  assert.equal((await audit('offer.verified')).length, 1);
});

test('offers: honest-offer rules are enforced when saving, ids cannot change, stale versions are refused', async () => {
  const { actor, commits, files, shaOf } = await setup();
  const ed = await actor('ed', 'editor');
  const rec = JSON.parse(files.get('data/catalog/eligibility.json').text).resources[0];
  const sha = shaOf('data/catalog/eligibility.json');
  const send = (over, extra = {}) => ed.post(`/offers/${rec.id}`, { action: 'save', sha, json: JSON.stringify({ ...rec, ...over }), ...extra });
  assert.match(await (await send({ offer_window: { after: { auto_renews: true } } })).text(), /needs the auto_renews_paid badge/);
  assert.match(await (await send({ id: 'other.thing' })).text(), /must stay/);
  assert.match(await (await send({}, { sha: 'stale' })).text(), /changed on GitHub after you opened it/);
  assert.equal(commits.length, 0);
});

test('viewers read tools and offers but cannot change them; editors cannot see the waitlist', async () => {
  const { actor, commits, files, shaOf } = await setup();
  const v = await actor('v', 'viewer');
  const ed = await actor('ed', 'editor');
  const adm = await actor('adm', 'admin');
  assert.equal((await v.get('/tools')).status, 200);
  assert.equal((await v.get('/tools/ollama')).status, 200);
  assert.match(await (await v.get('/tools/ollama')).text(), /readonly/);
  assert.equal((await v.post('/tools/ollama', { action: 'save', sha: shaOf('data/tools/ollama.json'), json: JSON.stringify(ollama) })).status, 403);
  const id = JSON.parse(files.get('data/catalog/eligibility.json').text).resources[0].id;
  assert.equal((await v.post(`/offers/${id}`, { action: 'verified', confirm: '1' })).status, 403);
  assert.equal(commits.length, 0);
  for (const [who, want] of [[v, 403], [ed, 403], [adm, 200]]) {
    assert.equal((await who.get('/waitlist')).status, want);
    assert.equal((await who.get('/waitlist.csv')).status, want);
  }
});

test('waitlist: counts, masked emails on the page, audited CSV export with formula protection', async () => {
  const { actor, pg, audit } = await setup();
  await pg.query(`INSERT INTO waitlist (email, source, country, consent_at) VALUES
    ('alice@example.com','home','PK', now()), ('bob@example.com','/free-for/students/','PK', now()), ('=cmd@evil.test','home','US', now())`);
  const adm = await actor('adm', 'admin');
  const page = await (await adm.get('/waitlist')).text();
  assert.match(page, /<b>3<\/b><span>total sign-ups/);
  assert.match(page, /a•••@example\.com/);
  assert.doesNotMatch(page, /alice@example\.com/, 'full emails are not on the page');
  const csv = await adm.get('/waitlist.csv');
  assert.match(csv.headers.get('content-type'), /^text\/csv/);
  assert.match(csv.headers.get('content-disposition'), /attachment; filename="freemeans-waitlist-2026-11-14\.csv"/);
  const body = await csv.text();
  assert.match(body, /^email,source,country,consent_at,created_at\r\n/);
  assert.match(body, /alice@example\.com,home,PK,/);
  assert.match(body, /'=cmd@evil\.test/, 'cells that start with = are neutralised');
  assert.equal((await audit('waitlist.export'))[0].detail.rows, 3);
});

test('reviewer notes: editors save them, viewers only read them, and the note shows on the review page', async () => {
  const { actor, pg, audit } = await setup();
  const id = (await pg.query(`INSERT INTO tool_candidates (url, domain, source, status) VALUES ('https://a.ai','a.ai','hn','drafted') RETURNING id`)).rows[0].id;
  const ed = await actor('ed', 'editor');
  const v = await actor('v', 'viewer');
  assert.equal((await ed.post(`/c/${id}/note`, { note: 'Pricing page says "free" only for 7 days <b>' })).status, 303);
  assert.equal((await v.post(`/c/${id}/note`, { note: 'nope' })).status, 403);
  const page = await (await v.get(`/c/${id}`)).text();
  assert.match(page, /Pricing page says &quot;free&quot; only for 7 days &lt;b&gt;/);
  assert.doesNotMatch(page, /Save note/);
  assert.match(await (await ed.get(`/c/${id}`)).text(), /Save note/);
  assert.deepEqual((await audit('queue.note'))[0].detail, { length: 44 });
});
