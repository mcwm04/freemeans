// Server-rendered HTML for the console. Everything from the queue was written by a crawler, an LLM
// or a stranger on the internet, so every value goes through h() before it reaches the page.
export const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const CSS = `
:root{--ink:#121815;--muted:#5b655f;--line:#d9ddd8;--bg:#f5f3ee;--card:#fff;--brand:#0b6e69;--warn:#9a5b00;--bad:#b42318;--ok:#1d7a46}
@media (prefers-color-scheme:dark){:root{--ink:#e8ece9;--muted:#9aa49e;--line:#2b3430;--bg:#0f1512;--card:#161e1a;--brand:#3cc2b6}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;justify-content:space-between;align-items:center;padding:12px 24px;border-bottom:1px solid var(--line);background:var(--card)}
header a{color:var(--ink);font-weight:700;text-decoration:none}main{max-width:1400px;margin:0 auto;padding:24px}
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

export function page(title, login, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${h(title)} · Freemeans editor</title><style>${CSS}</style></head><body>
<header><a href="/">Freemeans editor</a>${login ? `<form method="post" action="/logout" style="margin:0"><small>@${h(login)}</small> <button>Sign out</button></form>` : ''}</header>
<main>${body}</main></body></html>`;
}

const ago = (d) => {
  if (!d) return 'never';
  const hrs = Math.round((Date.now() - new Date(d).getTime()) / 3_600_000);
  return hrs < 48 ? `${hrs} h ago` : `${Math.round(hrs / 24)} days ago`;
};

export function queueView({ counts, items, stale, jobs, notice }) {
  const c = (k) => counts[k] ?? 0;
  const jobRows = ['signals', 'backfill', 'crawler'].map((name) => {
    const j = jobs.find((x) => x.job === name);
    return `<tr><td>${name}</td><td>${j ? ago(j.started_at) : 'never'}</td><td>${j ? (j.ok ? '✅ OK' : j.ok === false ? '<span class="bad">❌ not OK</span>' : 'running') : '–'}</td></tr>`;
  }).join('');
  const rows = items.map((r) => `<tr>
    <td><a href="/c/${r.id}">${h(r.draft?.name || r.name || r.domain)}</a><br><small>${h(r.domain)}</small></td>
    <td><span class="pill ${h(r.status)}">${h(r.status.replace('_', ' '))}</span></td>
    <td>${h(r.source)}${r.source === 'submit' && r.submitter_email ? '<br><small>has email</small>' : ''}</td>
    <td>${r.priority}</td>
    <td>${(r.flags || []).slice(0, 3).map((f) => `<span class="pill flag">${h(f.split(':')[0].replace('_', ' '))}</span>`).join('')}</td>
    <td><small>${h(new Date(r.created_at).toISOString().slice(0, 10))}</small></td></tr>`).join('');
  const staleRows = stale.map((t) => `<li><a href="https://freemeans.com/tools/${h(t.slug)}/">${h(t.name)}</a> <small>checked ${h(t.verified_at)}</small></li>`).join('');
  return `${notice ? `<div class="msg ${notice.ok ? 'ok' : 'bad'}">${notice.html}</div>` : ''}
<h1>Review queue</h1>
<div class="stats"><div class="card"><b>${c('drafted')}</b> drafted</div><div class="card"><b>${c('needs_manual')}</b> need manual work</div>
<div class="card"><b>${c('new')}</b> waiting for the crawler</div><div class="card"><b>${c('approved')}</b> approved</div><div class="card"><b>${c('rejected') + c('duplicate')}</b> rejected</div></div>
<table><thead><tr><th>Tool</th><th>Status</th><th>Source</th><th>Priority</th><th>Flags</th><th>Found</th></tr></thead>
<tbody>${rows || '<tr><td colspan="6" class="muted">The queue is empty.</td></tr>'}</tbody></table>
<div class="grid" style="margin-top:8px">
  <div><h2>Add a tool yourself</h2><form method="post" action="/seed" class="row" style="margin:0">
    <input type="url" name="url" required placeholder="https://example.ai"><input type="text" name="name" required placeholder="Name"><button>Add to queue</button></form>
    <small>The crawler drafts it on its next run (01:47 Pakistan time), or run the Crawler workflow by hand.</small></div>
  <div><h2>Jobs</h2><table><thead><tr><th>Job</th><th>Last run</th><th>Result</th></tr></thead><tbody>${jobRows}</tbody></table></div>
</div>
<h2>Free tiers not checked for 30+ days</h2>${staleRows ? `<ul>${staleRows}</ul>` : '<p class="muted">None. Every published free tier was checked in the last 30 days.</p>'}`;
}

export function reviewView({ cand, json, errors, notice, taxonomy }) {
  const ev = Object.entries(cand.evidence || {}).map(([k, v]) => `<b>${h(k)}</b><blockquote>${h(v)}</blockquote>`).join('');
  const flags = (cand.flags || []).map((f) => `<span class="pill flag">${h(f)}</span>`).join('');
  const reasons = [['duplicate', 'Duplicate'], ['dead_site', 'Dead site'], ['out_of_scope', 'Out of scope'], ['unsafe', 'Unsafe'], ['parked', 'Parked domain'], ['no_ai', 'Not an AI tool'], ['other', 'Other']];
  const raw = cand.draft?.url || cand.url;
  const site = /^https?:\/\//i.test(String(raw)) ? raw : null;
  const srcUrl = /^https?:\/\//i.test(String(cand.draft?.free_tier?.source_url)) ? cand.draft.free_tier.source_url : null;
  const done = cand.status === 'approved' || cand.status === 'rejected' || cand.status === 'duplicate';
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
