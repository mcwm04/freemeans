#!/usr/bin/env node
// Loads data/catalog/seed.json (or the file given as the first argument) into Neon.
// Safe to run again after every catalog change: it replaces the catalog in one transaction.
// Usage: DATABASE_URL=postgres://... node scripts/load-seed.mjs [path/to/catalog.json]
import { connect, loadCatalog, readSeed } from './lib.mjs';

const catalog = readSeed(process.argv[2]);
const db = await connect();
try {
  const r = await loadCatalog(db, catalog);
  console.log(`loaded catalog ${r.version}: ${r.resources} resources`);
} finally {
  await db.end();
}
