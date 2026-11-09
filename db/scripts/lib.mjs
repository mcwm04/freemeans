// Shared database helpers. Every function takes a small `db` object with two methods:
//   db.exec(sql)            run one or more statements, no parameters (migrations)
//   db.query(sql, params)   run one statement with $1, $2 … parameters, resolves to { rows }
// node-postgres (pg) and PGlite (used in tests) both fit this shape directly.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = resolve(here, '../migrations');
export const SEED_PATH = resolve(here, '../../data/catalog/seed.json');
// Eligibility-based offers (students, teachers, nonprofits, startups, countries) live in their own
// file so the agent's API-tier catalog stays clean. Both files are loaded together, because the
// loader replaces the whole catalog: loading one file alone would delete the other's rows.
export const ELIGIBILITY_PATH = resolve(here, '../../data/catalog/eligibility.json');
export const DEFAULT_CATALOG_PATHS = [SEED_PATH, ELIGIBILITY_PATH];

export async function migrate(db, dir = MIGRATIONS_DIR) {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = readFileSync(resolve(dir, f), 'utf8');
    await db.exec('BEGIN');
    try {
      await db.exec(sql);
      await db.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
      await db.exec('COMMIT');
    } catch (err) {
      await db.exec('ROLLBACK');
      throw new Error(`migration ${f} failed: ${err.message}`);
    }
    applied.push(f);
  }
  return applied;
}

