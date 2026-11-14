# services/admin: editor console (M6)

A small Cloudflare Worker at **admin.freemeans.com**. It's private: you sign in with GitHub, and only
the logins in `ALLOWED_GITHUB_USERS` (wrangler.toml) are let in.

- **Queue:** crawler drafts, submissions and editor seeds, drafted ones first, by priority. Also shows
  the last run of each job and the free tiers not checked for 30+ days.
- **Review:** the listing as JSON on the left, the live site on the right, plus the crawler's flags
  (`number_blanked` = a number the page did not show was removed) and the evidence sentences.
  **Check** validates, **Save draft** keeps edits, **Approve and publish** commits
  `data/tools/{slug}.json` to `main` as you. Cloudflare rebuilds the site in about 3 minutes.
- **Reject** stores a fixed reason (duplicate, dead site, out of scope, unsafe, parked, not AI, other).
  A rejected site is never queued again.

The same checks as `services/toolcheck` run before every commit, and toolcheck runs again in CI.

```bash
npm ci
npm test                 # PGlite + fake GitHub, no network
npx wrangler deploy      # after the secrets in wrangler.toml are set
```

## Accounts, roles and audit log (dashboard phase 1)

- **Invite-only.** People sign in with GitHub. Logins in `ALLOWED_GITHUB_USERS` become **owners** on first sign-in (bootstrap); everyone else must be invited on the **Users** page.
- **Roles:** owner (everything), admin (users, audit log, all content), editor (review and publish), viewer (read only). The matrix is in `src/permissions.js` and is checked on the server for every route.
- **Sessions** are stored in the database, so "Sign out", deactivating a user and "Sign out everywhere else" take effect at once.
- **Safety:** CSRF token in every form, 10 failed sign-ins per IP in 15 minutes locks that IP out, and the **Audit log** (append-only) records every change.
- **Before you deploy:** run the new migration first. PowerShell: `cd db; $env:DATABASE_URL="<your Neon string>"; npm run migrate`. Then `cd ..\services\admin; npx wrangler deploy`.
- Not yet built: email magic-link sign-in and two-factor (later phase).

## Overview and bulk review (dashboard phase 2)

- `/` is the **Overview**: pending reviews, drafted, outbound clicks (7 and 30 days, from the `/go` counter), stale free tiers, failed jobs, waitlist sign-ups (count only), a 14-day clicks chart, and recent activity (admins and owners only).
- `/queue` is the **review queue**: filter by status and source, search name or domain, 50 per page.
- **Bulk actions** (editors and up): reject up to 50 with one reason, or approve up to 10 drafts. Approve needs the "Yes, publish" box, publishes only drafts that pass every check, and lists what it skipped and why. Each item gets its own audit row.
- Pages use no JavaScript (the console's CSP blocks it), so there is no "select all" box.

## Tools, offers, waitlist and notes (dashboard phase 3)

- **Tools** (`/tools`): every file in `data/tools/`. Editors change the JSON, run the same checks as CI, and save as a GitHub commit under their name. Publish, Hide and Remove change only `status` and add a changelog line. If the file changed on GitHub since the page opened, the save is refused.
- **Offers** (`/offers`): records in `data/catalog/eligibility.json` and `learning.json`, with flags for re-check (30+ days), ending soon, past redeem date, unverified and ended. Saving checks the schema plus the honest-offer rules (auto-renew badge, paid certificate, and so on) and rewrites only the one record. "Mark re-checked today" needs the confirm box. After a merge, the owner runs `npm run load-seed` in `db/`.
- **Waitlist** (`/waitlist`, admins and owners): totals, by country and source, latest 50 with masked emails. The CSV with full emails is audited and neutralises spreadsheet formulas.
- **Reviewer notes** on the review page (migration 007).
- Viewers can read tools and offers; editors can change them.

## Analytics, health, settings and controls (dashboard phase 4)

- **Analytics** (`/analytics`, everyone): outbound clicks for any range up to a year, top tools, countries, a daily chart and a CSV download. Data is the public `/go` counter (tool, day, country only).
- **Health** (`/health`, admins): database size against the 1 GB Neon limit, table row counts, recent job runs with failures, and links to GitHub Actions, Cloudflare and Neon. Workers requests and Neon compute hours are only shown by those providers; this console holds none of their API keys.
- **Settings** (`/settings`, owners edit, admins read): days before a re-check, sign-in length, failed-login lock-out. Values are bounded, applied at once and audited with old and new value.
- **Controls** (`/controls`, admins): Rebuild now (needs the optional secret `DEPLOY_HOOK_URL`; once every 2 minutes), run a GitHub workflow with your own sign-in (once a minute each; the workflow must allow manual runs), and an owner-only cleanup of old sessions and sign-in failures that needs the typed word CLEANUP and never touches the audit log.
- Migration `008_admin_settings.sql` must be applied before deploying.
