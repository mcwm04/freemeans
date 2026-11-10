// Editor console (M6): request handling, free of Cloudflare-only imports so tests run in Node.
import { SESSION, STATE, SESSION_HOURS, cookie, readCookie, seal, unseal } from './auth.js';
import { githubClient } from './github.js';
import { checkTool, ordered, taxonomy } from './validate.js';
import { page, queueView, reviewView, h } from './views.js';
import { siteKey, parseSite } from '../../api/src/domain.js';

const REASONS = new Set(['duplicate', 'dead_site', 'out_of_scope', 'unsafe', 'parked', 'no_ai', 'other']);
const STALE_DAYS = 30;
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
  store, oauth, sessionSecret, adminUrl, allowedUsers, repo = 'mcwm04/freemeans', siteUrl = 'https://freemeans.com',
  github = (token) => githubClient(token, { repo }), siteTools = async () => [], now = () => new Date(),
}) {
  const origin = new URL(adminUrl).origin;
  const allowed = new Set(allowedUsers.map((u) => u.toLowerCase()));
  const html = (status, body, extra = {}) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS, ...extra } });
  const redirect = (location, extra = {}) => new Response(null, { status: 303, headers: { location, ...SECURITY_HEADERS, ...extra } });
  const callback = `${origin}/callback`;

  async function session(req) {
    const s = await unseal(sessionSecret, readCookie(req, SESSION), now().getTime());
    return s && allowed.has(String(s.login).toLowerCase()) ? s : null;
  }

  async function login(req) {
    const state = crypto.randomUUID();
    const sealed = await seal(sessionSecret, { state, exp: now().getTime() + 10 * 60_000 });
    return redirect(oauth.authorizeUrl(state, callback), { 'set-cookie': cookie(STATE, sealed, 600) });
  }

  async function finishLogin(req, url) {
    const saved = await unseal(sessionSecret, readCookie(req, STATE), now().getTime());
    if (!saved || !url.searchParams.get('state') || saved.state !== url.searchParams.get('state')) {
      return html(400, page('Sign-in failed', null, '<h1>Sign-in expired</h1><p><a href="/login">Try again</a>.</p>'));
    }
    const token = await oauth.exchange(url.searchParams.get('code') || '', callback);
    const user = await github(token).user();
    if (!allowed.has(String(user.login).toLowerCase())) {
      return html(403, page('Not allowed', null, `<h1>Not allowed</h1><p>@${h(user.login)} is not an editor of Freemeans.</p>`));
    }
    const sealed = await seal(sessionSecret, { login: user.login, token, exp: now().getTime() + SESSION_HOURS * 3_600_000 });
    return redirect('/', { 'set-cookie': cookie(SESSION, sealed, SESSION_HOURS * 3600) });
  }

  async function queue(s, notice) {
    const [counts, items, jobs, tools] = await Promise.all([
      store.counts(), store.list(['drafted', 'needs_manual', 'new']), store.lastJobs(), siteTools().catch(() => []),
    ]);
    const cutoff = new Date(now().getTime() - STALE_DAYS * 86_400_000).toISOString().slice(0, 10);
    const stale = tools.filter((t) => t.verified_at && t.verified_at < cutoff).sort((a, b) => a.verified_at.localeCompare(b.verified_at));
    return html(200, page('Queue', s.login, queueView({ counts, items, stale, jobs, notice })));
  }

  async function review(s, id, { json, errors, notice } = {}) {
    const cand = await store.get(id);
    if (!cand) return html(404, page('Not found', s.login, '<h1>Not found</h1><p><a href="/">Back to the queue</a></p>'));
    const draft = ordered(cand.draft ?? starter(cand));
    const text = json ?? JSON.stringify(draft, null, 2);
    let errs = errors;
    if (!errs) {
      errs = checkTool(draft, today());
    }
    return html(200, page(cand.draft?.name || cand.domain, s.login, reviewView({ cand, json: text, errors: errs, notice, taxonomy })));
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

  async function act(req, s, id) {
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    const cand = await store.get(id);
    if (!cand) return html(404, page('Not found', s.login, '<h1>Not found</h1>'));
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
      const live = `${siteUrl}/tools/${tool.slug}/`;
      return queue(s, { ok: true, html: `Published <b>${h(tool.name)}</b>. ${commitUrl ? `<a href="${h(commitUrl)}">Commit</a> · ` : ''}It appears at <a href="${h(live)}">${h(live)}</a> in about 3 minutes.` });
    } catch (e) {
      return review(s, id, { json: form.json, errors: [`Could not publish: ${e.message}`] });
    }
  }

  async function reject(req, s, id) {
    const reason = new URLSearchParams(await req.text()).get('reason');
    if (!REASONS.has(reason)) return redirect(`/c/${id}`);
    await store.reject(id, reason, s.login);
    return redirect('/?rejected=1');
  }

  async function seed(req, s) {
    const form = new URLSearchParams(await req.text());
    const u = parseSite(form.get('url'));
    const name = String(form.get('name') || '').trim().slice(0, 80);
    if (!u || !name) return queue(s, { ok: false, html: 'Enter a public web address and a name.' });
    const id = await store.addEditorSeed({ url: u.href, domain: siteKey(u.href), name, login: s.login });
    return id ? redirect(`/c/${id}`) : queue(s, { ok: false, html: `${h(siteKey(u.href))} is already in the queue or was reviewed before.` });
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
      if (!sameSite) return html(403, page('Blocked', s.login, '<h1>Blocked</h1><p>That form came from another site.</p>'));
      if (path === '/logout') return redirect('/login', { 'set-cookie': cookie(SESSION, '', 0) });
      if (path === '/seed') return seed(req, s);
      let m = /^\/c\/(\d+)$/.exec(path);
      if (m) return act(req, s, Number(m[1]));
      m = /^\/c\/(\d+)\/reject$/.exec(path);
      if (m) return reject(req, s, Number(m[1]));
    }
    if (req.method === 'GET') {
      if (path === '/') return queue(s, url.searchParams.get('rejected') ? { ok: true, html: 'Rejected. The crawler will not suggest that site again.' } : null);
      const m = /^\/c\/(\d+)$/.exec(path);
      if (m) return review(s, Number(m[1]));
    }
    return html(404, page('Not found', s.login, '<h1>Not found</h1><p><a href="/">Back to the queue</a></p>'));
  }

  return async (req) => {
    try {
      return await handle(req);
    } catch (e) {
      return html(500, page('Error', null, `<h1>Something went wrong</h1><p>${h(e.message)}</p><p><a href="/">Back to the queue</a></p>`));
    }
  };
}
