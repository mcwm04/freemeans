// Writes src/links.generated.json: { slug: destination URL } for every published directory tool.
// /go/{slug} uses it when the live map on freemeans.com/tools/links.json cannot be read.
// Runs automatically before `wrangler deploy` and `wrangler dev` ([build] in wrangler.toml)
// and before the tests. The output is not committed.
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dir = resolve(here, '../../../data/tools');
const links = {};
if (existsSync(dir)) {
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    const t = JSON.parse(readFileSync(resolve(dir, f), 'utf8'));
    if (t.status === 'published') links[t.slug] = t.affiliate_url || t.url;
  }
}
writeFileSync(resolve(here, '../src/links.generated.json'), JSON.stringify(links, null, 2) + '\n');
console.log(`links.generated.json: ${Object.keys(links).length} tool(s)`);
