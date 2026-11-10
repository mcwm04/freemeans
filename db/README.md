# db: Neon Postgres

- `migrations/001_init.sql` creates the tables: `catalog_versions`, `resources` (columns plus the full record as JSONB), `limit_rules`, `badges`, `sources`, `waitlist`. CHECK constraints follow the JSON Schemas in `packages/schema/`.
- `migrations/002_directory.sql` adds the AI tools directory tables.
- `migrations/004_eligibility.sql` adds eligibility-based offers (students, teachers, nonprofits, startups, countries): wider CHECK lists, the columns `status`, `redeem_by`, `access_ends`, `audiences`, `country_mode`, `countries`, the `watch_phrases` table, and the `resources_live` view. In that view, `effective_status` turns to `ended` once `redeem_by` or `access_ends` has passed, even if the catalog has not been reloaded.
- `scripts/migrate.mjs` applies new migrations. It records each one in `schema_migrations`.
- `scripts/load-seed.mjs` loads `data/catalog/seed.json` **and** `data/catalog/eligibility.json` (when it exists) as one catalog, in one transaction. It is safe to repeat. Resources dropped from the catalog are deleted together with their rules, and a failed load changes nothing. Always load both files together: loading one alone would remove the other's rows.

```bash
npm ci
DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=verify-full&channel_binding=require" npm run setup   # migrate + load
npm test   # 17 tests on PGlite (Postgres in WebAssembly, no server needed)
```

Limits with no published number are stored as `NULL`, never 0. The waitlist keeps one lower-case row per email.

When you add a value to an enum in `packages/schema/`, add it to the matching CHECK list in a new migration too. The test "SQL CHECK lists match the JSON schemas exactly" fails until both agree.
