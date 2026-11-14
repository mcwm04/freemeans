// Server-rendered HTML for the console. Everything from the queue was written by a crawler, an LLM
// or a stranger on the internet, so every value goes through h() before it reaches the page.
export const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{--ink:#121815;--muted:#5b655f;--line:#d9ddd8;--bg:#f5f3ee;--card:#fff;--brand:#0b6e69;--warn:#9a5b00;--bad:#b42318;--ok:#1d7a46}
@media (prefers-color-scheme:dark){:root{--ink:#e8ece9;--muted:#9aa49e;--line:#2b3430;--bg:#0f1512;--card:#161e1a;--brand:#3cc2b6}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px 20px;padding:10px 24px;border-bottom:1px solid var(--line);background:var(--card)}
header a{color:var(--ink);font-weight:700;text-decoration:none}.bar{display:flex;gap:18px;align-items:center;flex-wrap:wrap}a.nav{font-weight:500;color:var(--muted)}.kpis{display:grid;grid-template-columns:repeat(auto-fill,minmax(190px,1fr));gap:12px;margin-bottom:20px}a.kpi{text-decoration:none;color:var(--ink)}.kpi{display:flex;flex-direction:column;gap:2px}.kpi b{font-size:28px;line-height:1.1}.kpi span{color:var(--muted);font-size:13px}@media(max-width:700px){main{padding:16px}table{display:block;overflow-x:auto;max-width:100%}input[type=url],input[type=text]{min-width:0;width:100%}.kpis{grid-template-columns:repeat(2,minmax(0,1fr))}a.kpi b,.kpi b{font-size:24px}header{padding:10px 16px}}
header form{display:flex;align-items:center;gap:8px}header button{padding:4px 10px;font-size:13px}.bar{gap:4px 16px!important}a.kpi.warnc{border-color:var(--warn)}a.kpi.badc{border-color:var(--bad)}.barbg{background:var(--line);border-radius:6px;height:10px;margin:8px 0}.barfill{background:var(--brand);height:10px;border-radius:6px}.barfill.warnc{background:var(--warn)}.barfill.badc{background:var(--bad)}ul.feed{list-style:none;padding:0;margin:0 0 8px}ul.feed li{padding:3px 0;font-size:14px}main{max-width:1400px;margin:0 auto;padding:24px}
h1{font-size:24px;margin:0 0 16px}h2{font-size:17px;margin:24px 0 8px}a{color:var(--brand)}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top;font-size:14px}th{color:var(--muted);font-weight:600}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid var(--line);font-size:12px;margin:0 4px 4px 0}
.drafted{border-color:var(--ok);color:var(--ok)}.needs_manual,.flag{border-color:var(--warn);color:var(--warn)}.bad{color:var(--bad)}
.grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:20px}@media(max-width:1000px){.grid{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px}
textarea{width:100%;min-height:560px;font:13px/1.45 ui-monospace,Consolas,monospace;padding:12px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink)}
iframe{width:100%;height:720px;border:1px solid var(--line);border-radius:8px;background:#fff}
button,select{font:inherit;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--ink);cursor:pointer}
button.primary{background:var(--brand);border-color:var(--brand);color:#fff;font-weight:600}.row{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:12px}
.msg{padding:10px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);margin-bottom:16px}.msg.ok{border-color:var(--ok)}.msg.bad{border-color:var(--bad)}
ul.errs{margin:6px 0 0;padding-left:18px;color:var(--bad)}blockquote{margin:4px 0 8px;padding-left:10px;border-left:3px solid var(--line);color:var(--muted);font-size:13px}
.stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}.stats .card{padding:10px 14px}.muted{color:var(--muted)}small{color:var(--muted)}
input[type=url],input[type=text]{font:inherit;padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--ink);min-width:260px}
`;

import { can } from './permissions.js';

/** `who` is the signed-in session ({ login, role, csrf }) or null on public pages. Every POST form gets the CSRF field. */
export function page(title, who, body) {
  const csrfField = who?.csrf ? `<input type="hidden" name="_csrf" value="${h(who.csrf)}">` : '';
  const addCsrf = (html) => (csrfField ? html.replace(/<form\b[^>]*method="post"[^>]*>/gi, (tag) => tag + csrfField) : html);
  const withCsrf = addCsrf(body);
  const nav = who ? [['/', 'Overview', true], ['/queue', 'Queue', true], ['/tools', 'Tools', can(who.role, 'content.view')], ['/offers', 'Offers', can(who.role, 'content.view')], ['/waitlist', 'Waitlist', can(who.role, 'waitlist.view')], ['/analytics', 'Analytics', can(who.role, 'analytics.view')], ['/health', 'Health', can(who.role, 'health.view')], ['/controls', 'Controls', can(who.role, 'controls.run')], ['/settings', 'Settings', can(who.role, 'settings.view')], ['/users', 'Users', can(who.role, 'users.view')], ['/audit', 'Audit log', can(who.role, 'audit.view')], ['/account', 'Account', true]]
    .filter((n) => n[2]).map(([href, label]) => `<a href="${href}" class="nav">${label}</a>`).join('') : '';
  const user = who ? `<form method="post" action="/logout" style="margin:0"><small>@${h(who.login)} · ${h(who.role)}</small> <button>Sign out</button></form>` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${h(title)} · Freemeans editor</title><style>${CSS}</style></head><body>
<header><div class="bar"><a href="/">Freemeans editor</a>${nav}</div>${addCsrf(user)}</header>
<main>${withCsrf}</main></body></html>`;
}

