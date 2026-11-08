// Cloudflare Workers entry point for api.freemeans.com.
// Free plan budget: 100,000 requests/day and 10 ms CPU per request. Database time is I/O,
// not CPU, so a Neon query does not eat the 10 ms.
import seed from '../../../data/catalog/seed.json' with { type: 'json' };
import { createApp } from './app.js';
import { seedStore, sqlStore, withFallback, neonQuery } from './store.js';

let cache; // one app per isolate, rebuilt only if the settings change

async function appFor(env) {
  const key = `${env.DATABASE_URL ? 'db' : 'seed'}|${env.SITE_URL}|${env.ALLOWED_ORIGINS}`;
  if (cache?.key === key) return cache.app;
  const fallback = seedStore(seed);
  const store = env.DATABASE_URL ? withFallback(sqlStore(await neonQuery(env.DATABASE_URL)), fallback) : fallback;
  const app = createApp({
    store,
    siteUrl: env.SITE_URL || 'https://freemeans.com',
    allowedOrigins: (env.ALLOWED_ORIGINS || 'https://freemeans.com').split(',').map((s) => s.trim()),
  });
  cache = { key, app };
  return app;
}

export default {
  async fetch(request, env) {
    const app = await appFor(env);
    return app(request);
  },
};
