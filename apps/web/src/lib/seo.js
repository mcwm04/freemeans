// Search-engine helpers: structured data (schema.org JSON-LD) and the sitemap list.
// Every indexable page must appear in sitemapEntries(); tests/build.test.mjs fails the
// build if a built page is missing, so new sections (for example /tools/) cannot be forgotten.
import { resources, loadCatalog } from './catalog.js';

export const SITE_NAME = 'Freemeans';
export const SITE_URL = 'https://freemeans.com';
export const DEFAULT_IMAGE = { path: '/og.png', width: 1200, height: 630, alt: 'Freemeans: every free tier for AI builders, dated and tracked.' };

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
    // /tools/ pages: add their entries here when the directory ships.
  ];
}