export function readSeed(path = SEED_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// Merges several catalog files into one bundle. The version records every part, e.g.
// "0.1.0-seed+0.1.0-eligibility". Files that do not exist are skipped, so the loader works
// before data/catalog/eligibility.json is added.
export function mergeCatalogs(catalogs) {
  const parts = catalogs.filter(Boolean);
  if (parts.length === 1) return parts[0];
  return {
    version: parts.map((c) => c.version).join('+'),
    generated_at: parts.map((c) => c.generated_at).filter(Boolean).sort().at(-1) ?? null,
    resources: parts.flatMap((c) => c.resources ?? []),
  };
}

export function readCatalogs(paths = DEFAULT_CATALOG_PATHS) {
  return mergeCatalogs(paths.filter((p) => existsSync(p)).map((p) => readSeed(p)));
}

// Values for the eligibility columns (migration 003). API-tier resources get the defaults.
export function eligibilityColumns(r) {
  const c = r.eligibility?.countries ?? { mode: 'global', codes: [] };
  return {
    status: r.status ?? 'active',
    redeem_by: r.offer_window?.redeem_by ?? null,
    access_ends: r.offer_window?.access_ends ?? null,
    audiences: r.eligibility?.audiences ?? [],
    country_mode: c.mode ?? 'global',
    countries: c.codes ?? [],
  };
}

// Light checks before anything touches the database; the full JSON-Schema check lives in
// the agent (`freemeans validate-catalog`) and runs in CI.
export function checkCatalog(catalog) {
  const errors = [];
  if (!catalog || !Array.isArray(catalog.resources)) return ['catalog has no resources array'];
  if (!catalog.version) errors.push('catalog has no version');
  const ids = new Set();
  for (const r of catalog.resources) {
    if (!r.id) errors.push('a resource has no id');
    else if (ids.has(r.id)) errors.push(`duplicate id ${r.id}`);
    ids.add(r.id);
    if (!Array.isArray(r.limit_rules)) errors.push(`${r.id}: limit_rules missing`);
    if (!Array.isArray(r.sources) || r.sources.length === 0) errors.push(`${r.id}: needs at least one source`);
    const after = r.offer_window?.after;
    const renewBadge = (r.badges ?? []).some((b) => b.type === 'auto_renews_paid');
    if (after?.auto_renews && !renewBadge) errors.push(`${r.id}: auto-renewing offer needs the auto_renews_paid badge`);
  }
  return errors;
}

// Loads (or re-loads) the whole catalog in one transaction. Idempotent: running it twice
// gives the same rows. Resources missing from the new catalog are removed, with their rules.
export async function loadCatalog(db, catalog) {
  const errors = checkCatalog(catalog);
  if (errors.length) throw new Error('catalog check failed:\n- ' + errors.join('\n- '));

  await db.exec('BEGIN');
  try {
    await db.query(
      `INSERT INTO catalog_versions (version, generated_at, resource_count) VALUES ($1, $2, $3)
       ON CONFLICT (version) DO UPDATE SET generated_at = EXCLUDED.generated_at,
         resource_count = EXCLUDED.resource_count, loaded_at = now()`,
      [catalog.version, catalog.generated_at ?? null, catalog.resources.length],
    );
    const ids = catalog.resources.map((r) => r.id);
    await db.query('DELETE FROM resources WHERE NOT (id = ANY($1::text[]))', [ids]);

    for (const r of catalog.resources) {
      const e = eligibilityColumns(r);
      await db.query(
        `INSERT INTO resources (id, provider, name, kind, tier_type, endpoint_style, base_url, models,
            notes, last_verified, record, catalog_version, status, redeem_by, access_ends, audiences,
            country_mode, countries, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18, now())
         ON CONFLICT (id) DO UPDATE SET provider = EXCLUDED.provider, name = EXCLUDED.name,
           kind = EXCLUDED.kind, tier_type = EXCLUDED.tier_type, endpoint_style = EXCLUDED.endpoint_style,
           base_url = EXCLUDED.base_url, models = EXCLUDED.models, notes = EXCLUDED.notes,
           last_verified = EXCLUDED.last_verified, record = EXCLUDED.record,
           catalog_version = EXCLUDED.catalog_version, status = EXCLUDED.status,
           redeem_by = EXCLUDED.redeem_by, access_ends = EXCLUDED.access_ends,
           audiences = EXCLUDED.audiences, country_mode = EXCLUDED.country_mode,
           countries = EXCLUDED.countries, updated_at = now()`,
        [r.id, r.provider, r.name, r.kind, r.tier_type, r.endpoint?.style ?? null, r.endpoint?.base_url ?? null,
          r.models ?? [], r.notes ?? null, r.last_verified, JSON.stringify(r), catalog.version,
          e.status, e.redeem_by, e.access_ends, e.audiences, e.country_mode, e.countries],
      );
      for (const table of ['limit_rules', 'badges', 'sources', 'watch_phrases'])
        await db.query(`DELETE FROM ${table} WHERE resource_id = $1`, [r.id]);

      for (const [i, l] of r.limit_rules.entries()) {
        await db.query(
          `INSERT INTO limit_rules (resource_id, position, metric, value, "window", reset_kind, reset_tz,
             reset_at, scope, conditions, published, verified_at, source_url, signal_type)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [r.id, i, l.metric, l.value ?? null, l.window, l.reset?.kind ?? 'unknown', l.reset?.tz ?? null,
            l.reset?.at ?? null, l.scope ?? null, l.conditions ?? null, l.published ?? true, l.verified_at,
            l.source_url, l.signal_type],
        );
      }
      for (const b of r.badges ?? []) {
        await db.query(
          `INSERT INTO badges (resource_id, type, note, source_url) VALUES ($1,$2,$3,$4)
           ON CONFLICT (resource_id, type) DO NOTHING`,
          [r.id, b.type, b.note ?? null, b.source_url],
        );
      }
      for (const s of r.sources) {
        await db.query(
          `INSERT INTO sources (resource_id, url, fetched_at, signal_type) VALUES ($1,$2,$3,$4)
           ON CONFLICT (resource_id, url) DO UPDATE SET fetched_at = EXCLUDED.fetched_at,
             signal_type = EXCLUDED.signal_type`,
          [r.id, s.url, s.fetched_at, s.signal_type],
        );
      }
      for (const [i, w] of (r.watch ?? []).entries()) {
        await db.query(
          'INSERT INTO watch_phrases (resource_id, position, text, source_url) VALUES ($1,$2,$3,$4)',
          [r.id, i, w.text, w.source_url],
        );
      }
    }
    await db.exec('COMMIT');
  } catch (err) {
    await db.exec('ROLLBACK');
    throw err;
  }
  return { version: catalog.version, resources: catalog.resources.length };
}

// Opens a node-postgres connection to Neon from DATABASE_URL (sslmode=require is in Neon's string).
export async function connect(url = process.env.DATABASE_URL) {
  if (!url) {
    throw new Error('DATABASE_URL is not set. Copy the connection string from the Neon console (Dashboard → Connect).');
  }
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return {
    exec: (sql) => client.query(sql),
    query: (sql, params) => client.query(sql, params),
    end: () => client.end(),
  };
}
