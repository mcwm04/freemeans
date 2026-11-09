// /tools/status.json: name, address and last-checked date of every published tool.
// Read by the editor console (stale list, duplicate check). Public facts only.
import { tools } from '../../lib/directory.js';

export function GET() {
  const list = tools().map((t) => ({ slug: t.slug, name: t.name, url: t.url, verified_at: t.free_tier.verified_at }));
  return new Response(JSON.stringify(list, null, 2), { headers: { 'content-type': 'application/json; charset=utf-8' } });
}