const ago = (d) => {
  if (!d) return 'never';
  const hrs = Math.round((Date.now() - new Date(d).getTime()) / 3_600_000);
  return hrs < 48 ? `${hrs} h ago` : `${Math.round(hrs / 24)} days ago`;
};

export const REASONS_LIST = [['duplicate', 'Duplicate'], ['dead_site', 'Dead site'], ['out_of_scope', 'Out of scope'], ['unsafe', 'Unsafe'], ['parked', 'Parked domain'], ['no_ai', 'Not an AI tool'], ['other', 'Other']];
export const PAGE_SIZE = 50;

const sparkline = (daily) => {
  if (!daily.length) return '<span class="muted">No clicks recorded yet.</span>';
  const max = Math.max(...daily.map((d) => d.n), 1);
  const w = 160 / Math.max(daily.length - 1, 1);
  const pts = daily.map((d, i) => `${(i * w).toFixed(1)},${(36 - (d.n / max) * 32).toFixed(1)}`).join(' ');
  return `<svg viewBox="0 0 160 40" style="width:100%;max-width:520px;height:auto" role="img" aria-label="Clicks per day, last 14 days"><polyline points="${pts}" fill="none" stroke="var(--brand)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
};

export function overviewView({ counts, jobs, stale, stats, activity, canReview, canAudit }) {
  const c = (k) => counts[k] ?? 0;
  const pending = c('drafted') + c('needs_manual') + c('new');
  const failed = jobs.filter((j) => j.ok === false);
  const jobRows = ['signals', 'backfill', 'crawler'].map((name) => {
    const j = jobs.find((x) => x.job === name);
    return `<tr><td>${name}</td><td>${j ? ago(j.started_at) : 'never'}</td><td>${j ? (j.ok ? 'OK' : j.ok === false ? '<span class="bad">not OK</span>' : 'running') : '–'}</td></tr>`;
  }).join('');
  const kpi = (n, label, href, tone = '') => `<a class="card kpi ${tone}" href="${href || '#'}"><b>${n}</b><span>${label}</span></a>`;
  const staleRows = stale.slice(0, 10).map((t) => `<li><a href="https://freemeans.com/tools/${h(t.slug)}/">${h(t.name)}</a> <small>checked ${h(t.verified_at)}</small></li>`).join('');
  const feed = activity.map((r) => `<li><small>${h(new Date(r.at).toISOString().slice(5, 16).replace('T', ' '))}</small> ${r.actor_login ? `@${h(r.actor_login)}` : 'system'} · <code>${h(r.action)}</code></li>`).join('');
  return `<h1>Overview</h1>
<div class="kpis">
  ${kpi(pending, 'pending reviews', '/queue', pending ? 'warnc' : '')}
  ${kpi(c('drafted'), 'drafted, ready to check', '/queue?status=drafted')}
  ${kpi(stats.clicks7, 'outbound clicks, 7 days', '')}
  ${kpi(stats.clicks30, 'outbound clicks, 30 days', '')}
  ${kpi(stale.length, 'free tiers not checked for 30+ days', '#stale', stale.length ? 'warnc' : '')}
  ${kpi(failed.length, 'failed jobs (last run)', '#jobs', failed.length ? 'badc' : '')}
  ${kpi(stats.waitlist7, 'waitlist sign-ups, 7 days', '')}
</div>
<div class="grid">
  <div class="card"><h2 style="margin-top:0">Clicks per day, last 14 days</h2>${sparkline(stats.daily)}
    <div class="row"><a href="/queue">Open the review queue</a>${canReview ? '<a href="/queue#add">Add a tool</a>' : ''}</div></div>
  <div class="card" id="jobs"><h2 style="margin-top:0">Jobs</h2><table><thead><tr><th>Job</th><th>Last run</th><th>Result</th></tr></thead><tbody>${jobRows}</tbody></table></div>
</div>
<div class="grid" style="margin-top:20px">
  <div class="card" id="stale"><h2 style="margin-top:0">Free tiers not checked for 30+ days</h2>${staleRows ? `<ul>${staleRows}</ul>${stale.length > 10 ? `<small>and ${stale.length - 10} more</small>` : ''}` : '<p class="muted">None. Every published free tier was checked in the last 30 days.</p>'}</div>
  ${canAudit ? `<div class="card"><h2 style="margin-top:0">Recent activity</h2>${feed ? `<ul class="feed">${feed}</ul><a href="/audit">Full audit log</a>` : '<p class="muted">Nothing yet.</p>'}</div>` : ''}
</div>`;
}

const STATUS_FILTERS = [['active', 'All open'], ['drafted', 'Drafted'], ['needs_manual', 'Needs manual work'], ['new', 'Waiting for crawler'], ['approved', 'Approved'], ['rejected', 'Rejected'], ['done', 'All closed']];

export function queueView({ counts, items, total, page: pg = 1, filters = {}, sources = [], notice, canReview = true }) {
  const c = (k) => counts[k] ?? 0;
  const rows = items.map((r) => `<tr>
    ${canReview ? `<td>${['drafted', 'needs_manual', 'new'].includes(r.status) ? `<input type="checkbox" name="id" value="${r.id}" form="bulk" aria-label="Select ${h(r.domain)}">` : ''}</td>` : ''}
    <td><a href="/c/${r.id}">${h(r.draft?.name || r.name || r.domain)}</a><br><small>${h(r.domain)}</small></td>
    <td><span class="pill ${h(r.status)}">${h(r.status.replace('_', ' '))}</span></td>
    <td>${h(r.source)}${r.source === 'submit' && r.submitter_email ? '<br><small>has email</small>' : ''}</td>
    <td>${r.priority}</td>
    <td>${(r.flags || []).slice(0, 3).map((f) => `<span class="pill flag">${h(f.split(':')[0].replace('_', ' '))}</span>`).join('')}</td>
    <td><small>${h(new Date(r.created_at).toISOString().slice(0, 10))}</small></td></tr>`).join('');
  const pages = Math.max(Math.ceil(total / PAGE_SIZE), 1);
  const qs = (p) => new URLSearchParams({ ...(filters.status && filters.status !== 'active' ? { status: filters.status } : {}), ...(filters.source ? { source: filters.source } : {}), ...(filters.q ? { q: filters.q } : {}), ...(p > 1 ? { page: String(p) } : {}) }).toString();
  const link = (p) => `/queue${qs(p) ? `?${qs(p)}` : ''}`;
  const pager = pages > 1 ? `<div class="row"><small>Page ${pg} of ${pages} · ${total} results</small>${pg > 1 ? `<a href="${link(pg - 1)}">← Previous</a>` : ''}${pg < pages ? `<a href="${link(pg + 1)}">Next →</a>` : ''}</div>` : `<small>${total} result${total === 1 ? '' : 's'}</small>`;
  return `${notice ? `<div class="msg ${notice.ok ? 'ok' : 'bad'}">${notice.html}</div>` : ''}
<h1>Review queue</h1>
<div class="stats"><div class="card"><b>${c('drafted')}</b> drafted</div><div class="card"><b>${c('needs_manual')}</b> need manual work</div>
<div class="card"><b>${c('new')}</b> waiting for the crawler</div><div class="card"><b>${c('approved')}</b> approved</div><div class="card"><b>${c('rejected') + c('duplicate')}</b> rejected</div></div>
<form method="get" action="/queue" class="row" style="margin:0 0 12px"><select name="status" aria-label="Status">${STATUS_FILTERS.map(([v, l]) => `<option value="${v}"${(filters.status || 'active') === v ? ' selected' : ''}>${l}</option>`).join('')}</select>
<select name="source" aria-label="Source"><option value="">All sources</option>${sources.map((s) => `<option value="${h(s)}"${filters.source === s ? ' selected' : ''}>${h(s)}</option>`).join('')}</select>
<input type="text" name="q" value="${h(filters.q || '')}" placeholder="Search name or domain"><button>Filter</button>${filters.status || filters.source || filters.q ? '<a href="/queue">Clear</a>' : ''}</form>
<table><thead><tr>${canReview ? '<th></th>' : ''}<th>Tool</th><th>Status</th><th>Source</th><th>Priority</th><th>Flags</th><th>Found</th></tr></thead>
<tbody>${rows || `<tr><td colspan="${canReview ? 7 : 6}" class="muted">Nothing matches.</td></tr>`}</tbody></table>
${pager}
${canReview ? `<form id="bulk" method="post" action="/queue/bulk" class="row"><b>Selected:</b>
  <select name="reason" aria-label="Reason for rejecting">${REASONS_LIST.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
  <button name="action" value="reject">Reject selected</button>
  <label><input type="checkbox" name="confirm" value="1"> Yes, publish</label>
  <button class="primary" name="action" value="approve">Approve valid drafts</button></form>
  <small>Approve skips drafts with problems and tells you why. At most 10 per click for approve, 50 for reject.</small>
<div id="add"><h2>Add a tool yourself</h2><form method="post" action="/seed" class="row" style="margin:0">
  <input type="url" name="url" required placeholder="https://example.ai"><input type="text" name="name" required placeholder="Name"><button>Add to queue</button></form>
  <small>The crawler drafts it on its next run (01:47 Pakistan time), or run the Crawler workflow by hand.</small></div>` : ''}`;
}

export function reviewView({ cand, json, errors, notice, taxonomy, canReview = true }) {
  const ev = Object.entries(cand.evidence || {}).map(([k, v]) => `<b>${h(k)}</b><blockquote>${h(v)}</blockquote>`).join('');
  const flags = (cand.flags || []).map((f) => `<span class="pill flag">${h(f)}</span>`).join('');
  const reasons = [['duplicate', 'Duplicate'], ['dead_site', 'Dead site'], ['out_of_scope', 'Out of scope'], ['unsafe', 'Unsafe'], ['parked', 'Parked domain'], ['no_ai', 'Not an AI tool'], ['other', 'Other']];
  const raw = cand.draft?.url || cand.url;
  const site = /^https?:\/\//i.test(String(raw)) ? raw : null;
  const srcUrl = /^https?:\/\//i.test(String(cand.draft?.free_tier?.source_url)) ? cand.draft.free_tier.source_url : null;
  const done = !canReview || cand.status === 'approved' || cand.status === 'rejected' || cand.status === 'duplicate';
  return `${notice ? `<div class="msg ${notice.ok ? 'ok' : 'bad'}">${notice.html}</div>` : ''}
<p><a href="/">← Queue</a></p>
<h1>${h(cand.draft?.name || cand.name || cand.domain)} <span class="pill ${h(cand.status)}">${h(cand.status.replace('_', ' '))}</span></h1>
<p class="muted">${h(cand.source)}${cand.source_ref ? ` · ${h(cand.source_ref)}` : ''} · priority ${cand.priority}${cand.category ? ` · submitter's category: ${h(cand.category)}` : ''}${cand.submitter_email ? ` · submitter: ${h(cand.submitter_email)}` : ''}</p>
<div class="grid">
  <div class="card">
    <form method="post" action="/c/${cand.id}">
      <label for="json"><b>Listing</b> <small>(data/tools/{slug}.json, edit freely)</small></label>
      <textarea id="json" name="json" spellcheck="false">${h(json)}</textarea>
      ${errors.length ? `<div class="msg bad" style="margin:10px 0 0"><b>${errors.length} problem${errors.length > 1 ? 's' : ''} to fix before publishing</b><ul class="errs">${errors.map((e) => `<li>${h(e)}</li>`).join('')}</ul></div>` : '<p class="msg ok" style="margin:10px 0 0">Ready to publish: no problems found.</p>'}
      ${done ? '' : `<div class="row"><button name="action" value="check">Check</button><button name="action" value="save">Save draft</button>
      <button class="primary" name="action" value="approve">Approve and publish</button></div>`}
    </form>
    ${done ? '' : `<form method="post" action="/c/${cand.id}/reject" class="row"><select name="reason" aria-label="Reason">${reasons.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select><button>Reject</button></form>`}
    ${cand.review_note || canReview ? `<h2>Reviewer note</h2>${canReview ? `<form method="post" action="/c/${cand.id}/note"><textarea name="note" maxlength="2000" style="min-height:80px">${h(cand.review_note || '')}</textarea><div class="row"><button>Save note</button></div></form>` : `<p>${h(cand.review_note)}</p>`}` : ''}
    ${flags ? `<h2>Crawler flags</h2><p>${flags}</p><small>number_blanked: the LLM gave a number the page does not show next to its unit, so it was removed. Check the source and type it in if it is real.</small>` : ''}
    ${ev ? `<h2>Evidence (from the pages, not published)</h2>${ev}` : ''}
    <h2>Taxonomy</h2><details><summary>Category and task ids</summary><p><small>${taxonomy.categories.map((x) => h(x.id)).join(' · ')}</small></p><p><small>${taxonomy.tasks.map((x) => h(x.id)).join(' · ')}</small></p></details>
  </div>
  <div class="card">
    <div class="row" style="margin:0 0 10px"><b>Live site</b> ${site ? `<a href="${h(site)}" target="_blank" rel="noopener noreferrer">Open in a new tab ↗</a>` : '<span class="bad">no valid address</span>'}
    ${srcUrl ? `<a href="${h(srcUrl)}" target="_blank" rel="noopener noreferrer">Free-tier source ↗</a>` : ''}</div>
    ${site ? `<iframe src="${h(site)}" sandbox="allow-scripts allow-same-origin" referrerpolicy="no-referrer" loading="lazy" title="Live site"></iframe>` : ''}
    <small>Many sites refuse to show inside a frame. Use "Open in a new tab" when this stays blank.</small>
  </div>
</div>`;
}

const when = (d) => (d ? h(new Date(d).toISOString().replace('T', ' ').slice(0, 16)) + ' UTC' : 'never');
const note = (n) => (n ? `<div class="msg ${n.ok ? 'ok' : 'bad'}">${n.html}</div>` : '');

export function usersView({ users, me, notice, canManage }) {
  const roleOptions = (cur) => ['owner', 'admin', 'editor', 'viewer'].filter((r) => canManage(me.role, 'viewer', r))
    .map((r) => `<option value="${r}"${r === cur ? ' selected' : ''}>${r}</option>`).join('');
  const rows = users.map((u) => {
    const editable = u.id !== me.userId && canManage(me.role, u.role);
    const roleCell = editable
      ? `<form method="post" action="/users/${u.id}/role" class="row" style="margin:0"><select name="role" aria-label="Role">${roleOptions(u.role)}</select><button>Save</button></form>`
      : `<span class="pill">${h(u.role)}</span>`;
    const act = editable ? `<form method="post" action="/users/${u.id}/${u.active ? 'deactivate' : 'activate'}" style="margin:0"><button>${u.active ? 'Deactivate' : 'Activate'}</button></form>` : '';
    return `<tr><td><b>@${h(u.github_login)}</b>${u.id === me.userId ? ' <small>(you)</small>' : ''}<br><small>${u.invited_by ? `invited by @${h(u.invited_by)}` : 'bootstrap owner'}</small></td>
      <td>${roleCell}</td><td>${u.active ? '<span class="pill drafted">active</span>' : '<span class="pill flag">deactivated</span>'}</td>
      <td>${u.live_sessions}</td><td><small>${when(u.last_login_at)}</small></td><td>${act}</td></tr>`;
  }).join('');
  return `${note(notice)}<h1>Users</h1>
<table><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Live sessions</th><th>Last sign-in</th><th></th></tr></thead><tbody>${rows}</tbody></table>
<h2>Invite someone</h2>
<form method="post" action="/users/invite" class="row" style="margin:0"><input type="text" name="login" required placeholder="GitHub username" pattern="@?[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}">
<select name="role" aria-label="Role">${roleOptions('editor')}</select><button class="primary">Invite</button></form>
<small>No open sign-up. They sign in with their GitHub account once invited. Owner: everything. Admin: users and all content. Editor: review and publish. Viewer: read only.</small>`;
}

export function accountView({ me, sessions, notice }) {
  const rows = sessions.map((s) => `<tr><td>${s.id === me.sid ? '<b>This device</b>' : 'Other device'}</td><td><small>${h(s.ip || 'unknown')}</small></td>
    <td><small>${h((s.user_agent || '').slice(0, 80))}</small></td><td><small>${when(s.created_at)}</small></td><td><small>${when(s.expires_at)}</small></td></tr>`).join('');
  return `${note(notice)}<h1>Your account</h1><p>@${h(me.login)} · <span class="pill">${h(me.role)}</span></p>
<h2>Where you are signed in</h2>
<table><thead><tr><th>Session</th><th>IP</th><th>Browser</th><th>Started</th><th>Expires</th></tr></thead><tbody>${rows}</tbody></table>
<form method="post" action="/account/sign-out-others" class="row"><button>Sign out everywhere else</button></form>`;
}

export function auditView({ rows, actor, action }) {
  const body = rows.map((r) => `<tr><td><small>${when(r.at)}</small></td><td>${r.actor_login ? `@${h(r.actor_login)}` : '–'}<br><small>${h(r.actor_role || '')}</small></td>
    <td><code>${h(r.action)}</code></td><td>${h(r.target_type || '')} ${h(r.target_id || '')}</td>
    <td><small>${h(JSON.stringify(r.detail))}</small></td><td><small>${h(r.ip || '')}</small></td></tr>`).join('');
  return `<h1>Audit log</h1>
<form method="get" action="/audit" class="row" style="margin:0 0 12px"><input type="text" name="actor" value="${h(actor || '')}" placeholder="GitHub username"><input type="text" name="action" value="${h(action || '')}" placeholder="Action starts with, e.g. user."><button>Filter</button></form>
<table><thead><tr><th>When</th><th>Who</th><th>Action</th><th>Target</th><th>Details</th><th>IP</th></tr></thead><tbody>${body || '<tr><td colspan="6" class="muted">Nothing recorded yet.</td></tr>'}</tbody></table>
<small>Latest 200 entries. This log can only be added to, never edited or deleted.</small>`;
}

// ---- phase 3: tools, offers, waitlist ----

const problems = (errors) => (errors.length
  ? `<div class="msg bad" style="margin:10px 0 0"><b>${errors.length} problem${errors.length > 1 ? 's' : ''} to fix before saving</b><ul class="errs">${errors.map((e) => `<li>${h(e)}</li>`).join('')}</ul></div>`
  : '<p class="msg ok" style="margin:10px 0 0">No problems found.</p>');

export function toolsView({ slugs, info, notice }) {
  const rows = slugs.map((slug) => {
    const i = info[slug];
    return `<tr><td><a href="/tools/${h(slug)}">${h(i?.name || slug)}</a><br><small>${h(slug)}</small></td>
      <td>${i ? '<span class="pill drafted">live</span>' : '<span class="pill">hidden or removed</span>'}</td>
      <td><small>${h(i?.verified_at || '–')}</small></td>
      <td>${i ? `<small><a href="https://freemeans.com/tools/${h(slug)}/" rel="noopener noreferrer">View on site ↗</a></small>` : ''}</td></tr>`;
  }).join('');
  return `${note(notice)}<h1>Directory tools</h1>
<table><thead><tr><th>Tool</th><th>On the site</th><th>Free tier checked</th><th></th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="muted">No tools found.</td></tr>'}</tbody></table>
<small>${slugs.length} files in data/tools/. New tools come from the <a href="/queue">review queue</a>. Every save is a GitHub commit under your name.</small>`;
}

export function toolEditView({ slug, tool, json, sha, errors, notice, canEdit }) {
  const status = tool?.status;
  const btn = (to, label) => (status !== to ? `<button name="action" value="status:${to}">${label}</button>` : '');
  return `${note(notice)}<p><a href="/tools">← Tools</a></p>
<h1>${h(tool?.name || slug)} ${status ? `<span class="pill ${status === 'published' ? 'drafted' : 'flag'}">${h(status)}</span>` : ''}</h1>
<div class="card"><form method="post" action="/tools/${h(slug)}">
  <input type="hidden" name="sha" value="${h(sha)}">
  <label for="json"><b>Listing</b> <small>(data/tools/${h(slug)}.json)</small></label>
  <textarea id="json" name="json" spellcheck="false"${canEdit ? '' : ' readonly'}>${h(json)}</textarea>
  ${problems(errors)}
  ${canEdit ? `<div class="row"><button name="action" value="check">Check</button><button class="primary" name="action" value="save">Save to GitHub</button>
  ${btn('published', 'Publish')}${btn('hidden', 'Hide (keep page)')}${btn('removed', 'Remove (page returns 410)')}</div>
  <small>Hide and remove change only the status and add a changelog line. Nothing is deleted, and you can publish again.</small>` : '<small>Your role can read this listing but not change it.</small>'}
</form></div>`;
}

export function offersView({ rows, filter, notice, errors = [] }) {
  const tr = rows.map((r) => `<tr><td><a href="/offers/${h(r.id)}">${h(r.name)}</a><br><small>${h(r.id)}</small></td>
    <td>${h(r.kind)}</td><td>${h(r.status || 'active')}</td><td><small>${h(r.last_verified || '–')}</small></td>
    <td><small>${h(r.offer_window?.redeem_by || '–')}</small></td>
    <td>${r.flags.map((f) => `<span class="pill ${f === 'ended' ? '' : 'flag'}">${h(f)}</span>`).join('')}</td></tr>`).join('');
  return `${note(notice)}<h1>Eligibility offers and free learning</h1>
<div class="row" style="margin:0 0 12px"><a href="/offers"${filter === 'all' ? ' style="font-weight:700"' : ''}>All (${rows.length})</a>
<a href="/offers?show=recheck"${filter === 'recheck' ? ' style="font-weight:700"' : ''}>Needs a look</a></div>
<table><thead><tr><th>Offer</th><th>Kind</th><th>Status</th><th>Last verified</th><th>Redeem by</th><th>Flags</th></tr></thead>
<tbody>${tr || '<tr><td colspan="6" class="muted">Nothing here.</td></tr>'}</tbody></table>
<small>Re-check means last verified more than 30 days ago. Records live in data/catalog/. After a change is merged, the owner runs <code>npm run load-seed</code> in db/ to update the API.</small>`;
}

export function offerEditView({ rec, json, sha, file, errors, notice, canEdit, today }) {
  return `${note(notice)}<p><a href="/offers">← Offers</a></p>
<h1>${h(rec?.name || '')} <span class="pill">${h(rec?.status || 'active')}</span></h1>
<p class="muted">${h(rec?.id || '')} · ${h(file)} · last verified ${h(rec?.last_verified || '–')}</p>
<div class="card"><form method="post" action="/offers/${h(rec?.id || '')}">
  <input type="hidden" name="sha" value="${h(sha)}">
  <label for="json"><b>Record</b></label>
  <textarea id="json" name="json" spellcheck="false"${canEdit ? '' : ' readonly'}>${h(json)}</textarea>
  ${problems(errors)}
  ${canEdit ? `<div class="row"><button name="action" value="check">Check</button><button class="primary" name="action" value="save">Save to GitHub</button></div>
  <div class="row"><label><input type="checkbox" name="confirm" value="1"> I opened the source page and the details above still match it.</label>
  <button name="action" value="verified">Mark re-checked today (${h(today)})</button></div>
  <small>Rule: every figure needs a source URL and a date. If you cannot confirm a detail, set the status to <code>unverified</code> instead.</small>` : '<small>Your role can read this record but not change it.</small>'}
</form></div>`;
}

const mask = (email) => email.replace(/^(.).*(@.*)$/, '$1•••$2');

export function waitlistView({ data, canExport }) {
  const list = (rows) => rows.map((r) => `<tr><td>${h(r.k)}</td><td>${r.n}</td></tr>`).join('') || '<tr><td colspan="2" class="muted">None</td></tr>';
  const recent = data.recent.map((r) => `<tr><td><small>${h(mask(r.email))}</small></td><td>${h(r.source)}</td><td>${h(r.country || '–')}</td><td><small>${when(r.created_at)}</small></td></tr>`).join('');
  return `<h1>Waitlist</h1>
<div class="kpis"><div class="card kpi"><b>${data.total}</b><span>total sign-ups</span></div><div class="card kpi"><b>${data.last7}</b><span>last 7 days</span></div></div>
<div class="grid"><div class="card"><h2 style="margin-top:0">By country</h2><table><tbody>${list(data.countries)}</tbody></table></div>
<div class="card"><h2 style="margin-top:0">By source page</h2><table><tbody>${list(data.sources)}</tbody></table></div></div>
<h2>Latest 50 (emails masked)</h2>
<table><thead><tr><th>Email</th><th>Source</th><th>Country</th><th>Joined</th></tr></thead><tbody>${recent || '<tr><td colspan="4" class="muted">No sign-ups yet.</td></tr>'}</tbody></table>
${canExport ? '<p><a href="/waitlist.csv">Download CSV with full emails</a> <small>(recorded in the audit log)</small></p>' : ''}
<small>Privacy: the waitlist stores only email, source page, consent time and country. Use the CSV only to email people who asked to be told.</small>`;
}

// ---- phase 4: analytics, health, settings, controls ----
import { DEFS } from './settings.js';

const bars = (rows, total) => rows.map((r) => `<tr><td>${h(r.k)}</td><td style="width:55%"><div class="barfill" style="width:${total ? Math.max(Math.round((r.n / total) * 100), 1) : 0}%"></div></td><td>${r.n}</td></tr>`).join('')
  || '<tr><td colspan="3" class="muted">No clicks in this period.</td></tr>';

export function analyticsView({ data, from, to, error }) {
  return `${error ? `<div class="msg bad">${h(error)}</div>` : ''}<h1>Analytics</h1>
<form method="get" action="/analytics" class="row" style="margin:0 0 16px"><label>From <input type="date" name="from" value="${h(from)}" required></label>
<label>To <input type="date" name="to" value="${h(to)}" required></label><button>Show</button><a href="/analytics.csv?from=${h(from)}&amp;to=${h(to)}">Download CSV</a></form>
<div class="kpis"><div class="card kpi"><b>${data.total}</b><span>outbound clicks</span></div><div class="card kpi"><b>${data.tools}</b><span>tools clicked</span></div></div>
<div class="card"><h2 style="margin-top:0">Clicks per day</h2>${sparkline(data.byDay)}</div>
<div class="grid" style="margin-top:20px"><div class="card"><h2 style="margin-top:0">Top tools</h2><table><tbody>${bars(data.byTool, data.byTool[0]?.n || 0)}</tbody></table></div>
<div class="card"><h2 style="margin-top:0">By country</h2><table><tbody>${bars(data.byCountry, data.byCountry[0]?.n || 0)}</tbody></table></div></div>
<small>Counts come from the /go redirect and are stored per tool, day and country only. XX means the country was unknown.</small>`;
}

const GB = 1024 ** 3;
const dur = (a, b) => (a && b ? `${Math.max(Math.round((new Date(b) - new Date(a)) / 1000), 0)} s` : '–');

export function healthView({ data, repo }) {
  const pct = Math.min(Math.round((data.bytes / GB) * 100), 100);
  const tone = pct >= 85 ? 'badc' : pct >= 70 ? 'warnc' : '';
  const runs = data.runs.slice(0, 20).map((r) => `<tr><td>${h(r.job)}</td><td><small>${when(r.started_at)}</small></td><td>${dur(r.started_at, r.ended_at)}</td>
    <td>${r.ok === true ? 'OK' : r.ok === false ? '<span class="bad">not OK</span>' : 'running'}</td><td><small>${h(JSON.stringify(r.stats ?? {}).slice(0, 120))}</small></td></tr>`).join('');
  const failed = data.runs.filter((r) => r.ok === false).length;
  return `<h1>Health</h1>
<div class="kpis"><a class="card kpi ${tone}" href="#db"><b>${pct}%</b><span>of the 1 GB database used (${(data.bytes / 1024 ** 2).toFixed(1)} MB)</span></a>
<a class="card kpi ${failed ? 'badc' : ''}" href="#runs"><b>${failed}</b><span>failed runs in the last 40</span></a></div>
<div class="grid"><div class="card" id="db"><h2 style="margin-top:0">Database</h2><div class="barbg"><div class="barfill ${tone}" style="width:${pct}%"></div></div>
<table><tbody>${data.tables.map((t) => `<tr><td>${h(t.t)}</td><td>${t.n} rows</td></tr>`).join('')}</tbody></table>
<small>Neon free plan: 1 GB storage and 100 compute hours a month. Compute hours are only shown in the Neon dashboard.</small></div>
<div class="card"><h2 style="margin-top:0">Links</h2><ul><li><a href="https://github.com/${h(repo)}/actions" rel="noopener noreferrer">GitHub Actions runs ↗</a></li>
<li><a href="https://dash.cloudflare.com/" rel="noopener noreferrer">Cloudflare dashboard (Workers requests, 100k a day) ↗</a></li>
<li><a href="https://console.neon.tech/" rel="noopener noreferrer">Neon console (compute hours) ↗</a></li></ul>
<small>Request and compute numbers live with those providers. This console does not hold their API keys.</small></div></div>
<h2 id="runs">Recent job runs</h2><table><thead><tr><th>Job</th><th>Started</th><th>Took</th><th>Result</th><th>Stats</th></tr></thead>
<tbody>${runs || '<tr><td colspan="5" class="muted">No runs recorded yet.</td></tr>'}</tbody></table>`;
}

export function settingsView({ values, canEdit, notice, errors = [] }) {
  const fields = Object.entries(DEFS).map(([k, d]) => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:8px 0"><label for="s-${k}">${h(d.label)}<br><small>${d.min} to ${d.max}, default ${d.def}.${d.note ? ` ${h(d.note)}` : ''}</small></label>
    <input id="s-${k}" type="text" inputmode="numeric" name="${k}" value="${h(values[k])}" style="min-width:90px;width:90px"${canEdit ? '' : ' readonly'}></div>`).join('');
  return `${note(notice)}${errors.length ? `<div class="msg bad"><ul class="errs">${errors.map((e) => `<li>${h(e)}</li>`).join('')}</ul></div>` : ''}<h1>Settings</h1>
<div class="card"><form method="post" action="/settings">${fields}
${canEdit ? '<div class="row"><button class="primary">Save settings</button></div>' : '<small>Only owners can change settings.</small>'}</form></div>
<small>Every change is written to the audit log with the old and new value. Ranking is never a setting: it comes from data, never from payment.</small>`;
}

