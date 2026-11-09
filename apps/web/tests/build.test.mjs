// Checks the built site in dist/ (run `npm run build` first; `npm test` does both).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const seed = JSON.parse(readFileSync(resolve(here, '../../../data/catalog/seed.json'), 'utf8'));
const read = (p) => readFileSync(resolve(dist, p), 'utf8');

test('home page carries the Freemeans brand', () => {
  const html = read('index.html');
  assert.match(html, /<title>Freemeans: free means you can build<\/title>/);
  assert.match(html, /Free means you can build\./);
  assert.match(html, /مفت کا مطلب/);
  assert.match(html, /aria-label="Freemeans"/);
  assert.match(html, /id="waitlist"/);
});

test('old brand names never appear in the built site', () => {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = resolve(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.(html|css|js|json|txt)$/.test(e.name)) files.push(p);
    }
  };
  walk(dist);
  for (const f of files) assert.doesNotMatch(readFileSync(f, 'utf8'), /zerostack|nilstack/i, f);
});

test('catalog page lists every resource', () => {
  const html = read('catalog/index.html');
  for (const r of seed.resources) assert.ok(html.includes(`/resources/${r.id}/`), r.id);
  assert.match(html, new RegExp(`${seed.resources.length} resources`));
});

test('one detail page per resource, with every limit value and source', () => {
  for (const r of seed.resources) {
    const file = resolve(dist, `resources/${r.id}/index.html`);
    assert.ok(existsSync(file), `missing page for ${r.id}`);
    const html = readFileSync(file, 'utf8');
    for (const l of r.limit_rules) {
      const unpublished = l.value === null || l.value === undefined || l.published === false;
      const v = unpublished ? 'Not published' : Number(l.value).toLocaleString('en-US');
      assert.ok(html.includes(v), `${r.id}: value ${v} not shown`);
      assert.ok(html.includes(l.source_url.replace(/&/g, '&amp;')), `${r.id}: source ${l.source_url} not linked`);
    }
  }
});

test('badges are explained on detail pages', () => {
  const gemini = read('resources/google.gemini-api-free/index.html');
  assert.match(gemini, /Trains on data/);
  assert.match(gemini, /EU-restricted/);
  assert.match(gemini, /18\+/);
  const colab = read('resources/google.colab-free/index.html');
  assert.match(colab, /Manual only/);
});

test('snapshot-sourced resources carry a warning; dates use the brand format', () => {
  const groq = read('resources/groq.gpt-oss-120b/index.html');
  assert.match(groq, /third-party snapshots/);
  assert.match(groq, /22 Oct 2026/);
});

test('catalog.json and sitemap.xml are published', () => {
  const json = JSON.parse(read('catalog.json'));
  assert.equal(json.resources.length, seed.resources.length);
  const xml = read('sitemap.xml');
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/);
  const locs = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  assert.equal(locs.length, seed.resources.length + 2);
  assert.ok(locs.every((u) => u.startsWith('https://freemeans.com/') && u.endsWith('/')));
  assert.equal(new Set(locs).size, locs.length, 'no duplicate URLs');
  assert.equal((xml.match(/<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/g) || []).length, locs.length);
  assert.match(read('robots.txt'), /^Sitemap: https:\/\/freemeans\.com\/sitemap\.xml$/m);
});

test('design tokens are generated for light and dark themes', () => {
  const cssDir = resolve(dist, '_astro');
  const css = readdirSync(cssDir).filter((f) => f.endsWith('.css')).map((f) => readFileSync(resolve(cssDir, f), 'utf8')).join('\n');
  assert.match(css, /--brand:\s*#0B6E69/i);
  assert.match(css, /--brand:\s*#3CC2B6/i);
  assert.match(css, /prefers-color-scheme:\s*dark/);
  assert.match(css, /Bricolage Grotesque/);
});

test('Cloudflare Pages files are in place', () => {
  assert.ok(existsSync(resolve(dist, '_headers')));
  assert.ok(existsSync(resolve(dist, '404.html')));
  assert.ok(existsSync(resolve(dist, 'favicon.svg')));
});

// ---------- SEO ----------
const htmlPages = () => {
  const out = [];
  const walk = (d, rel = '') => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(resolve(d, e.name), `${rel}${e.name}/`);
      else if (e.name === 'index.html') out.push({ path: `/${rel}`, html: readFileSync(resolve(d, e.name), 'utf8') });
    }
  };
  walk(dist);
  return out;
};
const meta = (html, re) => (html.match(re) || [])[1];

