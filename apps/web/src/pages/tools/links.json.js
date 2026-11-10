// /tools/links.json: { slug: destination } for every published tool. Read by the API's
// /go/{slug} redirect (services/api/src/links.js), so new tools work as soon as the site rebuilds.
import { tools } from '../../lib/directory.js';

export function GET() {
  const links = Object.fromEntries(tools().map((t) => [t.slug, t.affiliate_url || t.url]));
  return new Response(JSON.stringify(links, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
