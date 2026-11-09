// Cloudflare Workers entry point for admin.freemeans.com (the editor console, M6).
// Secrets (npx wrangler secret put …): DATABASE_URL, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, SESSION_SECRET.
import { createAdmin } from './app.js';
import { githubOAuth } from './auth.js';
import { queueStore } from './db.js';

let cache;
let tools = { at: 0, list: [] };

async function siteTools(siteUrl) {
  if (Date.now() - tools.at < 5 * 60_000) return tools.list;
  const res = await fetch(`${siteUrl}/tools/status.json`, { cf: { cacheTtl: 120 } });
  if (!res.ok) throw new Error(`status.json answered ${res.status}`);
  tools = { at: Date.now(), list: await res.json() };
  return tools.list;
}

async function appFor(env) {
  if (cache) return cache;
  for (const k of ['DATABASE_URL', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'SESSION_SECRET']) {
    if (!env[k]) throw new Error(`Missing secret ${k}. Run: npx wrangler secret put ${k}`);
  }
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(env.DATABASE_URL);
  const siteUrl = env.SITE_URL || 'https://freemeans.com';
  cache = createAdmin({
    store: queueStore(async (text, params) => ({ rows: await sql.query(text, params) })),
    oauth: githubOAuth({ clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }),
    sessionSecret: env.SESSION_SECRET,
    adminUrl: env.ADMIN_URL || 'https://admin.freemeans.com',
    allowedUsers: (env.ALLOWED_GITHUB_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
    repo: env.GITHUB_REPO || 'mcwm04/freemeans',
    siteUrl,
    siteTools: () => siteTools(siteUrl),
  });
  return cache;
}

export default {
  async fetch(request, env) {
    try {
      return (await appFor(env))(request);
    } catch (e) {
      return new Response(`Editor console is not set up: ${e.message}`, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'x-robots-tag': 'noindex' } });
    }
  },
};
