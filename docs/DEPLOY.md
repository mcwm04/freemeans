# Deploy Freemeans for $0 (no card)

This guide puts the whole Step 2 stack online on free plans. None of the services below asks for a payment card. Plan on about an hour the first time.

| Part | Runs on | Free plan (checked 8 Nov 2026) | What happens at the limit |
| --- | --- | --- | --- |
| Website `apps/web` | Cloudflare Pages | 500 builds/month; static requests and bandwidth unlimited | Builds wait for next month; the live site keeps working |
| API `services/api` | Cloudflare Workers | 100,000 requests/day, 10 ms CPU per request | API answers with an error until 00:00 UTC |
| Database `db/` | Neon Postgres | 100 CU-hours/month and 1 GB storage per project | Writes that grow storage fail; reads keep working |
| Nightly check `services/pipeline` | GitHub Actions | Unlimited minutes on public repos, 2,000/month on private | Runs stop until next month (private repos only) |

**The one thing that costs money is the domain.** freemeans.com is registered with Cloudflare Registrar (bought 8 Nov 2026). It already uses Cloudflare's free DNS, so no nameserver change is needed.

Commands below are shown for **Windows PowerShell** first, then macOS/Linux. You need Node.js 22, Python 3.12 and Git.

---

## 1. Put the code on GitHub

1. Create a repository at github.com/new, for example `tekdigix/freemeans`. A **public** repo gives the nightly check unlimited minutes. A private one gives 2,000 minutes a month, which is still plenty (a run takes about a minute).
2. Push the code:

   ```powershell
   cd freemeans
   git init
   git add .
   git commit -m "Freemeans step 2"
   git branch -M main
   git remote add origin https://github.com/<you>/freemeans.git
   git push -u origin main
   ```

3. Open the **Actions** tab. The **CI** workflow runs every test suite on each push, and it should go green.

## 2. Create the database on Neon

1. Sign up at neon.com with your GitHub account. No card is needed.
2. **Create project.** Name: `freemeans`. Postgres version: the default. Region: **AWS Asia Pacific (Singapore)**, the closest to Pakistan.
3. Open **Dashboard → Connect**. Turn on **Connection pooling** and copy the connection string. It looks like `postgresql://...@ep-xxxx-pooler.ap-southeast-1.aws.neon.tech/neondb?sslmode=require`.
4. Create the tables and load the catalog:

   ```powershell
   cd db
   npm ci
   $env:DATABASE_URL = "postgresql://...-pooler...neon.tech/neondb?sslmode=require"
   npm run setup        # = migrate + load-seed
   ```

   ```bash
   # macOS / Linux
   cd db && npm ci
   DATABASE_URL="postgresql://..." npm run setup
   ```

   You should see `applied: 001_init.sql` and then `loaded catalog 0.1.0-seed: 15 resources`.

   Run `npm run load-seed` again whenever `data/catalog/seed.json` changes. The loader replaces the catalog in one transaction, so it is safe to repeat.

> Keep the connection string secret. It goes only into your terminal and into Cloudflare's secret store (step 3), never into a file in the repo.

## 3. Deploy the API on Cloudflare Workers

1. Sign up at dash.cloudflare.com on the **Free** plan. No card is needed.
2. Log in from your computer and deploy:

   ```powershell
   cd services/api
   npm ci
   npx wrangler login                      # opens the browser once
   npx wrangler secret put DATABASE_URL    # paste the Neon pooled string
   npx wrangler deploy
   ```

   Wrangler prints the address, for example `https://freemeans-api.<your-subdomain>.workers.dev`.
3. Test it:

   ```powershell
   curl https://freemeans-api.<your-subdomain>.workers.dev/health
   # "store": "neon", "catalog_version": "0.1.0-seed"
   curl "https://freemeans-api.<your-subdomain>.workers.dev/catalog?safe_for=client"
   ```

   If `/health` shows `"store": "seed"`, the `DATABASE_URL` secret is missing. Run `npx wrangler secret list` to check.

**API endpoints**

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/health` | Status, store in use (`neon`, `seed`, or `seed (fallback)`), catalog version |
| GET | `/catalog` | Summaries. Filters: `kind`, `tier`, `provider`, `q`, `exclude_badges`, `official=true`, `safe_for=client,commercial,eu,production,minors,automation`, `full=true` |
| GET | `/resources/{id}` | Full record, e.g. `/resources/groq.gpt-oss-120b` |
| POST | `/waitlist` | JSON `{ "email", "consent": true, "source" }` or a normal HTML form post (redirects back to the site) |

If Neon cannot be reached, catalog reads fall back to the copy bundled into the Worker and add the header `x-freemeans-fallback: seed`. Waitlist sign-ups never fall back: they fail loudly instead, so no email is lost silently.

## 4. Deploy the website on Cloudflare Pages

1. In the Cloudflare dashboard, open **Workers & Pages → Create → Pages → Connect to Git**, then pick your `freemeans` repository. (Cloudflare changes this menu from time to time. If the wording differs, look for "Pages" and "Import a Git repository".)
2. Build settings:

   | Setting | Value |
   | --- | --- |
   | Framework preset | Astro |
   | Root directory | `apps/web` |
   | Build command | `npm run build` |
   | Build output directory | `dist` |
   | Environment variable `NODE_VERSION` | `22` |
   | Environment variable `PUBLIC_API_URL` | your Worker address from step 3 (later `https://api.freemeans.com`) |

