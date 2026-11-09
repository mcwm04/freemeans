# AI tools directory: Phase 0 (Foundations)

Plan: *Freemeans AI Tools Directory — PRD*, Chapter 10. Phase 0 runs 10–23 Nov 2026.
**Exit gate:** the signal collector runs 7 nights in a row without failure.

| # | Task | Where | Status |
| --- | --- | --- | --- |
| 1 | Tool JSON Schema + CI validation | `packages/schema/tool.schema.json`, `services/toolcheck/` | ✅ built |
| 2 | Taxonomy: 25 categories, first 80 tasks | `data/taxonomy.json` | ✅ built |
| 3 | Migration `002_directory.sql` on Neon | `db/migrations/002_directory.sql` | ✅ built · ⏳ run it on Neon (below) |
| 4 | Apply for Google Trends API alpha | draft below | ⏳ you submit it |
| 5 | Signal collector + 2-year backfill | `services/signals/`, `.github/workflows/signals.yml` | ✅ built · ⏳ add the secret (below) |

## Switch it on (about 10 minutes)

1. **Merge** the Phase 0 pull request. CI must be green.
2. **Create the new tables on Neon.** In PowerShell, from the repo:

   ```powershell
   cd db
   npm ci
   $env:DATABASE_URL = "postgresql://...-pooler...neon.tech/neondb?sslmode=verify-full&channel_binding=require"
   npm run migrate
   ```

   You should see `applied: 002_directory.sql`. It only adds tables and one column
   (`waitlist.lists`), so the live site and API keep working.
3. **Give GitHub the database.** On GitHub: **Settings → Secrets and variables → Actions →
   New repository secret**. Name `DATABASE_URL`, value: the same pooled string.
4. **First run.** **Actions → Signals → Run workflow.** The *collect* job writes yesterday's rows;
   the *backfill* job then loads two years of Wikipedia and Hacker News history and GitHub star
   history. Read the result in each job's **Summary**.
5. From then on it runs every night at 00:34 Pakistan time. Check the Summary once a day for a
   week. Seven green runs in a row meet the Phase 0 exit gate.

Check the data in Neon's SQL editor:

```sql
SELECT slug, day, wiki_views, hn_points, gh_stars, hf_likes
FROM signal_snapshots ORDER BY day DESC, slug LIMIT 20;

SELECT job, started_at, ok, stats->>'failure_rate' AS failure_rate
FROM job_runs ORDER BY started_at DESC LIMIT 10;
```

**Expected on the first run:** ComfyUI and Ollama have no Wikipedia title set yet, so they show
`skipped` there. If a title or repo is wrong, the run lists it under *Needs a look* without
failing; fix the tool's `signals` field in `data/tools/` and push.

## Where Phase 0 differs from the PRD text

| PRD | Built | Why |
| --- | --- | --- |
| `signals.hn_query` only | adds `signals.hn_domain` (preferred), `hn_query` as fallback | PRD 6.4 asks HN to match by domain to avoid name clashes |
| `hf_likes` "likes / downloads proxy" | `hf_likes` (total) and `hf_downloads` (30-day) in separate columns | they mean different things; mixing them would distort growth |
| — | `signal_backfills` table | records which history loads are finished, so reruns skip them |
| — | `trending_scores.method_version` | PRD 6.6: archived lists keep their method version |
| — | tool fields `license`, `trial_days`, `affiliate_url` | needed by M1 pages, the trial rule and `/go` |
| Collector at 00:30 PKT | 00:34 PKT (19:34 UTC) | off the busy top of the hour, like the source check |
| Clicks from day 1 | `our_clicks` stays NULL until `FREEMEANS_CLICKS_SINCE` is set | `/go` links arrive in Phase 1; before that, zero would be false |

Product Hunt and Google Trends stay off in code (PRD 7.2, 6.1) and appear as "off" in every run summary.

## Google Trends API alpha: application draft

