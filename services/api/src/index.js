// Cloudflare Workers entry point for api.freemeans.com.
// Free plan budget: 100,000 requests/day and 10 ms CPU per request. Database time is I/O,
// not CPU, so a Neon query does not eat the 10 ms.
import seed from '../../../data/catalog/seed.json' with { type: 'json' };
import eligibility from '../../../data/catalog/eligibility.json' with { type: 'json' };
import { createApp } from './app.js';
import { seedStore, sqlStore, withFallback, neonQuery } from './store.js';
import { linkSource, cacheDedupe } from './links.js';

// Cloudflare Turnstile server-side check: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
export function turnstile(secret, fetcher = fetch) {
  return async (token, ip) => {
    if (!token) return false;
    const body = new URLSearchParams({ secret, response: token });
    if (ip) body.set('remoteip', ip);
    try {
      const res = await fetcher('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body });
      return (await res.json()).success === true;
    } catch {
      return false;
    }
  };
}

// Same merge as db/scripts/lib.mjs, so the bundled copy matches what Neon holds.
const bundled = {
  version: `${seed.version}+${eligibility.version}`,
  resources: [...seed.resources, ...eligibility.resources],
};

let cache; // one app per isolate, rebuilt only if the settings change

async function appFor(env) {
  const key = `${env.DATABASE_URL ? 'db' : 'seed'}|${env.SITE_URL}|${env.ALLOWED_ORIGINS}|${env.TURNSTILE_SECRET ? 't' : ''}`;
  if (cache?.key === key) return cache.app;
  const fallback = seedStore(bundled);
  const store = env.DATABASE_URL ? withFallback(sqlStore(await neonQuery(env.DATABASE_URL)), fallback) : fallback;
  const siteUrl = env.SITE_URL || 'https://freemeans.com';
  const app = createApp({
    store,
    siteUrl,
    allowedOrigins: (env.ALLOWED_ORIGINS || 'https://freemeans.com').split(',').map((s) => s.trim()),
    links: linkSource({ siteUrl }),
    dedupe: typeof caches !== 'undefined' ? cacheDedupe(caches.default) : undefined,
    // Optional secret: npx wrangler secret put CLICK_SALT (any long random text).
    clickSalt: env.CLICK_SALT || 'freemeans-clicks',
    // M5 spam check. Without the secret the form still works but has only the honeypot.
    verifyHuman: env.TURNSTILE_SECRET ? turnstile(env.TURNSTILE_SECRET) : undefined,
  });
  cache = { key, app };
  return app;
}

export default {
  async fetch(request, env, ctx) {
    const app = await appFor(env);
    return app(request, ctx);
  },
};
