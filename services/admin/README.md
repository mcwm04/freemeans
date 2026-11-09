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
