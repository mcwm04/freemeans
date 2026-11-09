// The slug → URL map behind /go/{slug}.
// 1. The live map the website publishes at https://freemeans.com/tools/links.json, so a new
//    tool works as soon as the site rebuilds (no API deploy needed). Cached 10 minutes.
// 2. If that cannot be read, the copy bundled at deploy time (links.generated.json).
import bundled from './links.generated.json' with { type: 'json' };

const TTL_MS = 10 * 60 * 1000;

export function linkSource({ siteUrl, fetcher = fetch, now = () => Date.now() }) {
  let cache = null;
  const fallback = new Map(Object.entries(bundled));
  return async function links() {
    if (cache && now() - cache.at < TTL_MS) return cache.map;
    try {
      const res = await fetcher(`${siteUrl.replace(/\/$/, '')}/tools/links.json`, { cf: { cacheTtl: 300 } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const map = new Map(Object.entries(data).filter(([k, v]) => typeof v === 'string' && /^https:\/\//.test(v)));
      // Keep bundled entries the live map does not have yet (should not happen, but never lose a link).
      for (const [k, v] of fallback) if (!map.has(k)) map.set(k, v);
      cache = { at: now(), map };
      return map;
    } catch {
      cache = { at: now() - TTL_MS + 60_000, map: fallback }; // retry the live map in 1 minute
      return fallback;
    }
  };
}

// Repeat-click check in the Cloudflare cache of the data centre that served the click.
// Keys are salted hashes, expire after 24 hours, and never reach the database.
export function cacheDedupe(cache) {
  return {
    async seen(key) {
      const url = `https://dedupe.freemeans.internal/${key}`;
      if (await cache.match(url)) return true;
      await cache.put(url, new Response('1', { headers: { 'cache-control': 'max-age=86400' } }));
      return false;
    },
  };
}
