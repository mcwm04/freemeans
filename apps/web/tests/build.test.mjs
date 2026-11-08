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

test('catalog.json and sitemap are published', () => {
  const json = JSON.parse(read('catalog.json'));
  assert.equal(json.resources.length, seed.resources.length);
  const sitemap = read('sitemap.txt').trim().split('\n');
  assert.equal(sitemap.length, seed.resources.length + 2);
  assert.ok(sitemap.every((u) => u.startsWith('https://freemeans.com/')));
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
