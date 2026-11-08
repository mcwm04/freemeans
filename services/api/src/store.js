// Data access for the API. Two stores share one interface:
//   listResources() → { version, resources: [record] }
//   getResource(id) → record | null
//   addToWaitlist({ email, source, country }) → { created: boolean }
// sqlStore reads Neon Postgres; seedStore serves the catalog bundled into the Worker
// (used when DATABASE_URL is not set, and as a read fallback if Neon is unreachable).

export function seedStore(catalog) {
  const byId = new Map(catalog.resources.map((r) => [r.id, r]));
  return {
    kind: 'seed',
    async listResources() {
      return { version: catalog.version, resources: catalog.resources };
    },
    async getResource(id) {
      return byId.get(id) ?? null;
    },
    async addToWaitlist() {
      const err = new Error('The waitlist needs a database. Set the DATABASE_URL secret.');
      err.status = 503;
      throw err;
    },
  };
}

// `query(sql, params)` must resolve to { rows }. See neonQuery() below for Neon.
export function sqlStore(query) {
  return {
    kind: 'neon',
    async listResources() {
      const v = await query('SELECT version FROM catalog_versions ORDER BY loaded_at DESC LIMIT 1', []);
      const r = await query('SELECT record FROM resources ORDER BY provider, name', []);
      return { version: v.rows[0]?.version ?? null, resources: r.rows.map((x) => parse(x.record)) };
    },
    async getResource(id) {
      const r = await query('SELECT record FROM resources WHERE id = $1', [id]);
      return r.rows[0] ? parse(r.rows[0].record) : null;
    },
    async addToWaitlist({ email, source, country }) {
      const r = await query(
        `INSERT INTO waitlist (email, source, consent_at, country) VALUES ($1, $2, now(), $3)
         ON CONFLICT (email) DO NOTHING RETURNING id`,
        [email, source, country],
      );
      return { created: r.rows.length > 0 };
    },
  };
}

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

// Reads go to Neon first; if Neon fails (cold start error, outage, quota), serve the bundled
// seed so the catalog stays up. Writes never fall back: a lost waitlist row must be an error.
export function withFallback(primary, fallback) {
  return {
    kind: primary.kind,
    async listResources() {
      try {
        return await primary.listResources();
      } catch (err) {
        return { ...(await fallback.listResources()), fallback: describe(err) };
      }
    },
    async getResource(id) {
      try {
        return await primary.getResource(id);
      } catch {
        return fallback.getResource(id);
      }
    },
    addToWaitlist: (entry) => primary.addToWaitlist(entry),
  };
}

const describe = (err) => String(err?.message ?? err).slice(0, 120);

// Neon's serverless driver talks HTTPS, which suits Workers (no TCP pool to keep warm).
export async function neonQuery(databaseUrl) {
  const { neon } = await import('@neondatabase/serverless');
  const sql = neon(databaseUrl);
  return async (text, params) => ({ rows: await sql.query(text, params) });
}