test('every indexable page is in sitemap.xml, and only those', () => {
  const locs = new Set([...read('sitemap.xml').matchAll(/<loc>https:\/\/freemeans\.com([^<]+)<\/loc>/g)].map((m) => m[1]));
  const pages = htmlPages().filter((p) => !/name="robots" content="noindex/.test(p.html)).map((p) => p.path);
  for (const p of pages) assert.ok(locs.has(p), `${p} is built but missing from sitemap.xml (add it in src/lib/seo.js)`);
  for (const l of locs) assert.ok(pages.includes(l), `${l} is in sitemap.xml but not built`);
});

test('every page has a unique title and description, one h1, canonical and social tags', () => {
  const titles = new Set();
  const descs = new Set();
  for (const { path, html } of htmlPages()) {
    const title = meta(html, /<title>([^<]+)<\/title>/);
    const desc = meta(html, /<meta name="description" content="([^"]+)"/);
    assert.ok(title && title.length <= 70, `${path}: title missing or over 70 chars (${title?.length})`);
    assert.ok(desc && desc.length >= 50 && desc.length <= 170, `${path}: description length ${desc?.length}`);
    assert.ok(!titles.has(title), `${path}: duplicate title`);
    assert.ok(!descs.has(desc), `${path}: duplicate description`);
    titles.add(title);
    descs.add(desc);
    assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, `${path}: needs exactly one h1`);
    assert.equal(meta(html, /<link rel="canonical" href="([^"]+)"/), `https://freemeans.com${path}`, `${path}: canonical`);
    assert.equal(meta(html, /<meta property="og:url" content="([^"]+)"/), `https://freemeans.com${path}`);
    assert.equal(meta(html, /<meta property="og:image" content="([^"]+)"/), 'https://freemeans.com/og.png');
    assert.match(html, /<meta name="twitter:card" content="summary_large_image"/);
    assert.match(html, /<html lang="en">/);
  }
});

test('structured data parses and matches each page type', () => {
  const ld = (path) => {
    const page = htmlPages().find((p) => p.path === path);
    const blocks = [...page.html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    assert.equal(blocks.length, 1, `${path}: one JSON-LD block`);
    const data = JSON.parse(blocks[0][1]);
    assert.equal(data['@context'], 'https://schema.org');
    return data['@graph'];
  };
  const types = (g) => g.map((n) => n['@type']);
  assert.deepEqual(types(ld('/')), ['Organization', 'WebSite', 'WebPage']);
  const cat = ld('/catalog/');
  assert.deepEqual(types(cat), ['CollectionPage', 'BreadcrumbList', 'ItemList']);
  assert.equal(cat[2].itemListElement.length, seed.resources.length);
  const res = ld('/resources/groq.gpt-oss-120b/');
  assert.deepEqual(types(res), ['WebPage', 'BreadcrumbList']);
  assert.equal(res[0].dateModified, '2026-10-22');
  assert.equal(res[1].itemListElement.at(-1).item, 'https://freemeans.com/resources/groq.gpt-oss-120b/');
});

test('404 stays out of search; share images and IndexNow key are published', () => {
  const nf = read('404.html');
  assert.match(nf, /<meta name="robots" content="noindex, follow"/);
  assert.doesNotMatch(nf, /rel="canonical"/);
  for (const f of ['og.png', 'logo-512.png', 'apple-touch-icon.png', 'favicon-32.png']) assert.ok(existsSync(resolve(dist, f)), f);
  const keys = readdirSync(dist).filter((f) => /^[0-9a-f]{32}\.txt$/.test(f));
  assert.equal(keys.length, 1);
  assert.equal(read(keys[0]), keys[0].replace('.txt', ''));
  assert.match(read('_headers'), /\/catalog\.json[\s\S]*X-Robots-Tag: noindex/);
});