3. Click **Save and Deploy**. The site appears at `https://<project>.pages.dev`. Every push to `main` redeploys it, and every pull request gets its own preview address.

The pages are built from `data/catalog/seed.json`. To change what the site shows, edit that file and push.

## 5. Connect freemeans.com

The domain was bought on Cloudflare, so it already sits in your Cloudflare account with Cloudflare DNS. There are no nameservers to change and nothing to wait for.

1. **Secure the domain** (do this once). Open **Domain Registration → Manage domains → freemeans.com**:
   - **Auto-renew:** make sure it is on, so the domain never lapses.
   - **Registrar lock:** make sure it is on. It stops anyone transferring the domain away.
   - **DNSSEC:** in the domain's **DNS → Settings**, enable DNSSEC. On Cloudflare Registrar domains this is one click.
2. **Website:** open the Pages project → **Custom domains** → add `freemeans.com`, then `www.freemeans.com`. Cloudflare creates the DNS records and the HTTPS certificate.
3. **API:** in `services/api/wrangler.toml`, uncomment the `routes` block for `api.freemeans.com`, then run `npx wrangler deploy` again.
4. In the Pages project, set `PUBLIC_API_URL` to `https://api.freemeans.com`, then **Retry deployment**.
5. Check that `ALLOWED_ORIGINS` in `wrangler.toml` lists every address the site is served from. Otherwise the browser blocks the waitlist form.

### Free email at hello@freemeans.com

Cloudflare Email Routing forwards mail sent to addresses at freemeans.com into your Gmail, at no cost.

1. Open **freemeans.com → Email → Email Routing → Get started**.
2. Create the address `hello@freemeans.com` with the action **Send to an email** (your Gmail). Cloudflare emails Gmail a link: click it to verify.
3. Let Cloudflare add the MX and SPF records it offers.
4. Send a test message from another account to hello@freemeans.com.

Email Routing only receives and forwards. To *reply* as hello@freemeans.com, add it in Gmail under **Settings → Accounts → Send mail as**, which needs an outgoing mail service. That is a later step.

## 6. Turn on the nightly source check

1. In GitHub, open **Settings → Actions → General → Workflow permissions**. Tick **Allow GitHub Actions to create and approve pull requests**, then click **Save**.
2. Open **Actions → Source check → Run workflow** to try it now. After that it runs every night at 02:17 Pakistan time.
3. Read the result in the run's **Summary**. If a limit's number has disappeared from its source page, the workflow opens one pull request, **"Source check: N limit(s) may have changed"**. To review it:
   - open each source link in the PR;
   - edit `data/catalog/seed.json` in the same PR: new `value`, today's `verified_at`;
   - merge it. Pages rebuilds the site automatically. Then run `npm run load-seed` (step 2) to update the API's database.

   Later runs update the same PR instead of opening new ones. Pages that need JavaScript, or that block bots, appear under *Could not read*. Check those by hand, or switch the limit's `source_url` to an official docs page or a Markdown version of it.

## 7. Final checks

- [ ] `https://freemeans.com` shows the home page, and the Urdu tagline renders in Nastaliq.
- [ ] `https://freemeans.com/catalog/` lists 15 resources, and the filters work.
- [ ] `https://api.freemeans.com/health` shows `"store": "neon"`.
- [ ] Join the waitlist from the home page. The row then appears in Neon (**Tables → waitlist**).
- [ ] The CI workflow is green, and the Source check workflow has run once.

## Where the limits will bite first

1. **Workers' 100,000 requests a day.** The website itself does not use this budget, because its pages are static. Only API calls count. Upgrading means the Workers Paid plan, about US$5 a month.
2. **Neon's 1 GB.** That is millions of waitlist rows, so it is far away. Neon's next plan is usage-based.
3. **Neon's compute hours.** The database sleeps when idle, and the first request after a sleep is a little slower.

## Privacy notes

- The waitlist stores the email, the page it came from, the consent time and the two-letter country (from Cloudflare). Nothing else is stored.
- To delete a person on request: `DELETE FROM waitlist WHERE email = 'their@email';` in Neon's SQL editor.
- Every API answer is the same whether an email was new or already on the list. So nobody can use the form to check who signed up.
