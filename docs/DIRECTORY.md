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

Next: Phase 1 (24 Nov–21 Dec): tool pages, browse and search, `/go` clicks, submit form, editor
console and the discovery crawler.
