#!/usr/bin/env node
// Loads data/catalog/seed.json and data/catalog/eligibility.json (or the files given as
// arguments) into Neon as one catalog. Safe to run again after every catalog change: it replaces
// the whole catalog in one transaction, so always load all files together.
// Usage: DATABASE_URL=postgres://... node scripts/load-seed.mjs [catalog.json ...]
import { connect, loadCatalog, readCatalogs } from './lib.mjs';

const args = process.argv.slice(2);
const catalog = readCatalogs(args.length ? args : undefined);
const db = await connect();
try {
  const r = await loadCatalog(db, catalog);
  console.log(`loaded catalog ${r.version}: ${r.resources} resources`);
} finally {
  await db.end();
}