Google announced the alpha in July 2025 on Google Search Central
(https://developers.google.com/search/blog/2025/07/trends-api) with a sign-up form for testers.
Open that post, follow its link to the form, and paste from below. Apply as **Freemeans**
(decided 9 Nov 2026). The form's exact fields may differ; adapt the text to them.

**Organization:** Freemeans (freemeans.com), run by Waqas Ahmad, Lecturer in Computer Science,
University of Agriculture, Faisalabad, Pakistan. Contact: hello@freemeans.com.

**What we are building:** Freemeans is a free directory of AI tools that shows what each tool
gives for free (quotas, card requirement, commercial use), checked against the provider's own
pages every night. It also publishes daily, weekly, monthly and yearly lists of trending AI tools.
The ranking method is published openly at freemeans.com/trending/how-we-rank/.

**How we would use the Trends API:** to measure search interest in each listed tool as one of
several public signals (alongside Wikipedia pageviews, Hacker News discussion and GitHub stars).
We would query each listed tool's name once a day in batches (about 300 tools at launch in
December 2026, up to about 1,500 within a year), always including a fixed anchor term
so that values stay comparable between batches, and store one value per tool per day. We would
not resell or republish the raw Trends data. Public pages would show only our combined score and,
on the methodology page, that Google Trends is one of its inputs.

**Why the API and not scraping:** we only use official APIs and respect each provider's terms.
Without API access we leave search interest out of the score rather than scrape Google.

**Expected volume:** one batch run a day. The number of requests depends on the API's batch size;
at most one request per tool per day.

---

# Phase 1, part 1: public pages (M1–M4)

| Module | What is built | Where |
| --- | --- | --- |
| M1 Tool pages | `/tools/{slug}/`: free tier card (plan, quota, card, sign-up, watermark, commercial use, source and date), what it does, best for, pricing, platforms, alternatives, change log. SoftwareApplication JSON-LD. | `apps/web/src/pages/tools/[slug].astro` |
| M2 Browse and search | `/tools/` home with categories, popular tasks and every tool; `/tools/c/{category}/` and `/tools/t/{task}/`. Filters (no card, forever free, open source, commercial use, no watermark, has API, platform) and sort run in the browser. Site search uses a static Pagefind index, so it costs no Worker requests. | `ToolList.astro`, `pages/tools/` |
| M3 Freshness | A free tier not checked for 60 days shows "Not recently verified". The nightly Source check now also checks every tool whose quota has a number, and the review PR names the tool's file. | `lib/directory.js`, `services/pipeline/source_check/tools.py` |
| M4 Clicks | Every Visit button goes to `https://api.freemeans.com/go/{slug}`, which redirects to the tool and adds one row-count to `tool_clicks_daily` (tool, UTC day, country). Bots, link previews, prefetches and repeat clicks by one visitor on one day are not counted. No IP or personal data is stored. | `services/api/src/app.js`, `links.js` |

**Rules kept from the SEO guide:** category and task pages go into the sitemap and search results
only once they list 5 tools; thinner ones are built with `noindex`. Filters and search never create
indexable URLs. Paid or affiliate links carry `rel="sponsored"`, all others `rel="nofollow"`.
URLs follow the PRD: `/tools/c/{category}/` and `/tools/t/{task}/`.

**Not in this part:** the PKR estimate next to prices (no tool has a price yet), `?ref=freemeans`
(added per tool when a vendor allows it), the momentum sparkline (v1.1).

## Switch on part 1 (about 5 minutes)

1. Merge the pull request. Cloudflare rebuilds the site, and `/tools/` goes live.
2. Deploy the API, so `/go/` exists:

   ```powershell
   cd services/api
   npm ci
   npx wrangler secret put CLICK_SALT     # optional: paste any long random text
   npx wrangler deploy
   ```

3. Test it: open `https://api.freemeans.com/go/ollama`. It should land on ollama.com.
4. Start counting clicks in the signal collector. On GitHub: **Settings → Secrets and variables →
   Actions → Variables → New repository variable**: `FREEMEANS_CLICKS_SINCE` = the date of step 2
   (for example `2026-11-10`).

New tools need no API deploy: `/go/` reads the live list at `freemeans.com/tools/links.json`.

---

# Phase 1, part 2: submit form, discovery crawler, editor console (M5, M6, Chapter 7)

