// Free courses and certificates: /learn/ pages (Eligibility PRD, chapter 11, module L4).
// Run after `npm run build` (npm test does both). Expected lists come from the data through the same
// lib, with today's date, so the tests keep passing as courses change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allOffers, effectiveStatus, countryAllows, MIN_OFFERS_TO_INDEX } from '../src/lib/eligibility.js';
import { allCourses, liveCourses, coursesFor, hasFreeCertificate, certificateCostsMoney, learningFacts } from '../src/lib/learning.js';

const here = dirname(fileURLToPath(import.meta.url));
const dist = resolve(here, '../dist');
const page = (path) => readFileSync(resolve(dist, path.replace(/^\//, ''), 'index.html'), 'utf8');
const has = (path) => existsSync(resolve(dist, path.replace(/^\//, ''), 'index.html'));
const sitemap = () => new Set([...readFileSync(resolve(dist, 'sitemap.xml'), 'utf8').matchAll(/<loc>https:\/\/freemeans\.com([^<]+)<\/loc>/g)].map((m) => m[1]));
const noindex = (html) => /name="robots" content="noindex/.test(html);
const ldGraph = (html) => JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1])['@graph'];
// The cards of one <section id="h-..."> (the id marks the heading).
const section = (html, id) => {
  const start = html.indexOf(`id="${id}"`);
  assert.ok(start > -1, `section ${id} exists`);
  const end = html.indexOf('</section>', start);
  return html.slice(start, end);
};
const linked = (html) => new Set([...html.matchAll(/href="\/resources\/([^/"]+)\/"/g)].map((m) => m[1]));

test('courses: each id once, unverified ones are not live, free certificate is not a badge', () => {
  const ids = allCourses().map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('digiskills.dstp3') && ids.includes('ibm.skillsbuild'), 'both files are read');
  const live = liveCourses().map((r) => r.id);
  assert.ok(!live.includes('vu.netacad'));
  assert.ok(liveCourses().every((r) => r.learning), 'every live course has a learning block');
  assert.ok(hasFreeCertificate({ learning: { certificate: 'free' } }));
  assert.ok(!hasFreeCertificate({ learning: { certificate: 'none', credential: 'badge' } }));
  assert.ok(certificateCostsMoney({ learning: { certificate: 'paid_optional' } }) && certificateCostsMoney({ learning: { certificate: 'paid_required' } }));
  assert.deepEqual(learningFacts({ learning: { format: 'self_paced', certificate: 'free', languages: ['ur'], roles: ['data-analyst'] } }).roles, ['Data Analyst']);
});

test('/learn/ lists every live course once, in three honest sections', () => {
  const html = page('/learn/');
  const live = liveCourses();
  assert.equal((html.match(/class="card res-card offer-card"/g) || []).length, live.length);
  for (const r of live) assert.ok(linked(html).has(r.id), r.id);
  assert.deepEqual([...linked(section(html, 'h-free'))].sort(), live.filter(hasFreeCertificate).map((r) => r.id).sort());
  const costs = section(html, 'h-costs');
  assert.deepEqual([...linked(costs)].sort(), live.filter(certificateCostsMoney).map((r) => r.id).sort());
  const badge = section(html, 'h-badge');
  for (const r of live.filter((x) => !hasFreeCertificate(x) && !certificateCostsMoney(x))) assert.ok(linked(badge).has(r.id), r.id);
  assert.match(html, /<h1[^>]*>Free online courses and certificates<\/h1>/);
});

test('/learn/certificates/: the free list holds only free certificates, the trap list shows the price', () => {
  const html = page('/learn/certificates/');
  const live = liveCourses();
  const free = linked(section(html, 'h-free'));
  assert.deepEqual([...free].sort(), live.filter(hasFreeCertificate).map((r) => r.id).sort());
  for (const r of live.filter((x) => !hasFreeCertificate(x))) assert.ok(!free.has(r.id), `${r.id} must not be in the free-certificate list`);
  const costs = section(html, 'h-costs');
  for (const r of live.filter(certificateCostsMoney)) {
    assert.ok(linked(costs).has(r.id), r.id);
    assert.match(costs, /Certificate costs money/, 'the cost is stated on the card');
  }
});

test('/learn/pakistan/ lists the courses open to Pakistan, programs made for it first', () => {
  const html = page('/learn/pakistan/');
  const here = coursesFor({ country: 'PK' });
  assert.deepEqual([...linked(html)].sort(), here.map((r) => r.id).sort());
  const madeFor = linked(section(html, 'h-local'));
  assert.ok(madeFor.has('digiskills.dstp3'));
  assert.ok(!madeFor.has('ibm.skillsbuild'));
  for (const r of liveCourses().filter((x) => !countryAllows(x, 'PK'))) assert.ok(!linked(html).has(r.id), r.id);
});

test('indexing follows the thin-page rule and the sitemap agrees', () => {
  const sm = sitemap();
  const live = liveCourses();
  const checks = [
    ['/learn/', live.length],
    ['/learn/certificates/', live.filter(hasFreeCertificate).length],
    ['/learn/pakistan/', coursesFor({ country: 'PK' }).length],
  ];
  for (const [path, n] of checks) {
    const thin = n < MIN_OFFERS_TO_INDEX;
    assert.equal(noindex(page(path)), thin, `${path}: ${n} courses`);
    assert.equal(sm.has(path), !thin, `${path}: sitemap`);
  }
  for (const r of live) assert.ok(sm.has(`/resources/${r.id}/`), `${r.id} course page is in the sitemap`);
});

test('unverified courses are linked from no page', () => {
  const unverified = allCourses().filter((r) => effectiveStatus(r) === 'unverified').map((r) => r.id);
  assert.ok(unverified.includes('vu.netacad'));
  for (const p of ['/learn/', '/learn/certificates/', '/learn/pakistan/', '/in/pakistan/', '/free-for/', '/free-for/students/pakistan/']) {
    for (const id of unverified) assert.ok(!linked(page(p)).has(id), `${p} links to unverified ${id}`);
  }
  for (const id of unverified) assert.ok(!has(`/resources/${id}/`), `${id} must not have a page`);
});

test('every live course has a page with a "What you get" box that states the certificate', () => {
  for (const r of liveCourses()) {
    const html = page(`/resources/${r.id}/`);
    assert.match(html, /id="what-you-get"/, r.id);
    assert.match(html, /<dt>Certificate<\/dt>/, r.id);
    if (r.learning.certificate === 'paid_required') assert.match(html, /Certificate costs money/, `${r.id}: needs the badge`);
    if (certificateCostsMoney(r)) assert.match(html, /The learning is free\. The certificate is not\./, r.id);
  }
});

test('course pages carry a free Course offer; cohort courses carry a start date; breadcrumbs go through Learn', () => {
  const c = liveCourses().find((r) => r.id === 'harvard.cs50x');
  const g = ldGraph(page(`/resources/${c.id}/`));
  assert.deepEqual(g.map((n) => n['@type']), ['WebPage', 'BreadcrumbList']);
  assert.equal(g[0].about['@type'], 'Course');
  assert.equal(g[0].about.provider.name, c.provider);
  assert.equal(g[0].about.offers.price, '0');
  assert.equal(g[1].itemListElement[1].name, 'Learn');
  const cohort = liveCourses().find((r) => r.learning.format === 'cohort' && r.offer_window?.starts);
  assert.ok(cohort, 'test needs a cohort course with a start date');
  const ci = ldGraph(page(`/resources/${cohort.id}/`))[0].about.hasCourseInstance;
  assert.equal(ci[0].startDate, cohort.offer_window.starts);
});

test('/in/pakistan/ lists the learning-only courses too, and nav and footer link to /learn/', () => {
  const html = page('/in/pakistan/');
  for (const r of coursesFor({ country: 'PK' })) assert.ok(linked(html).has(r.id), r.id);
  assert.match(html, /href="\/learn\/"/);
  assert.match(page('/'), /href="\/learn\/"/);
});

test('eligibility offers that are courses are not duplicated as pages', () => {
  const dupes = allOffers().filter((r) => r.kind === 'course' || r.kind === 'certification').map((r) => r.id);
  for (const id of dupes.filter((x) => liveCourses().some((c) => c.id === x))) assert.ok(has(`/resources/${id}/`), id);
});
