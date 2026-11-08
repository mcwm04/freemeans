#!/usr/bin/env node
// Applies every db/migrations/*.sql file not yet recorded in schema_migrations.
// Usage: DATABASE_URL=postgres://... node scripts/migrate.mjs
import { connect, migrate } from './lib.mjs';

const db = await connect();
try {
  const applied = await migrate(db);
  console.log(applied.length ? `applied: ${applied.join(', ')}` : 'database is up to date');
} finally {
  await db.end();
}
