// Editor console (M6): request handling, free of Cloudflare-only imports so tests run in Node.
import { SESSION, STATE, cookie, readCookie, seal, unseal, csrfToken, safeEqual } from './auth.js';
import { githubClient } from './github.js';
import { checkTool, ordered, taxonomy } from './validate.js';
import { page, queueView, overviewView, reviewView, usersView, accountView, auditView, toolsView, toolEditView, offersView, offerEditView, waitlistView, analyticsView, healthView, settingsView, controlsView, PAGE_SIZE, h } from './views.js';
import { checkOffer, offerFlags, needsLook, OFFER_FILES } from './offers.js';
import { DEFS as SETTING_DEFS, parseSetting, resolve as resolveSettings } from './settings.js';
import { can, canManage, ROLES } from './permissions.js';
import { siteKey, parseSite } from '../../api/src/domain.js';

const REASONS = new Set(['duplicate', 'dead_site', 'out_of_scope', 'unsafe', 'parked', 'no_ai', 'other']);
const LOGIN_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i; // GitHub username rules
const FAILURE_WINDOW_MIN = 15;
const SECURITY_HEADERS = {
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-src https: http:; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'x-robots-tag': 'noindex, nofollow',
  'referrer-policy': 'same-origin',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

/**
 * store:     queueStore(query) from db.js
 * oauth:     githubOAuth(...) from auth.js
 * github:    (token) => githubClient — injectable for tests
 * siteTools: async () => [{ slug, name, verified_at }]  (published tools, from freemeans.com/tools/status.json)
 */
export function createAdmin({
  store, accounts, oauth, sessionSecret, adminUrl, allowedUsers, repo = 'mcwm04/freemeans', siteUrl = 'https://freemeans.com',
  github = (token) => githubClient(token, { repo }), siteTools = async () => [], now = () => new Date(), rebuild = null,
}) {
  const origin = new URL(adminUrl).origin;
  // allowedUsers (ALLOWED_GITHUB_USERS) is the bootstrap list: those logins become owners on first sign-in.
  const bootstrap = new Set(allowedUsers.map((u) => u.toLowerCase()));
  const ipOf = (req) => req.headers.get('cf-connecting-ip') || req.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';
  const html = (status, body, extra = {}) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...extra } });
  const redirect = (location, extra = {}) => new Response(null, { status: 303, headers: { location, ...SECURITY_HEADERS, ...extra } });
  const callback = `${origin}/callback`;

  /** The cookie carries the sign-in; the server-side row decides whether it still counts (revoked, expired, deactivated). */
  async function session(req) {
    const c = await unseal(sessionSecret, readCookie(req, SESSION), now().getTime());
    if (!c?.sid) return null;
    const row = await accounts.getSession(c.sid);
    if (!row) return null;
    return { login: row.login, role: row.role, userId: row.user_id, sid: row.sid, token: c.token, csrf: await csrfToken(sessionSecret, row.sid) };
  }

  const denied = (s, what) => html(403, page('Not allowed', s, `<h1>Not allowed</h1><p>Your role (${h(s.role)}) cannot ${h(what)}.</p><p><a href="/">Back</a></p>`));

  async function login(req) {
    const state = crypto.randomUUID();
    const sealed = await seal(sessionSecret, { state, exp: now().getTime() + 10 * 60_000 });
    return redirect(oauth.authorizeUrl(state, callback), { 'set-cookie': cookie(STATE, sealed, 600) });
  }

  async function tooMany(req) {
    return (await accounts.failuresSince(ipOf(req), FAILURE_WINDOW_MIN)) >= (await cfg()).max_failed_logins;
  }

  async function finishLogin(req, url) {
    const ip = ipOf(req);
    if (await tooMany(req)) {
      return html(429, page('Too many attempts', null, '<h1>Too many attempts</h1><p>Wait 15 minutes and try again.</p>'), { 'retry-after': String(FAILURE_WINDOW_MIN * 60) });
    }
    const saved = await unseal(sessionSecret, readCookie(req, STATE), now().getTime());
    if (!saved || !url.searchParams.get('state') || saved.state !== url.searchParams.get('state')) {
      await accounts.recordFailure(ip);
      return html(400, page('Sign-in failed', null, '<h1>Sign-in expired</h1><p><a href="/login">Try again</a>.</p>'));
    }
    const token = await oauth.exchange(url.searchParams.get('code') || '', callback);
    const gh = await github(token).user();
    let user = await accounts.findUser(gh.login);
    if (!user && bootstrap.has(String(gh.login).toLowerCase())) {
      user = await accounts.createUser({ login: gh.login, role: 'owner', invitedBy: null });
      await accounts.audit({ actor: { login: gh.login, role: 'owner' }, action: 'user.bootstrap', targetType: 'user', targetId: user?.id, ip });
    }
    // Same message for "not invited" and "deactivated" so the page does not reveal which logins exist.
    if (!user || !user.active) {
      await accounts.recordFailure(ip);
      await accounts.audit({ actor: { login: gh.login }, action: 'login.denied', detail: { reason: user ? 'deactivated' : 'not_invited' }, ip });
      return html(403, page('Not allowed', null, '<h1>Not allowed</h1><p>This GitHub account has not been invited to the Freemeans console.</p>'));
    }
    const sid = crypto.randomUUID();
    const hours = (await cfg()).session_hours;
    const expMs = now().getTime() + hours * 3_600_000;
    await accounts.createSession({ id: sid, userId: user.id, expiresAt: new Date(expMs).toISOString(), ip, userAgent: req.headers.get('user-agent') });
    await accounts.touchLogin(user.id);
    await accounts.audit({ actor: { login: user.github_login, role: user.role }, action: 'login', targetType: 'session', targetId: sid, ip });
    const sealed = await seal(sessionSecret, { sid, token, exp: expMs });
    return redirect('/', { 'set-cookie': cookie(SESSION, sealed, hours * 3600) });
  }

  const STATUS_SETS = {
    active: ['drafted', 'needs_manual', 'new'], drafted: ['drafted'], needs_manual: ['needs_manual'], new: ['new'],
    approved: ['approved'], rejected: ['rejected', 'duplicate'], done: ['approved', 'rejected', 'duplicate'],
  };
  const OPEN = new Set(STATUS_SETS.active);

  async function overview(s) {
    const [counts, jobs, tools, stats, activity] = await Promise.all([
      store.counts(), store.lastJobs(), siteTools().catch(() => []), store.overview(),
      can(s.role, 'audit.view') ? accounts.listAudit({ limit: 8 }) : [],
    ]);
    const staleDays = (await cfg()).stale_days;
    const cutoff = new Date(now().getTime() - staleDays * 86_400_000).toISOString().slice(0, 10);
    const stale = tools.filter((t) => t.verified_at && t.verified_at < cutoff).sort((a, b) => a.verified_at.localeCompare(b.verified_at));
    return html(200, page('Overview', s, overviewView({ counts, jobs, stale, stats, activity, canReview: can(s.role, 'queue.review'), canAudit: can(s.role, 'audit.view') })));
  }

  async function queue(s, notice, params = new URLSearchParams()) {
    const status = STATUS_SETS[params.get('status')] ? params.get('status') : 'active';
    const source = params.get('source')?.slice(0, 40) || null;
    const q = params.get('q')?.trim().slice(0, 80) || null;
    const pg = Math.max(parseInt(params.get('page') || '1', 10) || 1, 1);
    const [counts, found, sources] = await Promise.all([
      store.counts(), store.search({ statuses: STATUS_SETS[status], source, q, limit: PAGE_SIZE, offset: (pg - 1) * PAGE_SIZE }), store.sources(),
    ]);
    return html(200, page('Queue', s, queueView({
      counts, items: found.rows, total: found.total, page: pg, filters: { status: params.has('status') ? status : null, source, q }, sources, notice,
      canReview: can(s.role, 'queue.review'),
    })));
  }

  const MAX_BULK_REJECT = 50;
  const MAX_BULK_APPROVE = 10;

  async function bulk(req, s, ip) {
    const form = new URLSearchParams(await req.text());
    const ids = [...new Set(form.getAll('id').map(Number).filter(Number.isInteger))];
    if (!ids.length) return queue(s, { ok: false, html: 'Select at least one tool first.' });
    if (form.get('action') === 'reject') {
      const reason = form.get('reason');
      if (!REASONS.has(reason)) return queue(s, { ok: false, html: 'Pick a reason.' });
      // Two queries however many are selected: Cloudflare's free plan allows 50 subrequests per request.
      const closed = await store.rejectMany(ids.slice(0, MAX_BULK_REJECT), reason, s.login);
      if (closed.length) await accounts.auditMany({ actor: s, action: 'queue.reject', targetType: 'candidate', items: closed.map((id) => ({ id, detail: { reason, bulk: true } })), ip });
      const extra = ids.length > MAX_BULK_REJECT ? ` Only the first ${MAX_BULK_REJECT} were handled.` : '';
      return queue(s, { ok: true, html: `Rejected ${closed.length}. The crawler will not suggest those sites again.${extra}` });
    }
    if (form.get('action') !== 'approve') return queue(s, { ok: false, html: 'Unknown action.' });
    if (form.get('confirm') !== '1') return queue(s, { ok: false, html: 'Tick "Yes, publish" to approve drafts.' });
    const gh = github(s.token);
    const listedTools = await siteTools().catch(() => []);
    const published = [];
    const skipped = [];
    // One query reads every candidate and one writes every result, so the request makes about
    // 2 GitHub calls per published tool plus a fixed handful of others (free plan limit: 50).
    const wanted = ids.slice(0, MAX_BULK_APPROVE);
    const found = new Map((await store.getMany(wanted)).map((c) => [c.id, c]));
    const done = [];
    for (const id of wanted) {
      const cand = found.get(id);
      const label = cand ? (cand.draft?.name || cand.domain) : `#${id}`;
      if (!cand || !OPEN.has(cand.status) || !cand.draft) { skipped.push(`${label}: no draft to publish`); continue; }
      const tool = cand.draft;
      const errors = checkTool(tool, today());
      if (errors.length) { skipped.push(`${label}: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`); continue; }
      const path = `data/tools/${tool.slug}.json`;
      try {
        if (await gh.fileExists(path)) { skipped.push(`${label}: ${path} already exists`); continue; }
        const dup = listedTools.find((t) => t.url && siteKey(t.url) === siteKey(tool.url));
        if (dup) { skipped.push(`${label}: already listed as ${dup.name}`); continue; }
        const { commitUrl } = await gh.createFile(path, JSON.stringify(ordered(tool), null, 2) + '\n',
          `Add tool: ${tool.name}\n\nApproved in the editor console by @${s.login} (candidate ${id}, source: ${cand.source}, bulk).`);
        done.push({ id, slug: tool.slug, draft: tool, detail: { slug: tool.slug, name: tool.name, commit: commitUrl || null, bulk: true } });
        published.push(tool.name);
      } catch (e) {
        skipped.push(`${label}: ${e.message}`);
      }
    }
    if (done.length) {
      await store.approveMany(done, s.login);
      await accounts.auditMany({ actor: s, action: 'queue.approve', targetType: 'candidate', items: done.map((d) => ({ id: d.id, detail: d.detail })), ip });
    }
    const extra = ids.length > MAX_BULK_APPROVE ? ` Only the first ${MAX_BULK_APPROVE} were tried.` : '';
    return queue(s, {
      ok: published.length > 0 || skipped.length === 0,
      html: `Published ${published.length}${published.length ? `: ${published.map((n) => h(n)).join(', ')}` : ''}. Skipped ${skipped.length}.${extra}${skipped.length ? `<ul>${skipped.map((x) => `<li>${h(x)}</li>`).join('')}</ul>` : ''}`,
    });
  }

  async function review(s, id, { json, errors, notice } = {}) {
    const cand = await store.get(id);
    if (!cand) return html(404, page('Not found', s, '<h1>Not found</h1><p><a href="/">Back to the queue</a></p>'));
    const draft = ordered(cand.draft ?? starter(cand));
    const text = json ?? JSON.stringify(draft, null, 2);
    let errs = errors;
    if (!errs) {
      errs = checkTool(draft, today());
    }
    return html(200, page(cand.draft?.name || cand.domain, s, reviewView({ cand, json: text, errors: errs, notice, taxonomy, canReview: can(s.role, "queue.review") })));
  }

  const today = () => now().toISOString().slice(0, 10);

  // A blank listing for candidates the crawler could not draft, so the editor can fill it in.
  function starter(cand) {
    const t = today();
    return {
      slug: '', name: cand.name || '', url: cand.url, tagline: '', description: '',
      categories: cand.category ? [cand.category] : [], tasks: [], best_for: [], platforms: ['web'],
      open_source: false, repo_url: null, license: null,
      free_tier: { type: 'forever_free', quota: null, trial_days: null, card_required: null, signup_required: null, watermark: null,
        commercial_use: null, works_in_pk: null, notes: null, source_url: cand.url, verified_at: t },
      pricing: null,
      signals: { trends_term: cand.name || null, wikipedia_article: null, github_repo: null, hf_id: null, producthunt_slug: null,
        hn_domain: siteKey(cand.url)?.includes('/') ? null : siteKey(cand.url), hn_query: null },
      alternatives: [], status: 'published', listed_at: t,
      changelog: [{ date: t, field: 'listed', note: 'Listed in the directory' }],
      affiliate_url: null, sponsor: null, verified_vendor: false,
    };
  }

  async function act(req, s, id, ip) {
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    const cand = await store.get(id);
    if (!cand) return html(404, page('Not found', s, '<h1>Not found</h1>'));
    if (['approved', 'rejected', 'duplicate'].includes(cand.status)) return redirect(`/c/${id}`);
    let tool;
    try {
      tool = JSON.parse(form.json ?? '');
    } catch (e) {
      return review(s, id, { json: form.json, errors: [`The listing is not valid JSON: ${e.message}`] });
    }
    const errors = checkTool(tool, today());
    if (form.action === 'save') {
      await store.saveDraft(id, tool);
      await accounts.audit({ actor: s, action: 'queue.save', targetType: 'candidate', targetId: id, detail: { slug: tool.slug || null }, ip });
      return review(s, id, { json: form.json, errors, notice: { ok: true, html: 'Draft saved.' } });
    }
    if (form.action !== 'approve' || errors.length) {
      return review(s, id, { json: form.json, errors });
    }
    // Approve: one commit that adds data/tools/{slug}.json. CI runs toolcheck again; Cloudflare rebuilds the site.
    const gh = github(s.token);
    const path = `data/tools/${tool.slug}.json`;
    try {
      if (await gh.fileExists(path)) {
        return review(s, id, { json: form.json, errors: [`slug: data/tools/${tool.slug}.json already exists. Choose another slug, or reject as duplicate.`] });
      }
      const listed = (await siteTools().catch(() => [])).find((t) => t.url && siteKey(t.url) === siteKey(tool.url));
      if (listed) {
        return review(s, id, { json: form.json, errors: [`url: this site is already listed as "${listed.name}" (${listed.slug}). Reject as duplicate.`] });
      }
      const { commitUrl } = await gh.createFile(path, JSON.stringify(ordered(tool), null, 2) + '\n',
        `Add tool: ${tool.name}\n\nApproved in the editor console by @${s.login} (candidate ${id}, source: ${cand.source}).`);
      await store.approve(id, tool.slug, s.login, tool);
      await accounts.audit({ actor: s, action: 'queue.approve', targetType: 'candidate', targetId: id, detail: { slug: tool.slug, name: tool.name, commit: commitUrl || null }, ip });
      const live = `${siteUrl}/tools/${tool.slug}/`;
      return queue(s, { ok: true, html: `Published <b>${h(tool.name)}</b>. ${commitUrl ? `<a href="${h(commitUrl)}">Commit</a> · ` : ''}It appears at <a href="${h(live)}">${h(live)}</a> in about 3 minutes.` });
    } catch (e) {
      return review(s, id, { json: form.json, errors: [`Could not publish: ${e.message}`] });
    }
  }

  async function reject(req, s, id, ip) {
    const reason = new URLSearchParams(await req.text()).get('reason');
    if (!REASONS.has(reason)) return redirect(`/c/${id}`);
    await store.reject(id, reason, s.login);
    await accounts.audit({ actor: s, action: 'queue.reject', targetType: 'candidate', targetId: id, detail: { reason }, ip });
    return redirect('/queue?rejected=1');
  }

  async function seed(req, s, ip) {
    const form = new URLSearchParams(await req.text());
    const u = parseSite(form.get('url'));
    const name = String(form.get('name') || '').trim().slice(0, 80);
    if (!u || !name) return queue(s, { ok: false, html: 'Enter a public web address and a name.' });
    const id = await store.addEditorSeed({ url: u.href, domain: siteKey(u.href), name, login: s.login });
    if (id) await accounts.audit({ actor: s, action: 'queue.seed', targetType: 'candidate', targetId: id, detail: { url: u.href, name }, ip });
    return id ? redirect(`/c/${id}`) : queue(s, { ok: false, html: `${h(siteKey(u.href))} is already in the queue or was reviewed before.` });
  }

  async function usersPage(s, notice) {
    return html(200, page('Users', s, usersView({ users: await accounts.listUsers(), me: s, notice, canManage })));
  }

  async function invite(req, s, ip) {
    const form = new URLSearchParams(await req.text());
    const login = String(form.get('login') || '').trim().replace(/^@/, '');
    const role = form.get('role');
    if (!LOGIN_RE.test(login) || !ROLES.includes(role)) return usersPage(s, { ok: false, html: 'Enter a GitHub username and pick a role.' });
    if (!canManage(s.role, 'viewer', role)) return denied(s, `give the ${role} role`);
    const user = await accounts.createUser({ login, role, invitedBy: s.login });
    if (!user) return usersPage(s, { ok: false, html: `@${h(login)} already has an account.` });
    await accounts.audit({ actor: s, action: 'user.invite', targetType: 'user', targetId: user.id, detail: { login, role }, ip });
    return usersPage(s, { ok: true, html: `Invited <b>@${h(login)}</b> as ${h(role)}. They can now sign in with GitHub.` });
  }

  async function changeRole(req, s, id, ip) {
    const role = new URLSearchParams(await req.text()).get('role');
    const target = await accounts.getUser(id);
    if (!target || !ROLES.includes(role)) return usersPage(s, { ok: false, html: 'Unknown user or role.' });
    if (target.id === s.userId) return usersPage(s, { ok: false, html: 'You cannot change your own role.' });
    if (!canManage(s.role, target.role, role)) return denied(s, `change @${target.github_login} to ${role}`);
    if (target.role === 'owner' && role !== 'owner' && target.active && (await accounts.activeOwners()) <= 1) {
      return usersPage(s, { ok: false, html: 'There must always be at least one active owner.' });
    }
    if (role === target.role) return usersPage(s, null);
    await accounts.setRole(id, role);
    await accounts.audit({ actor: s, action: 'user.role', targetType: 'user', targetId: id, detail: { login: target.github_login, before: target.role, after: role }, ip });
    return usersPage(s, { ok: true, html: `@${h(target.github_login)} is now ${h(role)}.` });
  }

  async function setActive(s, id, active, ip) {
    const target = await accounts.getUser(id);
    if (!target) return usersPage(s, { ok: false, html: 'Unknown user.' });
    if (target.id === s.userId) return usersPage(s, { ok: false, html: 'You cannot deactivate yourself.' });
    if (!canManage(s.role, target.role)) return denied(s, `change @${target.github_login}`);
    if (!active && target.role === 'owner' && target.active && (await accounts.activeOwners()) <= 1) {
      return usersPage(s, { ok: false, html: 'There must always be at least one active owner.' });
    }
    await accounts.setActive(id, active);
    const ended = active ? 0 : await accounts.revokeAll(id);
    await accounts.audit({ actor: s, action: active ? 'user.activate' : 'user.deactivate', targetType: 'user', targetId: id, detail: { login: target.github_login, sessions_ended: ended }, ip });
    return usersPage(s, { ok: true, html: `@${h(target.github_login)} is ${active ? 'active again' : 'deactivated and signed out everywhere'}.` });
  }

  async function accountPage(s, notice) {
    return html(200, page('Account', s, accountView({ me: s, sessions: await accounts.listSessions(s.userId), notice })));
  }

  async function auditPage(s, url) {
    const actor = url.searchParams.get('actor')?.trim() || null;
    const action = url.searchParams.get('action')?.trim() || null;
    return html(200, page('Audit log', s, auditView({ rows: await accounts.listAudit({ actor, action }), actor, action })));
  }

  // ---- phase 3: directory tools, offers, waitlist, reviewer notes ----
  const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;
  const OFFER_ID_RE = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
  const pretty = (v) => JSON.stringify(v, null, 2);
  const changedKeys = (before, after) => [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].filter((k) => JSON.stringify(before?.[k]) !== JSON.stringify(after?.[k]));
  const notFound = (s, what) => html(404, page('Not found', s, `<h1>Not found</h1><p>${h(what)} does not exist.</p><p><a href="/">Back</a></p>`));

  async function toolsPage(s, notice) {
    const gh = github(s.token);
    const [names, listed] = await Promise.all([gh.listDir('data/tools'), siteTools().catch(() => [])]);
    const slugs = names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)).sort();
    const info = Object.fromEntries(listed.map((t) => [t.slug, t]));
    return html(200, page('Tools', s, toolsView({ slugs, info, notice })));
  }

  async function toolEdit(s, slug, { json, sha, errors, notice, file } = {}) {
    file ??= await github(s.token).readFile(`data/tools/${slug}.json`);
    if (!file) return notFound(s, `data/tools/${slug}.json`);
    let tool = null;
    try { tool = JSON.parse(file.text); } catch { /* shown as a problem below */ }
    const text = json ?? (tool ? pretty(ordered(tool)) : file.text);
    const errs = errors ?? (tool ? checkTool(tool, today()) : ['The file on GitHub is not valid JSON.']);
    return html(200, page(tool?.name || slug, s, toolEditView({ slug, tool, json: text, sha: sha ?? file.sha, errors: errs, notice, canEdit: can(s.role, 'content.edit') })));
  }

  async function toolAct(req, s, slug, ip) {
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    const gh = github(s.token);
    const path = `data/tools/${slug}.json`;
    const stored = await gh.readFile(path);
    if (!stored) return notFound(s, path);
    const again = (extra) => toolEdit(s, slug, { json: form.json, sha: form.sha, ...extra });
    if (form.sha !== stored.sha) return again({ errors: ['This file changed on GitHub after you opened it. Reload the page and apply your edit again.'] });
    const old = JSON.parse(stored.text);
    let tool;
    const action = form.action || '';
    if (action.startsWith('status:')) {
      const to = action.slice(7);
      if (!['published', 'hidden', 'removed'].includes(to)) return again({ errors: ['Unknown status.'] });
      tool = { ...old, status: to, changelog: [...(old.changelog ?? []), { date: today(), field: 'status', note: `Status changed from ${old.status} to ${to}` }] };
    } else {
      try { tool = JSON.parse(form.json ?? ''); } catch (e) { return again({ errors: [`The listing is not valid JSON: ${e.message}`] }); }
    }
    const errors = checkTool(tool, today());
    if (tool?.slug !== slug) errors.push(`slug: must stay "${slug}". To rename a tool, add a new listing and remove this one.`);
    if (action === 'check' || errors.length) return again({ json: pretty(ordered(tool)), errors });
    if (!['save'].includes(action) && !action.startsWith('status:')) return again({ errors: ['Unknown action.'] });
    try {
      const { commitUrl, sha } = await gh.updateFile(path, pretty(ordered(tool)) + '\n',
        `Update tool: ${tool.name}${action.startsWith('status:') ? ` (${old.status} to ${tool.status})` : ''}\n\nEdited in the editor console by @${s.login}.`, stored.sha);
      const keys = changedKeys(old, tool);
      await accounts.audit({ actor: s, action: action.startsWith('status:') ? 'tool.status' : 'tool.update', targetType: 'tool', targetId: slug, detail: { changed: keys, ...(action.startsWith('status:') ? { before: old.status, after: tool.status } : {}), commit: commitUrl || null }, ip });
      return toolEdit(s, slug, { file: { text: pretty(ordered(tool)) + '\n', sha: sha || stored.sha }, notice: { ok: true, html: `Saved${commitUrl ? ` · <a href="${h(commitUrl)}">commit</a>` : ''}. The site rebuilds in about 3 minutes.` } });
    } catch (e) {
      return again({ json: pretty(ordered(tool)), errors: [`Could not save: ${e.message}`] });
    }
  }

  async function loadOffers(s) {
    const gh = github(s.token);
    const out = [];
    for (const f of OFFER_FILES) {
      const file = await gh.readFile(f.path);
      if (!file) continue;
      out.push({ ...f, sha: file.sha, data: JSON.parse(file.text) });
    }
    return out;
  }

  async function offersPage(s, show, notice) {
    const files = await loadOffers(s);
    const t = today();
    const staleDays = (await cfg()).stale_days;
    const all = files.flatMap((f) => f.data.resources.map((r) => ({ ...r, flags: offerFlags(r, t, staleDays) })));
    const rows = (show === 'recheck' ? all.filter((r) => needsLook(r.flags)) : all)
      .sort((a, b) => (a.last_verified || '').localeCompare(b.last_verified || '') || a.id.localeCompare(b.id));
    return html(200, page('Offers', s, offersView({ rows, filter: show === 'recheck' ? 'recheck' : 'all', notice })));
  }

  async function offerEdit(s, id, { json, errors, notice, files } = {}) {
    files ??= await loadOffers(s);
    const file = files.find((f) => f.data.resources.some((r) => r.id === id));
    if (!file) return notFound(s, `Offer ${id}`);
    const rec = file.data.resources.find((r) => r.id === id);
    const others = files.flatMap((f) => f.data.resources.filter((r) => r.id !== id).map((r) => r.id));
    return html(200, page(rec.name, s, offerEditView({
      rec, json: json ?? pretty(rec), sha: file.sha, file: file.path, notice, today: today(), canEdit: can(s.role, 'content.edit'),
      errors: errors ?? checkOffer(rec, { otherIds: others, today: today() }),
    })));
  }

  async function offerAct(req, s, id, ip) {
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    const files = await loadOffers(s);
    const file = files.find((f) => f.data.resources.some((r) => r.id === id));
    if (!file) return notFound(s, `Offer ${id}`);
    const again = (extra) => offerEdit(s, id, { json: form.json, ...extra });
    if (form.sha !== file.sha) return again({ files, errors: ['This file changed on GitHub after you opened it. Reload the page and apply your edit again.'] });
    const idx = file.data.resources.findIndex((r) => r.id === id);
    const old = file.data.resources[idx];
    const others = files.flatMap((f) => f.data.resources.filter((r) => r.id !== id).map((r) => r.id));
    let rec;
    const action = form.action || '';
    if (action === 'verified') {
      if (form.confirm !== '1') return again({ files, errors: ['Tick the box to confirm you opened the source page.'] });
      rec = { ...old, last_verified: today() };
    } else {
      try { rec = JSON.parse(form.json ?? ''); } catch (e) { return again({ files, errors: [`The record is not valid JSON: ${e.message}`] }); }
    }
    const errors = checkOffer(rec, { otherIds: others, today: today() });
    if (rec?.id !== id) errors.push(`id: must stay "${id}". To rename an offer, add a new record and mark this one ended.`);
    if (action === 'check' || errors.length) return again({ files, json: pretty(rec), errors });
    if (action !== 'save' && action !== 'verified') return again({ files, errors: ['Unknown action.'] });
    const next = { ...file.data, resources: file.data.resources.map((r, i) => (i === idx ? rec : r)) };
    try {
      const { commitUrl, sha } = await github(s.token).updateFile(file.path, pretty(next) + '\n',
        `${action === 'verified' ? 'Re-check' : 'Update'} offer: ${rec.id}\n\nEdited in the editor console by @${s.login}.`, file.sha);
      await accounts.audit({ actor: s, action: action === 'verified' ? 'offer.verified' : 'offer.update', targetType: 'offer', targetId: id, detail: { file: file.path, changed: changedKeys(old, rec), commit: commitUrl || null }, ip });
      const fresh = files.map((f) => (f === file ? { ...f, sha: sha || f.sha, data: next } : f));
      return offerEdit(s, id, { files: fresh, notice: { ok: true, html: `Saved${commitUrl ? ` · <a href="${h(commitUrl)}">commit</a>` : ''}. After it is merged, the owner runs <code>npm run load-seed</code> to update the API.` } });
    } catch (e) {
      return again({ files, json: pretty(rec), errors: [`Could not save: ${e.message}`] });
    }
  }

  async function waitlistPage(s) {
    return html(200, page('Waitlist', s, waitlistView({ data: await store.waitlist(), canExport: can(s.role, 'waitlist.export') })));
  }

  // A cell that starts with = + - or @ can run as a formula in Excel, so it is prefixed with an apostrophe.
  const csvCell = (v) => {
    const t = String(v ?? '');
    const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };

  async function waitlistCsv(s, ip) {
    const rows = await store.waitlistAll();
    await accounts.audit({ actor: s, action: 'waitlist.export', targetType: 'waitlist', detail: { rows: rows.length }, ip });
    const lines = [['email', 'source', 'country', 'consent_at', 'created_at'], ...rows.map((r) => [r.email, r.source, r.country, new Date(r.consent_at).toISOString(), new Date(r.created_at).toISOString()])];
    return new Response(lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n', {
      headers: { ...SECURITY_HEADERS, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="freemeans-waitlist-${today()}.csv"` },
    });
  }

  async function saveNote(req, s, id, ip) {
    const note = String(new URLSearchParams(await req.text()).get('note') || '').trim().slice(0, 2000);
    if (!(await store.get(id))) return notFound(s, 'That candidate');
    await store.setNote(id, note);
    await accounts.audit({ actor: s, action: 'queue.note', targetType: 'candidate', targetId: id, detail: { length: note.length }, ip });
    return redirect(`/c/${id}`);
  }

  // ---- phase 4: analytics, health, settings, controls ----
  let cfgCache = { at: 0, v: null };
  async function cfg() {
    if (!cfgCache.v || Date.now() - cfgCache.at > 15_000) cfgCache = { at: Date.now(), v: resolveSettings(await accounts.getSettings()) };
    return cfgCache.v;
  }

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const validDate = (v) => DATE_RE.test(v || '') && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
  function range(url) {
    const to0 = today();
    const from0 = new Date(now().getTime() - 29 * 86_400_000).toISOString().slice(0, 10);
    let from = url.searchParams.get('from') || from0;
    let to = url.searchParams.get('to') || to0;
    let error = null;
    if (!validDate(from) || !validDate(to)) { error = 'Dates must look like 2026-11-14. Showing the last 30 days.'; from = from0; to = to0; }
    else if (from > to) { error = 'The start date is after the end date. Showing the last 30 days.'; from = from0; to = to0; }
    else if (Date.parse(to) - Date.parse(from) > 365 * 86_400_000) { error = 'Pick a range of at most one year. Showing the last 30 days.'; from = from0; to = to0; }
    return { from, to, error };
  }

  async function analyticsPage(s, url) {
    const { from, to, error } = range(url);
    return html(200, page('Analytics', s, analyticsView({ data: await store.analytics(from, to), from, to, error })));
  }

  async function analyticsCsv(s, url) {
    const { from, to } = range(url);
    const rows = await store.analyticsRows(from, to);
    const lines = [['day', 'slug', 'country', 'clicks'], ...rows.map((r) => [r.day, r.slug, r.country, r.clicks])];
    return new Response(lines.map((l) => l.map(csvCell).join(',')).join('\r\n') + '\r\n', {
      headers: { ...SECURITY_HEADERS, 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="freemeans-clicks-${from}-to-${to}.csv"` },
    });
  }

  async function healthPage(s) {
    return html(200, page('Health', s, healthView({ data: await store.health(), repo })));
  }

  async function settingsPage(s, { notice, errors } = {}) {
    return html(200, page('Settings', s, settingsView({ values: await cfg(), canEdit: can(s.role, 'settings.edit'), notice, errors })));
  }

  async function saveSettings(req, s, ip) {
    const form = new URLSearchParams(await req.text());
    const before = await cfg();
    const next = {};
    const errors = [];
    for (const key of Object.keys(SETTING_DEFS)) {
      const r = parseSetting(key, form.get(key));
      if (r.ok) next[key] = r.value; else errors.push(r.error);
    }
    if (errors.length) return settingsPage(s, { errors });
    const changes = {};
    for (const [k, v] of Object.entries(next)) {
      if (v === before[k]) continue;
      await accounts.setSetting(k, v, s.login);
      changes[k] = { before: before[k], after: v };
    }
    cfgCache = { at: 0, v: null };
    if (Object.keys(changes).length) await accounts.audit({ actor: s, action: 'settings.update', targetType: 'settings', detail: changes, ip });
    return settingsPage(s, { notice: { ok: true, html: Object.keys(changes).length ? 'Settings saved.' : 'Nothing changed.' } });
  }

  async function workflowFiles(s) {
    try {
      return (await github(s.token).listDir('.github/workflows')).filter((n) => /\.ya?ml$/.test(n)).sort();
    } catch {
      return [];
    }
  }

  async function controlsPage(s, notice) {
    return html(200, page('Controls', s, controlsView({
      canRun: can(s.role, 'controls.run'), canDanger: can(s.role, 'controls.danger'), hookReady: !!rebuild, workflows: await workflowFiles(s), notice,
    })));
  }

  async function runRebuild(s, ip) {
    if (!rebuild) return controlsPage(s, { ok: false, html: 'The deploy hook is not set up.' });
    if ((await accounts.recentCount('control.rebuild', null, 120)) > 0) return controlsPage(s, { ok: false, html: 'A rebuild was started less than 2 minutes ago. Wait a little.' });
    try {
      await rebuild();
    } catch (e) {
      return controlsPage(s, { ok: false, html: `The rebuild did not start: ${h(e.message)}` });
    }
    await accounts.audit({ actor: s, action: 'control.rebuild', targetType: 'site', ip });
    return controlsPage(s, { ok: true, html: 'Rebuild started. The site updates in about 3 minutes.' });
  }

  async function runWorkflow(req, s, ip) {
    const file = new URLSearchParams(await req.text()).get('file') || '';
    if (!(await workflowFiles(s)).includes(file)) return controlsPage(s, { ok: false, html: 'Unknown workflow.' });
    if ((await accounts.recentCount('control.workflow', file, 60)) > 0) return controlsPage(s, { ok: false, html: `${h(file)} was started less than a minute ago.` });
    try {
      await github(s.token).dispatchWorkflow(file);
    } catch (e) {
      return controlsPage(s, { ok: false, html: `Could not start ${h(file)}: ${h(e.message)}` });
    }
    await accounts.audit({ actor: s, action: 'control.workflow', targetType: 'workflow', targetId: file, ip });
    return controlsPage(s, { ok: true, html: `Started <code>${h(file)}</code>. <a href="https://github.com/${h(repo)}/actions">See the run on GitHub</a>.` });
  }

  async function runCleanup(req, s, ip) {
    if (new URLSearchParams(await req.text()).get('confirm') !== 'CLEANUP') return controlsPage(s, { ok: false, html: 'Type CLEANUP exactly to confirm.' });
    const done = await accounts.cleanup();
    await accounts.audit({ actor: s, action: 'control.cleanup', targetType: 'database', detail: done, ip });
    return controlsPage(s, { ok: true, html: `Removed ${done.sessions} old sessions and ${done.failures} old sign-in failures.` });
  }

  async function handle(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (path === '/login' && req.method === 'GET') return login(req);
    if (path === '/callback' && req.method === 'GET') return finishLogin(req, url);

    const s = await session(req);
    if (!s) return req.method === 'GET' ? redirect('/login') : html(401, page('Signed out', null, '<h1>Signed out</h1><p><a href="/login">Sign in with GitHub</a></p>'));

    if (req.method === 'POST') {
      // CSRF: the session cookie is SameSite=Lax; also require the request to come from this site.
      // Browsers send "Origin: null" on form posts when the referrer policy is no-referrer, so a missing or
      // "null" Origin is accepted only when the browser itself says the request is same-origin.
      const from = req.headers.get('origin');
      const sameSite = from && from !== 'null' ? from === origin : req.headers.get('sec-fetch-site') === 'same-origin';
      if (!sameSite) return html(403, page('Blocked', s, '<h1>Blocked</h1><p>That form came from another site.</p>'));
      // CSRF token: tied to this sign-in, sent as a hidden field in every form.
      const raw = await req.clone().text();
      if (!safeEqual(new URLSearchParams(raw).get('_csrf') || '', s.csrf)) {
        return html(403, page('Blocked', s, '<h1>Blocked</h1><p>This form has expired. Go back, reload the page and try again.</p>'));
      }
      const ip = ipOf(req);
      if (path === '/logout') {
        await accounts.revokeSession(s.sid);
        await accounts.audit({ actor: s, action: 'logout', targetType: 'session', targetId: s.sid, ip });
        return redirect('/login', { 'set-cookie': cookie(SESSION, '', 0) });
      }
      if (path === '/account/sign-out-others') {
        const n = await accounts.revokeAll(s.userId, s.sid);
        await accounts.audit({ actor: s, action: 'session.revoke_others', targetType: 'user', targetId: s.userId, detail: { ended: n }, ip });
        return accountPage(s, { ok: true, html: `Signed out ${n} other session${n === 1 ? '' : 's'}.` });
      }
      if (path === '/users/invite') return can(s.role, 'users.manage') ? invite(req, s, ip) : denied(s, 'invite users');
      let m = /^\/users\/(\d+)\/(role|deactivate|activate)$/.exec(path);
      if (m) {
        if (!can(s.role, 'users.manage')) return denied(s, 'manage users');
        const id = Number(m[1]);
        return m[2] === 'role' ? changeRole(req, s, id, ip) : setActive(s, id, m[2] === 'activate', ip);
      }
      const REVIEW = 'review the queue';
      if (path === '/queue/bulk') return can(s.role, 'queue.review') ? bulk(req, s, ip) : denied(s, REVIEW);
      const EDIT = 'edit content';
      m = /^\/tools\/([a-z0-9][a-z0-9-]{0,60})$/.exec(path);
      if (m) return can(s.role, 'content.edit') ? toolAct(req, s, m[1], ip) : denied(s, EDIT);
      m = /^\/offers\/([a-z0-9]+(?:\.[a-z0-9-]+)+)$/.exec(path);
      if (m) return can(s.role, 'content.edit') ? offerAct(req, s, m[1], ip) : denied(s, EDIT);
      m = /^\/c\/(\d+)\/note$/.exec(path);
      if (m) return can(s.role, 'queue.review') ? saveNote(req, s, Number(m[1]), ip) : denied(s, REVIEW);
      if (path === '/settings') return can(s.role, 'settings.edit') ? saveSettings(req, s, ip) : denied(s, 'change settings');
      if (path === '/controls/rebuild') return can(s.role, 'controls.run') ? runRebuild(s, ip) : denied(s, 'run controls');
      if (path === '/controls/workflow') return can(s.role, 'controls.run') ? runWorkflow(req, s, ip) : denied(s, 'run controls');
      if (path === '/controls/cleanup') return can(s.role, 'controls.danger') ? runCleanup(req, s, ip) : denied(s, 'use the danger zone');
      if (path === '/seed') return can(s.role, 'queue.review') ? seed(req, s, ip) : denied(s, REVIEW);
      m = /^\/c\/(\d+)$/.exec(path);
      if (m) return can(s.role, 'queue.review') ? act(req, s, Number(m[1]), ip) : denied(s, REVIEW);
      m = /^\/c\/(\d+)\/reject$/.exec(path);
      if (m) return can(s.role, 'queue.review') ? reject(req, s, Number(m[1]), ip) : denied(s, REVIEW);
    }
    if (req.method === 'GET') {
      if (path === '/tools') return can(s.role, 'content.view') ? toolsPage(s) : denied(s, 'see tools');
      if (path === '/offers') return can(s.role, 'content.view') ? offersPage(s, url.searchParams.get('show')) : denied(s, 'see offers');
      if (path === '/waitlist') return can(s.role, 'waitlist.view') ? waitlistPage(s) : denied(s, 'see the waitlist');
      if (path === '/waitlist.csv') return can(s.role, 'waitlist.export') ? waitlistCsv(s, ipOf(req)) : denied(s, 'export the waitlist');
      let g = /^\/tools\/([a-z0-9][a-z0-9-]{0,60})$/.exec(path);
      if (g) return can(s.role, 'content.view') ? toolEdit(s, g[1]) : denied(s, 'see tools');
      g = /^\/offers\/([a-z0-9]+(?:\.[a-z0-9-]+)+)$/.exec(path);
      if (g) return can(s.role, 'content.view') ? offerEdit(s, g[1]) : denied(s, 'see offers');
      if (path === '/analytics') return can(s.role, 'analytics.view') ? analyticsPage(s, url) : denied(s, 'see analytics');
      if (path === '/analytics.csv') return can(s.role, 'analytics.view') ? analyticsCsv(s, url) : denied(s, 'export analytics');
      if (path === '/health') return can(s.role, 'health.view') ? healthPage(s) : denied(s, 'see health');
      if (path === '/settings') return can(s.role, 'settings.view') ? settingsPage(s) : denied(s, 'see settings');
      if (path === '/controls') return can(s.role, 'controls.run') ? controlsPage(s) : denied(s, 'see controls');
      if (path === '/account') return accountPage(s);
      if (path === '/users') return can(s.role, 'users.view') ? usersPage(s) : denied(s, 'see users');
      if (path === '/audit') return can(s.role, 'audit.view') ? auditPage(s, url) : denied(s, 'see the audit log');
      if (path === '/') return overview(s);
      if (path === '/queue') return queue(s, url.searchParams.get('rejected') ? { ok: true, html: 'Rejected. The crawler will not suggest that site again.' } : null, url.searchParams);
      const m = /^\/c\/(\d+)$/.exec(path);
      if (m) return review(s, Number(m[1]));
    }
    return html(404, page('Not found', s, '<h1>Not found</h1><p><a href="/">Back to the queue</a></p>'));
  }

  return async (req) => {
    try {
      return await handle(req);
    } catch (e) {
      return html(500, page('Error', null, `<h1>Something went wrong</h1><p>${h(e.message)}</p><p><a href="/">Back to the queue</a></p>`));
    }
  };
}
