// Plain-text sitemap (one URL per line), accepted by Google and Bing.
import { resources } from '../lib/catalog.js';

export function GET({ site }) {
  const base = String(site).replace(/\/$/, '');
  const urls = ['/', '/catalog/', ...resources().map((r) => `/resources/${r.id}/`)];
  return new Response(urls.map((u) => base + u).join('\n') + '\n', {
    headers: { 'content-type': 'text/plain; charset=utf-8' },
  });
}
