# Freemeans SEO and Google indexing guide

This guide covers three things: what the site already does for search engines, the one-time setup in Google and Bing, and the rules for new pages such as the `/tools/` top-10 directory. Plan on about 30 minutes for the one-time setup.

---

## Chapter 1. What the code does (since 9 Nov 2026)

| Area | What is in place | Where |
| --- | --- | --- |
| Sitemap | `https://freemeans.com/sitemap.xml` lists every indexable page with `<lastmod>`, the date its data was last checked. This replaces `sitemap.txt`. | `apps/web/src/pages/sitemap.xml.js`, `src/lib/seo.js` |
| robots.txt | Allows everything and points to `sitemap.xml`. | `apps/web/public/robots.txt` |
| Titles and descriptions | Each page has its own. Resource pages put the real numbers first, for example *"30 requests per minute, 1,000 requests per day"*, because those are what people search for. | page files in `src/pages/` |
| Canonical URL | Every page names its one official address (`https://freemeans.com/.../`), so `www` and other copies count as the same page. | `src/layouts/Base.astro` |
| Social cards | Open Graph and Twitter/X tags, with a 1200×630 share image in the brand style. Links shared on WhatsApp, LinkedIn, X and Facebook show a proper card. | `public/og.png` |
| Structured data | One JSON-LD block per page. **Home:** Organization (with logo) + WebSite + WebPage. **Catalog:** CollectionPage + BreadcrumbList + ItemList. **Resource:** WebPage (about a free Service) + BreadcrumbList. | `src/lib/seo.js` |
| Headings | The home page now has an `<h1>`; every page has exactly one. | |
| Kept out of Google | The 404 page (`noindex`), `catalog.json` (`X-Robots-Tag: noindex`), and every API answer from `api.freemeans.com` (`X-Robots-Tag: noindex, nofollow`). | `Base.astro`, `public/_headers`, `services/api/src/app.js` |
| No duplicate site | The `freemeans.nexusuaf.workers.dev` copy of the site is turned off (`workers_dev: false`). | `apps/web/wrangler.jsonc` |
| IndexNow (Bing and others) | After each push that changes the site, a GitHub Action waits 4 minutes for Cloudflare to deploy, then sends every sitemap URL to IndexNow. | `.github/workflows/indexnow.yml`, `public/<key>.txt` |
| Guard rails | `npm test` fails if a built page is missing from the sitemap, if a title or description is duplicated or the wrong length, if a page has no single `<h1>` or canonical, or if the JSON-LD does not parse. | `apps/web/tests/build.test.mjs` |

**Why the resource pages no longer say `Product`:** Google treats `Product` markup as a shop listing and then asks for shipping, returns and reviews. A free API tier is a service, so it is now a `Service` with a US$0 offer inside a `WebPage`. This avoids a page of warnings in Search Console.

**Why there is no `hreflang`:** `hreflang` is for pages that exist in two languages. The site is in English, and Urdu appears only in the tagline. Add `hreflang` when real Urdu pages exist, for example `/ur/`.

---

## Chapter 2. One-time Cloudflare checks (5 minutes)

Do these after the push has deployed. You can see the deploy under **Workers & Pages → freemeans → Deployments**.

1. **Send www to the main address.** Open **freemeans.com → Rules → Overview → Create rule → Redirect Rule** and pick the template **"Redirect from WWW to root"**. Check that it uses status **301** and has **Preserve query string** turned on, then **Deploy**. Redirect rules are included in the free plan.
   Test it: `https://www.freemeans.com/catalog/` should land on `https://freemeans.com/catalog/`.
2. **Check that the workers.dev copy is gone.** Open **Workers & Pages → freemeans → Settings → Domains & Routes**. `workers.dev` should show as disabled. Only `freemeans.com` and `www.freemeans.com` remain.
3. **Check robots.txt as Google sees it.** Open `https://freemeans.com/robots.txt`. It must end with `Sitemap: https://freemeans.com/sitemap.xml`.
   If Cloudflare added extra lines at the top, it is because **Security → Bots → "Manage your robots.txt"** or **"Block AI bots"** is on. Those lines only affect AI crawlers. Googlebot and Bingbot must never be blocked, so leave **Bot Fight Mode** off. On the free plan it can challenge real search crawlers.
