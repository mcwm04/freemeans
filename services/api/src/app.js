// Request handling, kept free of Cloudflare-specific imports so tests run in plain Node.
import { parseFilters, filterResources, summarize } from './catalog.js';

const EMAIL = /^[^\s@]{1,64}@[^\s@]+\.[^\s@]{2,}$/;
const MAX_BODY = 4096;

export function createApp({ store, siteUrl = 'https://freemeans.com', allowedOrigins = [] }) {
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

  async function handle(req) {
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

    const m = /^\/resources\/([a-z0-9.-]+)$/.exec(path);
    if (req.method === 'GET' && m) {
      const r = await store.getResource(m[1]);
      if (!r) return json(req, 404, { error: `No resource with id ${m[1]}.` });
      return json(req, 200, { ...r, url: `${site}/resources/${r.id}/` }, cached);
    }

    if (path === '/waitlist') {
      if (req.method !== 'POST') return json(req, 405, { error: 'Use POST.' }, { allow: 'POST, OPTIONS' });
      return waitlist(req);
    }

    return json(req, 404, { error: 'Not found. Try /catalog or /resources/{id}.' });
  }

  // The API is for programs, not search results: every answer carries noindex.
  const noindex = (res) => {
    res.headers.set('x-robots-tag', 'noindex, nofollow');
    return res;
  };

  return async (req) => {
    try {
      return noindex(await handle(req));
    } catch (err) {
      const status = err.status ?? 500;
      return noindex(json(req, status, { error: status === 500 ? 'Something went wrong on our side.' : err.message }));
    }
  };
}
