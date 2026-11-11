# AGENTS.md: Freemeans

Instructions for AI coding agents (Codex, Claude Code and others) working in this repo. Read this file first, then the doc for the area you are touching.

**Freemeans** (https://freemeans.com) · *Do more. Pay nothing.* · کام زیادہ، خرچ صفر
A catalog and directory of free AI tiers, tools and eligibility-based offers, with every limit sourced and dated. Owner: Waqas Ahmad. First market: Pakistan.

---

## 1. Where things are

| Area | Folder | Runs on |
| --- | --- | --- |
| Website (Astro, static, Pagefind search) | `apps/web/` | Cloudflare Worker `freemeans` (static assets), builds from `main` |
| Public API | `services/api/` | Cloudflare Worker `freemeans-api` at `api.freemeans.com` |
| Editor console (GitHub sign-in) | `services/admin/` | Cloudflare Worker |
| Database: migrations, seed loader | `db/` | Neon Postgres (AWS Singapore), pooled connection |
| Nightly source check | `services/pipeline/` | GitHub Actions, 02:17 PKT, opens one review PR |
| Directory: tool checks, signals, crawler | `services/toolcheck/`, `services/signals/`, `services/crawler/` | GitHub Actions |
| Local agent (free-aware router, CLI) | `agent/` | User's machine |
| Schemas | `packages/schema/` | JSON Schema |
| Brand tokens and logos | `packages/brand/` | |
| Data | `data/catalog/seed.json` (API free tiers), `data/tools/*.json` (directory), `data/taxonomy.json` | Source of truth for the site |

**Docs to read before working on an area**

- `docs/LIVE-SETUP.md`: what is live, where, and the routine tasks
- `docs/DEPLOY.md`: deploying the whole stack on free plans
- `docs/SEO.md`: SEO rules. Chapter 6 governs every new page type
- `docs/DIRECTORY.md`: the top-10 AI tools directory
- `docs/ELIGIBILITY-PRD.md`: "Free for who you are" (student, teacher, nonprofit and startup offers). **This is the current main project**

## 2. Tests: run these before you finish

CI (`.github/workflows/ci.yml`) runs all of them on every push and PR. Run the ones for the folders you changed.

```bash
cd db           && npm ci && npm test                              # migrations + loader on PGlite
cd services/api && npm ci && npm test && npm run check-bundle
cd services/admin && npm ci && npm test && npm run check-bundle
cd apps/web     && npm ci && npm test                              # astro build + SEO build guards
cd agent        && pip install -e ".[dev]" && python -m pytest -q && freemeans validate-catalog ../data/catalog/seed.json
cd services/pipeline  && python -m pytest -q
cd services/toolcheck && pip install -e ".[dev]" && python -m toolcheck && python -m pytest -q
cd services/signals   && pip install -e ".[dev]" && python -m pytest -q     # needs TEST_DATABASE_URL (Postgres 16)
cd services/crawler   && pip install -e ../toolcheck -e ../signals -e ".[dev]" && python -m pytest -q
```

Node 22+, Python 3.12+. The owner works on **Windows PowerShell**, so give PowerShell commands first in any instructions you write, then bash.

## 3. Firm rules

1. **No secrets in the repo, chat, logs or screenshots.** `DATABASE_URL` lives only in Cloudflare's secret store (`npx wrangler secret put DATABASE_URL`) and in the owner's terminal. Never print it, never commit `.env` or `.dev.vars`. Tests use PGlite or a local Postgres.
2. **Every number needs a source and a date.** Each limit or offer fact carries `source_url` and `verified_at` / `last_verified`. Never invent or estimate a limit. If you can't confirm it, mark the record `unverified`.
3. **No workarounds for eligibility.** Never explain fake student IDs, VPN tricks for country offers, multiple accounts or "free .edu email" services. Link to the provider's own verification.
4. **Honest offers.** An offer that needs a card and auto-renews must carry the `auto_renews_paid` badge (red, "Charges after free period"). CI enforces this both ways. A "free course" with a paid certificate gets a warning too.
5. **Paid links:** every paid or featured outbound link gets `rel="sponsored noopener"` and a visible "Sponsored" label. Rankings come from data, never from payment.
6. **SEO guard rails (`docs/SEO.md` ch. 6):** every page has one `<h1>`, a unique description of 50–170 characters, a title of 70 characters or fewer, a canonical URL and parseable JSON-LD. Every indexable page goes into `sitemapEntries()` in `apps/web/src/lib/seo.js`. Query-string pages and thin pages (fewer than 5 active items) get `noindex`. Never use `Product` schema for free tiers; use `Service` inside `WebPage`. Never add `aggregateRating` without real user ratings.
7. **Migrations are append-only and numbered.** Never edit an applied migration. Take the next free number (check `db/migrations/` on `main` first). A DB test checks that the SQL CHECK lists match the JSON Schema enums exactly, so update both together.
8. **Stay on free plans.** Workers (100k requests/day, 10 ms CPU), Neon (1 GB, 100 CU-hours/month), GitHub Actions. Flag anything that would need a paid plan.
9. **Privacy:** the waitlist stores only email, source page, consent time and country. API answers must not reveal whether an email is already on the list.
10. **Writing style for docs and UI text:** simple, plain English. Short sentences, no hype. Docs are organized into numbered chapters.

## 4. How we work

- **Plan first.** For anything bigger than a small fix, write or update the plan or PRD before coding. Work in modules; each module ends with green CI.
- **Branches:** `area/short-name` (for example `eligibility/m2-seed`). Open a PR into `main`. Cloudflare builds a preview for every branch (preview URLs are off on purpose). `apps/web/wrangler.jsonc` must keep its empty `"previews": {}` block.
- **The bot branch `bot/source-check`** is opened by the nightly check. A person confirms every change: update the value and `verified_at` in the data file in the same PR, then merge.
- After a catalog change is merged, run `npm run load-seed` in `db/` with `DATABASE_URL` set (the owner does this) to update the API.

## 5. Current state and to-do (updated 11 Nov 2026)

**Done and live:** website, API, Neon, email routing, Search Console + Bing + IndexNow, nightly source check. Directory Phase 0 and Phase 1 (pages, search, `/go` clicks, submit form, crawler, editor console) are merged into `main`.

**To do, in order:**

1. **Review the `bot/source-check` PR:** `digitalocean.signup-credit` (US$200). The referral page no longer states the amount. Point `source_url` at a DigitalOcean page that states it, or update the value, then merge.
2. **Eligibility M1 to M3 are merged** (schema, `data/catalog/eligibility.json` with 30 offers and 4 Myths records, API filters). Six records are `unverified` until someone reads the provider's page: `google.ai-plus-student`, `cursor.pro-student`, `google.startups-cloud`, `microsoft.startups`, `mofept.cisco-netacad`, `openai.chatgpt-for-teachers`.
3. **Eligibility M4 (pages)** is in review: `/free-for/…`, `/in/pakistan/`, the "Who can get this" box, the checker, JSON-LD and sitemap.
4. **Eligibility M5:** `find_phrase()` watch phrases in the source check, a daily rebuild Action and the staleness list. Only two records have watch phrases so far.
5. **Eligibility M6:** launch.

**Deadline:** `/free-for/students/pakistan/` and `/free-for/ending-soon/` must be live by **mid-December 2026**. The Google AI Plus student offer must be redeemed by 31 Dec 2026, so searches will peak in December.

**Open decisions (ask the owner, don't decide):** K-12 audiences in v1? An Urdu summary block on the Pakistan student page now?
