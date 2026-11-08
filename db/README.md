# db: Neon Postgres

- `migrations/001_init.sql` creates the tables: `catalog_versions`, `resources` (columns plus the full record as JSONB), `limit_rules`, `badges`, `sources`, `waitlist`. CHECK constraints follow the JSON Schemas in `packages/schema/`.
- `scripts/migrate.mjs` applies new migrations. It records each one in `schema_migrations`.
- `scripts/load-seed.mjs` loads `data/catalog/seed.json` in one transaction. It is safe to repeat. Resources dropped from the catalog are deleted together with their rules, and a failed load changes nothing.

```bash
npm ci
DATABASE_URL="postgresql://...neon.tech/neondb?sslmode=require" npm run setup   # migrate + load
npm test   # 7 tests on PGlite (Postgres in WebAssembly, no server needed)
```

Limits with no published number are stored as `NULL`, never 0. The waitlist keeps one lower-case row per email.
