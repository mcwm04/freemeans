# services/api: Freemeans API on Cloudflare Workers

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/health` | `store`: `neon`, `seed`, or `seed (fallback)` |
| GET | `/catalog` | Filters: `kind`, `tier`, `provider`, `q`, `exclude_badges`, `official=true`, `safe_for=client,commercial,eu,production,minors,automation`, `group=students|teachers|institutions|nonprofits|startups`, `format`, `certificate`, `free_certificate=true`, `level`, `credential`, `language`, `role` (for courses), `audience=…` (comma list), `country=PK`, `status=active` (default) or `include_ended=true`, `ending_within_days=60`, `full=true`. Cached for 5 minutes |
| GET | `/resources/{id}` | Full record, or 404 |
| POST | `/waitlist` | JSON or form. Email + consent required, honeypot field `website`. The answer is the same for new and repeat emails |

- `src/app.js` handles requests in plain JavaScript, so tests run in Node.
- `src/store.js` holds the stores. Neon is used when the `DATABASE_URL` secret is set; otherwise the API serves the seed bundled into the Worker. If Neon fails, reads fall back to that seed; writes do not.
- `src/catalog.js` holds the filters. The `safe_for` rules match the agent's policy engine.
- `src/index.js` is the Worker entry point.

```bash
npm ci
npm test              # 12 tests (uses PGlite: real Postgres in memory)
npm run check-bundle  # wrangler dry-run bundle (~63 KB gzipped)
npx wrangler dev      # local Workers runtime at http://127.0.0.1:8787
```

Deploying: see `docs/DEPLOY.md` step 3. On the free plan the API gets 100,000 requests a day; waiting on Neon counts as I/O, not toward the 10 ms CPU limit.

Not covered by the tests: a live connection to Neon (no network in the build environment). The SQL itself is tested on PGlite, and the Neon driver call is three lines in `neonQuery()`. Your first `/health` after deploying is the live test.