export function controlsView({ canRun, canDanger, hookReady, workflows, notice }) {
  return `${note(notice)}<h1>Controls</h1>
<div class="card"><h2 style="margin-top:0">Rebuild the website</h2>
<p class="muted">Runs the Cloudflare build from main. Use it after merging data changes. Allowed once every 2 minutes.</p>
${hookReady ? `<form method="post" action="/controls/rebuild"><button class="primary"${canRun ? '' : ' disabled'}>Rebuild now</button></form>` : '<p class="msg bad">Not set up. Add the secret <code>DEPLOY_HOOK_URL</code> with <code>npx wrangler secret put DEPLOY_HOOK_URL</code> (the Cloudflare deploy hook).</p>'}</div>
<div class="card" style="margin-top:16px"><h2 style="margin-top:0">Run a GitHub workflow</h2>
<p class="muted">Starts the workflow on main with your GitHub sign-in. It only works for workflows that allow manual runs.</p>
${workflows.length ? `<table><tbody>${workflows.map((w) => `<tr><td><code>${h(w)}</code></td><td><form method="post" action="/controls/workflow" style="margin:0"><input type="hidden" name="file" value="${h(w)}"><button${canRun ? '' : ' disabled'}>Run</button></form></td></tr>`).join('')}</tbody></table>` : '<p class="muted">No workflows found.</p>'}</div>
${canDanger ? `<div class="card" style="margin-top:16px;border-color:var(--bad)"><h2 style="margin-top:0">Danger zone (owners)</h2>
<p class="muted">Clean up: deletes sessions that ended over 30 days ago and sign-in failures older than 7 days. The audit log is never touched. Tools and offers are never deleted here; use Hide or Remove on their pages.</p>
<form method="post" action="/controls/cleanup" class="row"><input type="text" name="confirm" placeholder="Type CLEANUP" autocomplete="off" required><button>Clean up</button></form></div>` : ''}`;
}
