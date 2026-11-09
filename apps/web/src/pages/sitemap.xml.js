// XML sitemap with <lastmod>, the format Google and Bing read best.
// lastmod is the date a page's data was last checked, so search engines recrawl only what changed.
import { sitemapEntries } from '../lib/seo.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');

export function GET({ site }) {
  const rows = sitemapEntries()
    .map(({ path, lastmod }) => `  <url><loc>${esc(new URL(path, site).href)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`)
    .join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${rows}\n</urlset>\n`;
  return new Response(xml, { headers: { 'content-type': 'application/xml; charset=utf-8' } });
}