4. **Open the new files once:**
   - `https://freemeans.com/sitemap.xml` shows 17 URLs.
   - `https://freemeans.com/og.png` shows the share image.
   - `https://freemeans.com/fce2bace446ef852fb4d71bc979a8cd0.txt` shows the same 32 letters and digits. This is the IndexNow key.

---

## Chapter 3. Google Search Console (15 minutes)

### 3.1 Verify the domain

1. Go to **search.google.com/search-console** and sign in with the Google account that should own the site data. Use the same account for the Freemeans Google Trends API application, so everything stays in one place.
2. Click **Add property** and choose **Domain** (the left box). Enter `freemeans.com` and click **Continue**.
   A Domain property covers `https`, `http`, `www` and every subdomain at once. That is why it is better than "URL prefix".
3. Google recognises Cloudflare and offers **"Start verification"**. Click it, log in to Cloudflare (Nexusuaf@gmail.com), and allow it. Google adds the TXT record for you.
   **Or do it by hand:** copy the `google-site-verification=...` value. In Cloudflare, open **freemeans.com → DNS → Records → Add record** and enter:
   - Type: **TXT**
   - Name: **@**
   - Content: paste the value
   - TTL: Auto

   Save it, go back to Search Console, and click **Verify**. On Cloudflare DNS this usually works within a minute.
4. Keep the TXT record forever. If it is deleted, Search Console loses access.

### 3.2 Submit the sitemap

**Sitemaps** (left menu) → enter `sitemap.xml` → **Submit**. Within a day the status should say **Success** with **17 discovered pages**.

If you submitted `sitemap.txt` earlier, remove it with the ⋮ menu → **Remove sitemap**. That file no longer exists.

### 3.3 Ask Google to crawl the key pages now

Use **URL inspection** (the search bar at the top). Paste each URL below, wait for the result, then click **Request indexing**:

1. `https://freemeans.com/`
2. `https://freemeans.com/catalog/`
3. Two or three resource pages people are likely to search for, for example `https://freemeans.com/resources/groq.gpt-oss-120b/` and `https://freemeans.com/resources/openrouter.free-models/`. Copy the exact IDs from the catalog page.

There is a small daily limit on requests, about 10. You don't need to request every page: the sitemap brings in the rest.

### 3.4 Check the structured data

Open **search.google.com/test/rich-results** and test:

- `https://freemeans.com/catalog/` should show **Breadcrumbs: 1 valid item**.
- A resource page should show **Breadcrumbs: 1 valid item**.
- The home page shows no rich result. That is normal: Organization data is used for the knowledge panel and the logo, not for a result card.

---

## Chapter 4. Bing and IndexNow (5 minutes)

Bing also feeds DuckDuckGo, Yahoo, Ecosia and ChatGPT search, so it is worth doing.

1. Go to **bing.com/webmasters** and sign in. Choose **Import from Google Search Console**, allow access, and select freemeans.com. This imports both the verification and the sitemap.
2. Run the IndexNow workflow once by hand. On GitHub, open **Actions → IndexNow → Run workflow**. The log should end with `IndexNow answered HTTP 200` (or `202`).
   After that it runs by itself whenever `apps/web/` or `data/catalog/` changes on `main`.
3. In Bing Webmaster Tools, **IndexNow** (left menu) shows the submitted URLs within a day.

Google does not use IndexNow. For Google, the sitemap plus `<lastmod>` does the same job.

If the workflow fails with *"Key file not live yet"*, the site had not finished deploying. Run it again by hand.

---

## Chapter 5. What to watch in weeks 1–4

| When | Where in Search Console | What good looks like | If not |
| --- | --- | --- | --- |
| Day 1–3 | **Sitemaps** | Status *Success*, 17 discovered | Open `sitemap.xml` in a browser; check robots.txt (Chapter 2) |
| Week 1 | **Pages** (Indexing) | Home and catalog *Indexed* | URL inspection → *Request indexing* again |
| Week 1–3 | **Pages** | Most resource pages *Indexed* | *"Discovered – currently not indexed"* is normal for a new domain; wait. *"Crawled – currently not indexed"* means Google found the page too thin: add more useful text, like a short "Who it suits" and "Watch out for" section |
| Week 1–4 | **Pages → Why pages aren't indexed** | Only `www` URLs under *"Page with redirect"* and the 404 under *"Excluded by noindex"* | Anything else: read the reason and check this guide |
| Week 2+ | **Enhancements → Breadcrumbs** | Valid items rising | Use the Rich Results Test on one failing page |
| Week 3+ | **Performance** | First impressions for queries like "groq free tier limits" | Normal for a new site to be slow. See Chapter 7 |
| Month 2+ | **Core Web Vitals** | *Good* (static pages, self-hosted fonts) | Needs real visitors before data appears |