| Piece | What is built | Where |
| --- | --- | --- |
| M5 Submit | `/tools/submit/`: URL, name, category, optional email. Works without JavaScript. Cloudflare Turnstile and a honeypot block spam. Entries go to the review queue, never straight to the site. Same answer whether a site was new or already queued. | `apps/web/src/pages/tools/submit.astro`, API `POST /submit` |
| Discovery crawler | Nightly at 01:47 PKT. Finds AI tools on Hacker News (Show HN 20+ points, AI stories 50+), GitHub (young repos with AI topics and 100+ stars) and Hugging Face (trending Spaces). Skips listed and already-queued sites, blocked categories. | `services/crawler`, `.github/workflows/crawler.yml` |
| Drafting | Reads at most 3 pages per site (home, pricing, docs), obeying robots.txt, 1 request a second. Groq drafts the listing (Gemini when Groq is busy). Code, not the LLM, sets slug, address, dates and signals. **Number check:** any free-tier or price number not on the pages next to its unit is blanked and flagged. The result is checked with toolcheck; one retry with the problems, then "needs manual". | `crawler/draft.py` |
| M6 Editor console | `admin.freemeans.com`, sign in with GitHub (only `mcwm04`). Queue with priorities, job status and stale free tiers. Review screen: listing JSON + live site + flags + evidence. Approve commits `data/tools/{slug}.json` as you; reject stores a reason so the site is never queued again. You can also add a tool by hand. | `services/admin` |

New database columns for the queue: `db/migrations/003_review_queue.sql`. One site = one tool
everywhere (API, crawler, console) through the shared rules in `packages/schema/site-key-cases.json`.

**Changed from the PRD:** the console uses GitHub sign-in, not Cloudflare Access, because Cloudflare
Zero Trust asks for a payment card even on its free plan (decided 9 Nov 2026).

## Switch on part 2 (about 30 minutes, all free, no card)

**1. Merge** the pull request. Then update your copy: `git checkout main` and `git pull`.

**2. New queue columns on Neon** (same as before):

```powershell
cd db
$env:DATABASE_URL = "postgresql://...your Neon string..."
npm run migrate          # applied: 003_review_queue.sql
```

**3. Spam check for the submit form (Cloudflare Turnstile).**
1. Cloudflare dashboard → **Turnstile** → **Add widget**. Name `Freemeans submit`, hostnames
   `freemeans.com` and `www.freemeans.com`, widget mode **Managed** → **Create**.
2. Copy the **site key** (public). Open **Workers & Pages → freemeans → Settings → Build →
   Variables and secrets → Add**: name `PUBLIC_TURNSTILE_SITE_KEY`, value the site key. Then
   **Deployments → Retry/redeploy** the latest build, so the form shows the check.
3. Copy the **secret key**, and in PowerShell:

```powershell
cd ..\services\api
npx wrangler secret put TURNSTILE_SECRET   # paste the secret key
npx wrangler deploy
```

**4. GitHub sign-in for the console.** On GitHub: your picture → **Settings → Developer settings →
OAuth Apps → New OAuth App**:
- Application name: `Freemeans editor`
- Homepage URL: `https://freemeans.com`
- Authorization callback URL: `https://admin.freemeans.com/callback`

Click **Register application**, copy the **Client ID**, then **Generate a new client secret** and copy it.

**5. Deploy the console:**

```powershell
cd ..\admin
npm ci
npx wrangler secret put DATABASE_URL          # the Neon string
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET        # paste: [guid]::NewGuid().ToString() + [guid]::NewGuid().ToString()
npx wrangler deploy
```

Open **https://admin.freemeans.com**, click through to GitHub, and allow the app. You should see the
review queue. Approving publishes as your GitHub account.

**6. Free LLM keys for drafting.**
- Groq: **console.groq.com → API Keys → Create API key**.
- Gemini: **aistudio.google.com → Get API key → Create API key**.

Add both on GitHub (**Settings → Secrets and variables → Actions → New repository secret**):
`GROQ_API_KEY` and `GEMINI_API_KEY`. (`DATABASE_URL` is already there from Phase 0.)

**7. First crawl.** **Actions → Crawler → Run workflow** (try `limit` 10 the first time). Read the
**Summary**, then open the console: the drafts are waiting.

If a free model is retired, set the Actions variable `GROQ_MODEL` or `GEMINI_MODEL` to its replacement.

Next: part 3 (M9 weekly email), then the push to 300 verified tools by 21 Dec.
