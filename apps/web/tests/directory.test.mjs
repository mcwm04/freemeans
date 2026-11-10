// Checks the built AI tools directory in dist/tools/ (PRD Chapter 3: M1, M2, M3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const data = resolve(here, '../../../data');
const taxonomy = JSON.parse(readFileSync(resolve(data, 'taxonomy.json'), 'utf8'));
const tools = readdirSync(resolve(data, 'tools')).filter((f) => f.endsWith('.json'))
  .map((f) => JSON.parse(readFileSync(resolve(data, 'tools', f), 'utf8'))).filter((t) => t.status === 'published');
const read = (p) => readFileSync(resolve(dist, p), 'utf8');
const esc = (s) => s.replace(/&/g, '&amp;').replace(/'/g, '&#39;').replace(/"/g, '&quot;');
const ld = (html) => JSON.parse(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html)[1])['@graph'];

test('M1: one page per published tool, with the free tier card, source and date', () => {
  for (const t of tools) {
    const html = read(`tools/${t.slug}/index.html`);
    assert.match(html, /<h2 id="free">Free tier<\/h2>/, t.slug);
    assert.ok(html.includes(esc(t.free_tier.source_url)), `${t.slug}: source link missing`);
    const [y, m, d] = t.free_tier.verified_at.split('-').map(Number);
    const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1];
    assert.ok(html.includes(`${d} ${month} ${y}`), `${t.slug}: verified date missing`);
    assert.ok(html.includes(esc(t.description)), `${t.slug}: description missing`);
  }
});

test('M1/M4: the Visit button goes through /go/ for click counting, never straight to the vendor', () => {
  for (const t of tools) {
    const html = read(`tools/${t.slug}/index.html`);
    const visit = /<a class="btn" href="([^"]+)" rel="([^"]+)">Visit/.exec(html);
    assert.ok(visit, `${t.slug}: no Visit button`);
    assert.equal(visit[1], `https://api.freemeans.com/go/${t.slug}`);
    assert.equal(visit[2], t.affiliate_url || t.sponsor ? 'sponsored noopener' : 'nofollow noopener');
  }
});

test('M1: SoftwareApplication structured data and breadcrumbs on tool pages', () => {
  for (const t of tools) {
    const g = ld(read(`tools/${t.slug}/index.html`));
    assert.deepEqual(g.map((n) => n['@type']), ['WebPage', 'BreadcrumbList']);
    assert.equal(g[0].about['@type'], 'SoftwareApplication');
    assert.equal(g[0].about.name, t.name);
    assert.equal(g[0].about.url, t.url);
    assert.ok(!('aggregateRating' in g[0].about), 'no ratings without real user reviews (SEO guide 6.2)');
    assert.equal(g[1].itemListElement[1].item, 'https://freemeans.com/tools/');
  }
});

test('M1: tool pages stay small (under 150 KB of HTML)', () => {
  for (const t of tools) {
    const size = statSync(resolve(dist, `tools/${t.slug}/index.html`)).size;
    assert.ok(size < 150_000, `${t.slug}: ${size} bytes`);
  }
});

test('M2: directory home lists every tool and every live category', () => {
  const html = read('tools/index.html');
  for (const t of tools) assert.ok(html.includes(`href="/tools/${t.slug}/"`), t.slug);
  const live = taxonomy.categories.filter((c) => tools.some((t) => t.categories.includes(c.id)));
  for (const c of live) assert.ok(html.includes(`href="/tools/c/${c.id}/"`), c.id);
  assert.deepEqual(ld(html).map((n) => n['@type']), ['CollectionPage', 'BreadcrumbList', 'ItemList']);
});

test('M2: category and task pages exist for live ones only, and thin ones are noindex', () => {
  for (const c of taxonomy.categories) {
    const n = tools.filter((t) => t.categories.includes(c.id)).length;
    const file = resolve(dist, `tools/c/${c.id}/index.html`);
    assert.equal(existsSync(file), n > 0, `category ${c.id}`);
    if (n > 0) assert.equal(/content="noindex/.test(readFileSync(file, 'utf8')), n < 5, `category ${c.id} index rule`);
  }
  for (const k of taxonomy.tasks) {
    const n = tools.filter((t) => t.tasks.includes(k.id)).length;
    assert.equal(existsSync(resolve(dist, `tools/t/${k.id}/index.html`)), n > 0, `task ${k.id}`);
  }
});

test('M2: filter cards carry the flags the in-page filters read', () => {
  const html = read('tools/index.html');
  for (const t of tools) {
    const card = new RegExp(`<li class="card tool-card"[^>]*data-flags="([^"]*)"[^>]*>[\\s\\S]*?href="/tools/${t.slug}/"`).exec(html);
    assert.ok(card, `${t.slug}: card`);
    const flags = card[1].split(' ');
    assert.equal(flags.includes('oss'), t.open_source === true, `${t.slug}: oss flag`);
    assert.equal(flags.includes('nocard'), t.free_tier.card_required === false, `${t.slug}: nocard flag`);
  }
});

test('M2: the static search index covers tool pages only', () => {
  assert.ok(existsSync(resolve(dist, 'pagefind/pagefind.js')), 'run pagefind after astro build');
  for (const t of tools) assert.match(read(`tools/${t.slug}/index.html`), /data-pagefind-body/);
  assert.doesNotMatch(read('catalog/index.html'), /data-pagefind-body/);
});

test('sitemap lists the directory home and every tool page', () => {
  const xml = read('sitemap.xml');
  assert.ok(xml.includes('<loc>https://freemeans.com/tools/</loc>'));
  for (const t of tools) assert.ok(xml.includes(`<loc>https://freemeans.com/tools/${t.slug}/</loc>`), t.slug);
});

test('the main menu links to the directory', () => {
  assert.match(read('index.html'), /<a href="\/tools\/"[^>]*>AI tools<\/a>/);
});

test('M5: submit page posts to the API, works without JavaScript, lists every category', () => {
  const html = read('tools/submit/index.html');
  assert.match(html, /<form[^>]+method="post"[^>]+action="https:\/\/api\.freemeans\.com\/submit"/);
  assert.match(html, /name="website"/, 'honeypot');
  for (const c of taxonomy.categories) assert.ok(html.includes(`value="${c.id}"`), c.id);
  assert.match(read('tools/index.html'), /href="\/tools\/submit\/"/);
});
