// Search-engine helpers: structured data (schema.org JSON-LD) and the sitemap list.
// Every indexable page must appear in sitemapEntries(); tests/build.test.mjs fails the
// build if a built page is missing, so new sections (for example /tools/) cannot be forgotten.
import { resources, loadCatalog } from './catalog.js';
import { liveOffers, offersFor, endingSoon, myths, lastChecked, GROUPS, COUNTRY_PAGES, today, MIN_OFFERS_TO_INDEX } from './eligibility.js';
import { liveCourses, coursesFor, hasFreeCertificate } from './learning.js';
import { tools, liveCategories, liveTasks, inCategory, forTask, lastModified, directoryStats, MIN_TOOLS_TO_INDEX } from './directory.js';

export const SITE_NAME = 'Freemeans';
export const SITE_URL = 'https://freemeans.com';
export const DEFAULT_IMAGE = { path: '/og.png', width: 1200, height: 630, alt: 'Freemeans: Do more. Pay nothing. Top AI tools and free resources for every task, for everyone.' };

const abs = (site, path) => new URL(path, site).href;

export function organizationLd(site) {
  return {
    '@type': 'Organization',
    '@id': abs(site, '/#organization'),
    name: SITE_NAME,
    url: abs(site, '/'),
    logo: { '@type': 'ImageObject', url: abs(site, '/logo-512.png'), width: 512, height: 512 },
    email: 'hello@freemeans.com',
    parentOrganization: { '@type': 'Organization', name: 'TEKDIGIX', url: 'https://tekdigix.com' },
  };
}

export function websiteLd(site) {
  return {
    '@type': 'WebSite',
    '@id': abs(site, '/#website'),
    name: SITE_NAME,
    url: abs(site, '/'),
    inLanguage: 'en',
    publisher: { '@id': abs(site, '/#organization') },
  };
}

// crumbs: [{ name, path }], first one is Home.
export function breadcrumbLd(site, crumbs) {
  return {
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({ '@type': 'ListItem', position: i + 1, name: c.name, item: abs(site, c.path) })),
  };
}

// items: [{ name, path }] in display order. Use for the catalog and the /tools/ top-10 lists.
export function itemListLd(site, { name, items }) {
  return {
    '@type': 'ItemList',
    name,
    numberOfItems: items.length,
    itemListOrder: 'https://schema.org/ItemListOrderAscending',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, url: abs(site, it.path) })),
  };
}

export function webPageLd(site, { path, name, description, type = 'WebPage', dateModified, extra = {} }) {
  return {
    '@type': type,
    '@id': abs(site, path) + '#page',
    url: abs(site, path),
    name,
    description,
    inLanguage: 'en',
    isPartOf: { '@id': abs(site, '/#website') },
    ...(dateModified ? { dateModified } : {}),
    ...extra,
  };
}

// Wraps nodes in one @graph so a page carries a single JSON-LD block.
export const graph = (nodes) => ({ '@context': 'https://schema.org', '@graph': nodes.filter(Boolean) });

// Pages for sitemap.xml: path, lastmod (YYYY-MM-DD).
export function sitemapEntries() {
  const list = resources();
  const latest = list.map((r) => r.last_verified).sort().at(-1) ?? loadCatalog().generated_at?.slice(0, 10);
  return [
    { path: '/', lastmod: latest },
    { path: '/catalog/', lastmod: latest },
    ...list.map((r) => ({ path: `/resources/${r.id}/`, lastmod: r.last_verified })),
    ...directoryEntries(),
    ...eligibilityEntries(),
    ...learningEntries(),
  ];
}

// /tools/: the directory home, every tool page, and category and task pages that are big
// enough to index (thinner ones are built with noindex and left out here).
function directoryEntries() {
  const list = tools();
  if (!list.length) return [];
  const newest = (ts) => ts.map(lastModified).sort().at(-1);
  return [
    { path: '/tools/', lastmod: directoryStats().latest },
    { path: '/tools/submit/', lastmod: directoryStats().latest },
    ...list.map((t) => ({ path: `/tools/${t.slug}/`, lastmod: lastModified(t) })),
    ...liveCategories().filter((c) => c.count >= MIN_TOOLS_TO_INDEX)
      .map((c) => ({ path: `/tools/c/${c.id}/`, lastmod: newest(inCategory(c.id)) })),
    ...liveTasks().filter((t) => t.count >= MIN_TOOLS_TO_INDEX)
      .map((t) => ({ path: `/tools/t/${t.id}/`, lastmod: newest(forTask(t.id)) })),
  ];
}

// /free-for/, /in/pakistan/ and every live offer page. Thin pages (fewer than 5 offers) are built
// with noindex and left out here, so this list matches what the pages say about themselves.
function eligibilityEntries() {
  const live = liveOffers();
  if (!live.length) return [];
  const out = [
    { path: '/free-for/', lastmod: lastChecked(live) },
    ...live.map((r) => ({ path: `/resources/${r.id}/`, lastmod: r.last_verified })),
  ];
  for (const g of Object.keys(GROUPS)) {
    const list = offersFor({ group: g });
    if (list.length >= MIN_OFFERS_TO_INDEX) out.push({ path: `/free-for/${g}/`, lastmod: lastChecked(list) });
    for (const [slug, c] of Object.entries(COUNTRY_PAGES)) {
      const inCountry = offersFor({ group: g, country: c.code });
      if (inCountry.length >= MIN_OFFERS_TO_INDEX) out.push({ path: `/free-for/${g}/${slug}/`, lastmod: lastChecked(inCountry) });
    }
  }
  for (const slug of Object.keys(COUNTRY_PAGES)) out.push({ path: `/in/${slug}/`, lastmod: lastChecked(live) });
  if (endingSoon().length) out.push({ path: '/free-for/ending-soon/', lastmod: today() });
  if (myths().length) out.push({ path: '/free-for/myths/', lastmod: lastChecked(myths()) });
  return out;
}

// /learn/ pages and the course pages that are not already listed with the eligibility offers.
// Thin pages (fewer than 5 courses) are built with noindex and left out, like everywhere else.
function learningEntries() {
  const courses = liveCourses();
  if (!courses.length) return [];
  const offerIds = new Set(liveOffers().map((o) => o.id));
  const out = courses.filter((c) => !offerIds.has(c.id)).map((c) => ({ path: `/resources/${c.id}/`, lastmod: c.last_verified }));
  if (courses.length >= MIN_OFFERS_TO_INDEX) out.push({ path: '/learn/', lastmod: lastChecked(courses) });
  const free = courses.filter(hasFreeCertificate);
  if (free.length >= MIN_OFFERS_TO_INDEX) out.push({ path: '/learn/certificates/', lastmod: lastChecked([...free, ...courses.filter((c) => !hasFreeCertificate(c))]) });
  for (const [slug, c] of Object.entries(COUNTRY_PAGES)) {
    const here = coursesFor({ country: c.code });
    if (here.length >= MIN_OFFERS_TO_INDEX && slug === 'pakistan') out.push({ path: `/learn/${slug}/`, lastmod: lastChecked(here) });
  }
  return out;
}
