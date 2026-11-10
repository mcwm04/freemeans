// Request handling, kept free of Cloudflare-specific imports so tests run in plain Node.
import { parseFilters, filterResources, summarize } from './catalog.js';
import { parseSite, siteKey } from './domain.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY = 4096;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// Crawlers, link previews and scripts: redirected, never counted (PRD 3.5).
const BOT_UA = /bot|crawl|spider|slurp|preview|fetch|scan|monitor|headless|lighthouse|curl|wget|python|httpclient|okhttp|go-http|java\/|axios|node-fetch|facebookexternalhit|whatsapp|telegram|discord|slack|embedly|^$/i;

/**
 * links():  async () => Map<slug, url>  (published directory tools; see src/links.js)
 * dedupe:   { seen(key) => Promise<boolean> } marks a key and says whether it was already marked.
 * waitUntil: lets the click be written after the redirect is sent (the Worker's ctx.waitUntil
 *            is used when the request carries one).
 */
export function createApp({
  store, siteUrl = 'https://freemeans.com', allowedOrigins = [],
  links = async () => new Map(), dedupe = { seen: async () => false }, clickSalt = 'freemeans', waitUntil = (p) => p,
  verifyHuman = async () => true,
}) {
  const site = siteUrl.replace(/\/$/, '');

  const cors = (req) => {
    const origin = req.headers.get('origin');
    if (!origin || !(allowedOrigins.includes('*') || allowedOrigins.includes(origin))) return {};
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      vary: 'origin',
    };
  };

  const json = (req, status, body, extra = {}) =>
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: { 'content-type': 'application/json; charset=utf-8', ...cors(req), ...extra },
    });

  const cached = { 'cache-control': 'public, max-age=300' };

  async function readWaitlistBody(req) {
    const type = req.headers.get('content-type') || '';
    const text = await req.text();
    if (text.length > MAX_BODY) throw Object.assign(new Error('Request body is too large.'), { status: 413 });
    if (type.includes('application/json')) {
      try {
        return { data: JSON.parse(text || '{}'), form: false };
      } catch {
        throw Object.assign(new Error('Body is not valid JSON.'), { status: 400 });
      }
    }
    if (type.includes('application/x-www-form-urlencoded')) {
      return { data: Object.fromEntries(new URLSearchParams(text)), form: true };
    }
    throw Object.assign(new Error('Send JSON or a form.'), { status: 415 });
  }

  // M5: "Submit a tool". The entry goes into the editor's review queue (tool_candidates);
  // nothing is published without review. Same answer whether the site was new or already queued.
  async function submit(req) {
    const { data, form } = await readWaitlistBody(req);
    const back = (q) => new Response(null, { status: 303, headers: { location: `${site}/tools/submit/?${q}#form` } });
    const fail = (code, message, status = 400) => (form ? back(`error=${code}`) : json(req, status, { error: message, code }));
    const ok = (status) => (form ? back(status === 'listed' ? 'status=listed' : 'sent=1') : json(req, 200, { ok: true, status }));

    if (data.website) return ok('queued'); // honeypot: bots fill the hidden field
    const ip = req.headers.get('cf-connecting-ip') || '';
    if (!(await verifyHuman(String(data['cf-turnstile-response'] ?? ''), ip))) {
      return fail('check', 'The anti-spam check failed. Reload the page and try again.', 403);
    }
    const u = parseSite(data.url);
    if (!u) return fail('url', 'Please enter the tool’s public web address, for example https://example.ai.');
    const name = String(data.name ?? '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (name.length < 2) return fail('name', 'Please enter the tool’s name.');
    const category = String(data.category ?? '').toLowerCase();
    const email = String(data.email ?? '').trim().toLowerCase();
    if (email && (!EMAIL.test(email) || email.length > 254)) return fail('email', 'Please enter a valid email address, or leave it empty.');

    const key = siteKey(u.href);
    const listed = [...(await links()).values()].some((url) => siteKey(url) === key);
    if (listed) return ok('listed');
    u.hash = '';
    for (const p of [...u.searchParams.keys()]) if (/^(utm_|ref$|fbclid$|gclid$)/i.test(p)) u.searchParams.delete(p);
    await store.addCandidate({
      url: u.href, domain: key, source: 'submit', name,
      category: /^[a-z0-9-]{1,40}$/.test(category) ? category : null,
      email: email || null, priority: 40,
    });
    return ok('queued');
  }

  async function waitlist(req) {
    const { data, form } = await readWaitlistBody(req);
    const done = () =>
      form
        ? new Response(null, { status: 303, headers: { location: `${site}/?joined=1#waitlist` } })
        : json(req, 200, { ok: true });

    // Honeypot: bots fill the hidden "website" field. Answer as if it worked, store nothing.
    if (data.website) return done();

    const email = String(data.email ?? '').trim().toLowerCase();
    if (!EMAIL.test(email) || email.length > 254) return json(req, 400, { error: 'Please enter a valid email address.' });
    const consent = data.consent === true || data.consent === 'true' || data.consent === 'on';
    if (!consent) return json(req, 400, { error: 'Please tick the box to agree to beta emails.' });
    const source = String(data.source ?? 'web').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'web';
    const country = (req.headers.get('cf-ipcountry') || '').slice(0, 2).toUpperCase() || null;

    await store.addToWaitlist({ email, source, country });
    // Same answer for new and existing emails, so the form can't be used to test who signed up.
    return done();
  }

  // M4: /go/{slug} counts one outbound click, then redirects to the tool's site.
  // Stored per tool, UTC day and country only. Repeat clicks by one visitor on one day count
  // once: the check uses a salted hash of IP and browser that is never written to the database.
  async function go(req, slug, ctx) {
    const map = await links();
    const target = map.get(slug);
    if (!target) return new Response(null, { status: 302, headers: { location: `${site}/tools/`, 'cache-control': 'no-store' } });
    const redirect = new Response(null, {
      status: 302,
      headers: { location: target, 'cache-control': 'no-store', 'referrer-policy': 'strict-origin-when-cross-origin' },
    });
    if (req.method !== 'GET' || !countable(req)) return redirect;

    const day = new Date().toISOString().slice(0, 10);
    const country = /^[A-Z0-9]{2}$/.test(req.headers.get('cf-ipcountry') || '') ? req.headers.get('cf-ipcountry') : 'XX';
    const visitor = `${req.headers.get('cf-connecting-ip') || ''}|${req.headers.get('user-agent') || ''}`;
    const key = await sha256(`${clickSalt}|${day}|${slug}|${visitor}`);
    const later = ctx?.waitUntil ? ctx.waitUntil.bind(ctx) : waitUntil;
    later(
      (async () => {
        if (await dedupe.seen(key)) return;
        await store.addClick({ slug, day, country });
      })().catch(() => {}), // a lost click must never break the redirect
    );
    return redirect;
  }

  async function handle(req, ctx) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });

    if (req.method === 'GET' && (path === '/' || path === '/health')) {
      const { version, fallback } = await store.listResources();
      return json(req, 200, { ok: true, service: 'freemeans-api', store: fallback ? 'seed (fallback)' : store.kind, catalog_version: version });
    }

    if (req.method === 'GET' && path === '/catalog') {
      const filters = parseFilters(url.searchParams);
      const { version, resources, fallback } = await store.listResources();
      const list = filterResources(resources, filters);
      const extra = fallback ? { ...cached, 'x-freemeans-fallback': 'seed' } : cached;
      return json(
        req,
        200,
        { version, count: list.length, resources: filters.full ? list : list.map((r) => summarize(r, site)) },
        extra,
      );
    }

    const g = /^\/go\/([^/]+)$/.exec(path);
    if (g) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, 405, { error: 'Use GET.' }, { allow: 'GET, HEAD' });
      const slug = decodeURIComponent(g[1]).toLowerCase();
      if (!SLUG.test(slug)) return json(req, 404, { error: 'Unknown tool.' });
      return go(req, slug, ctx);
    }

    const m = /^\/resources\/([a-z0-9.-]+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const r = await store.getResource(m[1]);
      if (!r) return json(req, 404, { error: `No resource with id ${m[1]}.` });
      return json(req, 200, { ...r, url: `${site}/resources/${r.id}/` }, cached);
    }

    if (path === '/submit') {
      if (req.method !== 'POST') return json(req, 405, { error: 'Use POST.' }, { allow: 'POST, OPTIONS' });
      return submit(req);
    }

    if (path === '/waitlist') {
      if (req.method !== 'POST') return json(req, 405, { error: 'Use POST.' }, { allow: 'POST, OPTIONS' });
      return waitlist(req);
    }

    return json(req, 404, { error: 'Not found. Try /catalog, /resources/{id} or /go/{tool}.' });
  }

  // The API is for programs, not search results: every answer carries noindex.
  const noindex = (res) => {
    res.headers.set('x-robots-tag', 'noindex, nofollow');
    return res;
  };

  return async (req, ctx) => {
    try {
      return noindex(await handle(req, ctx));
    } catch (err) {
      const status = err.status ?? 500;
      return noindex(json(req, status, { error: status === 500 ? 'Something went wrong on our side.' : err.message }));
    }
  };
}

function countable(req) {
  const ua = req.headers.get('user-agent') || '';
  if (BOT_UA.test(ua)) return false;
  if (req.cf?.verifiedBotCategory) return false;
  const purpose = (req.headers.get('sec-purpose') || req.headers.get('purpose') || '').toLowerCase();
  return !purpose.includes('prefetch') && !purpose.includes('prerender');
}

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