**Be realistic about timing.** A new domain with 17 pages is usually crawled within days and indexed within 1–3 weeks. Ranking well for competitive words like "free AI API" takes months, and depends on content and links more than on tags.

---

## Chapter 6. Rules for the `/tools/` top-10 directory pages

The directory is not built yet. Follow these rules when it is, and the tests will hold you to most of them.

### 6.1 URLs

| Page | URL | Index? |
| --- | --- | --- |
| Directory home | `/tools/` | Yes |
| Current top 10 | `/tools/top-10/daily/`, `/tools/top-10/weekly/`, `/tools/top-10/monthly/`, `/tools/top-10/yearly/` | Yes. Keep these **stable URLs** that always show the current list, so they build ranking over time |
| Past lists | `/tools/top-10/weekly/2026-w45/`, `/tools/top-10/monthly/2026-11/`, `/tools/top-10/yearly/2026/` | Weekly, monthly, yearly: **yes**. Daily archives: **no** (`noindex`). 365 near-identical pages a year count as thin content |
| One tool | `/tools/{slug}/`, for example `/tools/notebooklm/` | Yes, if the page has real text (what it does, who it suits, free plan, link). Otherwise `noindex` until it does |
| Category | `/tools/category/{slug}/` | Yes, once a category has 5 or more tools |
| Search and filters | `?q=`, `?sort=` | No. Never link to them as separate pages, and never put them in the sitemap |

### 6.2 On every page

- Pass `title`, `description` and `jsonLd` to `<Base>`. Use `noindex` for any page in the "No" column above.
- **Top-10 pages:** use `graph([webPageLd(...), breadcrumbLd(...), itemListLd(site, { name, items })])`, with `dateModified` set to the date the ranking was computed.
  Put the period and date in the title, for example *"Top 10 trending AI tools this week (week of 9 Nov 2026)"*. Keep titles at 70 characters or fewer.
- **Tool pages:** `webPageLd` with `about: { '@type': 'SoftwareApplication', name, applicationCategory, operatingSystem: 'Web', offers }`, plus breadcrumbs.
  Do **not** add `aggregateRating` unless the ratings come from your own real users.
- Add every indexable page to `sitemapEntries()` in `src/lib/seo.js`, with `lastmod` set to the date its data changed. The build test fails if you forget.
- Each page needs one `<h1>` and its own description of 50–170 characters. The test checks both.

### 6.3 Paid listings and backlinks (important)

You plan to sell backlink listings later. Google's spam policy says **every paid link must carry `rel="sponsored"`** (or `rel="nofollow"`). Selling links that pass ranking without it can get the whole of freemeans.com demoted.

So, from day one:

- Outbound links to tool websites: `rel="noopener"`, plus `rel="sponsored noopener"` on any paid or featured listing.
- Label paid placements visibly as **"Sponsored"**.
- Rankings in the top-10 lists must come from the data (search interest), never from payment. Paid spots, if any, go in a separate, labelled box.

---

## Chapter 7. Next steps that bring traffic

Technical SEO lets Google read the site. Traffic comes from pages that answer searches, and from links.

1. **Answer pages built from the catalog**, for example *"Free LLM APIs with no card (November 2026)"*, *"Free speech-to-text APIs"*, *"Which free AI APIs allow commercial use"*. Each one is a filtered list plus a short dated explanation. These match what builders actually type into Google.
2. **Links from places developers read.** Ideas: the GitHub repo README linking to freemeans.com, a dev.to or Hashnode post on "How I track every free AI tier", a Product Hunt launch when the beta opens, and the UAF CS department and TEKDIGIX sites linking to it.
3. **Urdu pages later**, under `/ur/` with `hreflang`. There is very little Urdu content on this topic, so it is an easy niche.

---

## Quick reference

- Sitemap: `https://freemeans.com/sitemap.xml`
- IndexNow key: `fce2bace446ef852fb4d71bc979a8cd0` (public; file at `/fce2bace446ef852fb4d71bc979a8cd0.txt`)
- Rebuild the share image after a brand change:
  ```
  cd apps/web
  pip install playwright && playwright install chromium
  python scripts/render-share-images.py .
  ```
- Tests: `cd apps/web && npm test`
