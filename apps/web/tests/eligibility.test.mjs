// "Free for who you are" pages (Eligibility PRD, M4). Run after `npm run build` (npm test does both).
// Expected lists come from the same data file through the same lib, with today's date, so the
// tests keep passing as offers pass their claim-by dates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allOffers, liveOffers, offersFor, endingSoon, myths, effectiveStatus, countryAllows, groupOf,
  GROUPS, COUNTRY_PAGES, MIN_OFFERS_TO_INDEX,
} from '../src/lib/eligibility.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const page = (path) => readFileSync(resolve(dist, path.replace(/^\//, ''), 'index.html'), 'utf8');
const has = (path) => existsSync(resolve(dist, path.replace(/^\//, ''), 'index.html'));
const sitemap = () => new Set([...readFileSync(resolve(dist, 'sitemap.xml'), 'utf8').matchAll(/<loc>https:\/\/freemeans\.com([^<]+)<\/loc>/g)].map((m) => m[1]));
const noindex = (html) => /name="robots" content="noindex/.test(html);
const ldGraph = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];

// ---------- rules (no build needed) ----------

test('status at read time: the last day to claim still counts, the day after does not', () => {
  const o = { status: 'active', offer_window: { redeem_by: '2026-12-31' } };
  assert.equal(effectiveStatus(o, '2026-12-31'), 'active');
  assert.equal(effectiveStatus(o, '2027-01-01'), 'ended');
  assert.equal(effectiveStatus({ offer_window: { access_ends: '2027-06-30' } }, '2027-07-01'), 'ended');
  assert.equal(effectiveStatus({ status: 'unverified', offer_window: { redeem_by: '2099-01-01' } }, '2026-11-11'), 'unverified');
});

test('country rules: global, include, exclude, and records with no rule', () => {
  const rec = (countries) => ({ eligibility: { countries } });
  assert.ok(countryAllows(rec({ mode: 'global' }), 'PK'));
  assert.ok(countryAllows(rec({ mode: 'include', codes: ['PK'] }), 'PK'));
  assert.ok(!countryAllows(rec({ mode: 'include', codes: ['US'] }), 'PK'));
  assert.ok(!countryAllows(rec({ mode: 'exclude', codes: ['PK'] }), 'PK'));
  assert.ok(countryAllows(rec({ mode: 'exclude', codes: ['US'] }), 'PK'));
  assert.ok(countryAllows({}, 'PK'), 'API free tiers are open everywhere');
});

test('ending soon: only live offers with a claim-by date inside the window, soonest first', () => {
  const soon = endingSoon(60, '2026-11-11').map((r) => r.id);
  assert.ok(soon.includes('google.ai-pro-student-us'));
  assert.deepEqual(endingSoon(10, '2026-11-11'), []);
  assert.deepEqual(endingSoon(60, '2027-02-01'), [], 'already past');
  assert.ok(!soon.includes('google.ai-plus-student'), 'unverified offers are never listed');
});

// ---------- built pages ----------

test('every live offer has a page with the "Who can get this" box; unverified and ended ones have none', () => {
  for (const r of liveOffers()) {
    const html = page(`/resources/${r.id}/`);
    assert.match(html, /id="who-can-get"/, r.id);
    assert.match(html, /Checked on/, r.id);
  }
  for (const r of allOffers().filter((x) => effectiveStatus(x) !== 'active')) {
    assert.ok(!has(`/resources/${r.id}/`), `${r.id} must not have a live page`);
  }
});

test('unverified offers are linked from no eligibility page', () => {
  const unverified = allOffers().filter((r) => effectiveStatus(r) === 'unverified').map((r) => r.id);
  assert.ok(unverified.length > 0);
  const paths = ['/free-for/', '/free-for/ending-soon/', '/free-for/myths/', '/in/pakistan/',
    ...Object.keys(GROUPS).flatMap((g) => [`/free-for/${g}/`, ...Object.keys(COUNTRY_PAGES).map((c) => `/free-for/${g}/${c}/`)])];
  for (const p of paths) {
    const html = page(p);
    for (const id of unverified) assert.ok(!html.includes(`/resources/${id}/`), `${p} links to unverified ${id}`);
  }
});

test('audience and country pages: thin pages are noindex and out of the sitemap, others are indexed', () => {
  const sm = sitemap();
  for (const g of Object.keys(GROUPS)) {
    const checks = [{ path: `/free-for/${g}/`, n: offersFor({ group: g }).length }];
    for (const [slug, c] of Object.entries(COUNTRY_PAGES)) checks.push({ path: `/free-for/${g}/${slug}/`, n: offersFor({ group: g, country: c.code }).length });
    for (const { path, n } of checks) {
      const html = page(path);
      const thin = n < MIN_OFFERS_TO_INDEX;
      assert.equal(noindex(html), thin, `${path}: ${n} offers`);
      assert.equal(sm.has(path), !thin, `${path}: sitemap`);
      assert.equal((html.match(/class="card res-card offer-card"/g) || []).length, n, `${path}: card count`);
    }
  }
});

test('students in Pakistan: global offers are in, offers that exclude Pakistan are out', () => {
  const html = page('/free-for/students/pakistan/');
  assert.ok(html.includes('/resources/github.copilot-student/'));
  const outside = liveOffers().filter((r) => groupOf(r).includes('students') && !countryAllows(r, 'PK'));
  assert.ok(outside.length > 0, 'test needs at least one student offer that excludes Pakistan');
  for (const r of outside) assert.ok(!html.includes(`/resources/${r.id}/`), r.id);
});

test('country hub lists every offer usable from Pakistan, plus the API free tiers', () => {
  const html = page('/in/pakistan/');
  for (const r of liveOffers().filter((x) => countryAllows(x, 'PK'))) assert.ok(html.includes(`/resources/${r.id}/`), r.id);
  assert.ok(html.includes('/resources/groq.gpt-oss-120b/'));
  assert.ok(sitemap().has('/in/pakistan/'));
});

test('offers that charge after the free period carry the red badge on cards and pages', () => {
  const renewing = liveOffers().filter((r) => r.offer_window?.after?.auto_renews);
  for (const r of renewing) {
    assert.match(page(`/resources/${r.id}/`), /Charges after free period/, r.id);
    const card = page('/free-for/students/').split('<li class="card res-card offer-card">').slice(1).find((c) => c.includes(`/resources/${r.id}/`));
    if (card) assert.match(card, /Charges after free period/, `${r.id}: card`);
  }
});

test('ending-soon and myths pages match their lists', () => {
  const soon = endingSoon();
  const html = page('/free-for/ending-soon/');
  assert.equal(noindex(html), soon.length === 0);
  for (const r of soon) assert.ok(html.includes(`/resources/${r.id}/`), r.id);
  const m = page('/free-for/myths/');
  for (const r of myths()) assert.ok(m.includes(`id="${r.id}"`), r.id);
  const replaced = myths().find((r) => r.replaced_by && effectiveStatus(allOffers().find((x) => x.id === r.replaced_by)) === 'active');
  if (replaced) assert.ok(m.includes(`/resources/${replaced.replaced_by}/`));
});

test('hub: the checker has its data and a no-JavaScript fallback; the hub is in the sitemap', () => {
  const html = page('/free-for/');
  const data = JSON.parse(html.match(/<script type="application\/json" id="offers-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.length, liveOffers().length);
  assert.match(html, /<noscript>/);
  for (const g of Object.keys(GROUPS)) assert.ok(html.includes(`/free-for/${g}/`), g);
  assert.ok(sitemap().has('/free-for/'));
});

test('structured data: offer pages carry a free Offer with region and end date; audience pages name the audience', () => {
  const offer = allOffers().find((r) => effectiveStatus(r) === 'active' && r.eligibility.countries.mode === 'include' && r.offer_window?.redeem_by);
  assert.ok(offer, 'test needs a live offer with an include rule and a claim-by date');
  const g = ldGraph(page(`/resources/${offer.id}/`));
  assert.deepEqual(g.map((n) => n['@type']), ['WebPage', 'BreadcrumbList']);
  const o = g[0].about.offers;
  assert.equal(o.price, '0');
  assert.equal(o.availabilityEnds, offer.offer_window.redeem_by);
  assert.deepEqual(o.eligibleRegion.map((c) => c['@type']), offer.eligibility.countries.codes.map(() => 'Country'));
  assert.equal(g[1].itemListElement.at(-1).item, `https://freemeans.com/resources/${offer.id}/`);

  const s = ldGraph(page('/free-for/students/'));
  assert.deepEqual(s.map((n) => n['@type']), ['CollectionPage', 'BreadcrumbList', 'ItemList']);
  assert.deepEqual(s[0].audience, { '@type': 'EducationalAudience', educationalRole: 'student' });
  assert.equal(s[2].itemListElement.length, offersFor({ group: 'students' }).length);
  assert.deepEqual(ldGraph(page('/free-for/teachers/'))[0].audience.educationalRole, 'teacher');
});

test('page titles carry the month and year', () => {
  assert.match(page('/free-for/students/pakistan/'), /<title>Free tools for students in Pakistan \([A-Z][a-z]+ \d{4}\) · Freemeans<\/title>/);
});
