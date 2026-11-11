# Freemeans: live setup (as of 10 Nov 2026)

Account emails are left out on purpose, because this repo is public. The owner knows which accounts these are.

| Part | Address / place | Notes |
| --- | --- | --- |
| Website | https://freemeans.com (www 301-redirects to it via a Cloudflare Redirect Rule) | Cloudflare Worker `freemeans` (static assets), builds from GitHub `main`, root `apps/web`. workers.dev copy turned off on 9 Nov 2026 (SEO: no duplicate site) |
| API | https://api.freemeans.com (also the `freemeans-api` workers.dev address) | Cloudflare Worker `freemeans-api`; secret `DATABASE_URL`; every answer sends `X-Robots-Tag: noindex` |
| Database | Neon project `freemeans`, org `freemeans`, region AWS Singapore | Pooled connection; password reset on 8 Nov 2026 after it appeared in a screenshot |
| Code | https://github.com/mcwm04/freemeans (public) | CI on every push |
| Nightly check | GitHub Actions "Source check", 02:17 PKT | Opens one PR (branch `bot/source-check`) when a limit number disappears from its source page |
| Google | Search Console Domain property `freemeans.com` (verified 9 Nov 2026) | Sitemap `sitemap.xml` submitted; indexing requested for home, catalog and 2 resource pages; Breadcrumbs valid in Rich Results Test |
| Bing | Bing Webmaster Tools, imported from Search Console (9 Nov 2026) | GitHub Actions "IndexNow" pings Bing and others after each site change (first run: 17 URLs, HTTP 200). Key `fce2bace446ef852fb4d71bc979a8cd0` (public by design) |
| Domain | freemeans.com on Cloudflare Registrar (bought 8 Nov 2026) | Auto-renew, transfer lock and DNSSEC on |
| Email | hello@freemeans.com → the owner's Gmail | Cloudflare Email Routing (receive and forward only) |

## Cloudflare builds (Worker `freemeans` → Settings → Builds)

| | Production (`main`) | Previews (every other branch / PR) |
| --- | --- | --- |
| Root directory | `apps/web` | `apps/web` |
| Build command | `npm run build` | `npm run build` |
| Deploy command | `npx wrangler deploy` | `npx wrangler preview` |
| Variable | `NODE_VERSION=22` | `NODE_VERSION=22` |

- `apps/web/wrangler.jsonc` must keep the empty `"previews": {}` block, or branch builds fail. Preview URLs stay off (no duplicate site for search engines). Previews still build, so each PR gets a real Cloudflare build check.
- Each branch gets its own preview record that copies the **Previews Base** settings when the branch is first built. Changing Previews Base later does not update existing branches.
- A branch made before the `previews` block reached `main` needs `main` merged in (or a rebase) before its Cloudflare check turns green.

## Daily rebuild (offers that expire)

The site is static, so an offer past its claim-by date leaves the live lists only when the site is rebuilt. `.github/workflows/rebuild.yml` starts a build every day at 05:05 Pakistan time through a Cloudflare deploy hook. One-time setup:

1. Cloudflare dashboard → **Workers & Pages → freemeans → Settings → Builds → Deploy hooks**. Add a hook named `daily` for branch `main` and copy its URL.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**. Name `CLOUDFLARE_DEPLOY_HOOK`, value the URL. Keep it secret: anyone with the URL can start builds.

Until the secret exists the workflow does nothing (it prints a notice). The API already treats a passed date as ended, and each page shows "Ended" in the browser, so a missed rebuild never shows an expired offer as live.

## Routine tasks

- **Catalog change:** edit `data/catalog/seed.json`, then push (the site rebuilds and IndexNow pings). Then in `db/`: `npm run load-seed` with `DATABASE_URL` set (updates the API).
- **API change:** in `services/api`: `npx wrangler deploy`.
- **New Neon password:** in `services/api`: `npx wrangler secret put DATABASE_URL`.
- **New page type:** add it to `sitemapEntries()` in `apps/web/src/lib/seo.js`; follow Chapter 6 of `docs/SEO.md`.
- **SEO check-ins:** Chapter 5 of `docs/SEO.md` (Search Console Sitemaps and Pages reports, weeks 1–4).
- **Windows:** use normal PowerShell. Script policy was set once with `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

Guides: `docs/DEPLOY.md`, `docs/SEO.md`, `docs/DIRECTORY.md`, `docs/ELIGIBILITY-PRD.md`.
