// Queue reads and writes. `query(sql, params)` resolves to { rows } (Neon serverless or PGlite in tests).
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const COLS = `id, url, domain, source, source_ref, name, category, status, priority, buzz, draft, evidence, flags,
  reject_reason, submitter_email, attempts, published_slug, reviewed_by, review_note, created_at, reviewed_at`;
const row = (r) => r && { ...r, draft: parse(r.draft), evidence: parse(r.evidence), flags: r.flags ?? [] };

export function queueStore(query) {
  return {
    async counts() {
      const { rows } = await query('SELECT status, count(*)::int AS n FROM tool_candidates GROUP BY status', []);
      return Object.fromEntries(rows.map((r) => [r.status, r.n]));
    },
    async list(statuses, limit = 100) {
      const { rows } = await query(
        `SELECT ${COLS} FROM tool_candidates WHERE status = ANY($1)
         ORDER BY CASE status WHEN 'drafted' THEN 0 WHEN 'needs_manual' THEN 1 ELSE 2 END, priority DESC, id LIMIT $2`,
        [statuses, limit],
      );
      return rows.map(row);
    },
    /** Filtered, paged queue. `q` matches name or domain; `%` and `_` in it are literal. */
    async search({ statuses, source = null, q = null, limit = 50, offset = 0 }) {
      const like = q ? `%${q.replace(/[\\%_]/g, '\\$&')}%` : null;
      const where = `status = ANY($1) AND ($2::text IS NULL OR source = $2) AND ($3::text IS NULL OR name ILIKE $3 OR domain ILIKE $3)`;
      const [{ rows }, total] = await Promise.all([
        query(`SELECT ${COLS} FROM tool_candidates WHERE ${where}
               ORDER BY CASE status WHEN 'drafted' THEN 0 WHEN 'needs_manual' THEN 1 WHEN 'new' THEN 2 ELSE 3 END, priority DESC, id DESC
               LIMIT $4 OFFSET $5`, [statuses, source, like, limit, offset]),
        query(`SELECT count(*)::int AS n FROM tool_candidates WHERE ${where}`, [statuses, source, like]),
      ]);
      return { rows: rows.map(row), total: total.rows[0].n };
    },
    async sources() {
      const { rows } = await query('SELECT DISTINCT source FROM tool_candidates ORDER BY source', []);
      return rows.map((r) => r.source);
    },
    /** Numbers for the Overview page. Clicks come from the public /go counter. */
    async overview() {
      const [clicks, daily, waitlist] = await Promise.all([
        query(`SELECT coalesce(sum(clicks) FILTER (WHERE day > current_date - 7), 0)::int AS d7, coalesce(sum(clicks), 0)::int AS d30
               FROM tool_clicks_daily WHERE day > current_date - 30`, []),
        query(`SELECT day::text AS day, sum(clicks)::int AS n FROM tool_clicks_daily WHERE day > current_date - 14 GROUP BY day ORDER BY day`, []),
        query(`SELECT count(*)::int AS n FROM waitlist WHERE created_at > now() - interval '7 days'`, []),
      ]);
      return { clicks7: clicks.rows[0].d7, clicks30: clicks.rows[0].d30, daily: daily.rows, waitlist7: waitlist.rows[0].n };
    },
    async setNote(id, note) {
      await query('UPDATE tool_candidates SET review_note = $2, updated_at = now() WHERE id = $1', [id, note || null]);
    },
    /** Waitlist numbers and the latest sign-ups. Emails are only returned in `recent` (the view masks them). */
    async waitlist() {
      const [totals, daily, countries, sources, recent] = await Promise.all([
        query(`SELECT count(*)::int AS total, count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS last7 FROM waitlist`, []),
        query(`SELECT created_at::date::text AS day, count(*)::int AS n FROM waitlist WHERE created_at > now() - interval '14 days' GROUP BY 1 ORDER BY 1`, []),
        query(`SELECT coalesce(country, '??') AS k, count(*)::int AS n FROM waitlist GROUP BY 1 ORDER BY n DESC, k LIMIT 10`, []),
        query(`SELECT source AS k, count(*)::int AS n FROM waitlist GROUP BY 1 ORDER BY n DESC, k LIMIT 10`, []),
        query(`SELECT id, email, source, country, created_at FROM waitlist ORDER BY id DESC LIMIT 50`, []),
      ]);
      return { ...totals.rows[0], daily: daily.rows, countries: countries.rows, sources: sources.rows, recent: recent.rows };
    },
    async waitlistAll() {
      const { rows } = await query('SELECT email, source, country, consent_at, created_at FROM waitlist ORDER BY id LIMIT 50000', []);
      return rows;
    },
    /** Outbound clicks between two dates (inclusive), from the public /go counter. */
    async analytics(from, to) {
      const range = [from, to];
      const [totals, byTool, byCountry, byDay] = await Promise.all([
        query('SELECT coalesce(sum(clicks), 0)::int AS total, count(DISTINCT slug)::int AS tools FROM tool_clicks_daily WHERE day BETWEEN $1 AND $2', range),
        query('SELECT slug AS k, sum(clicks)::int AS n FROM tool_clicks_daily WHERE day BETWEEN $1 AND $2 GROUP BY slug ORDER BY n DESC, k LIMIT 20', range),
        query('SELECT country AS k, sum(clicks)::int AS n FROM tool_clicks_daily WHERE day BETWEEN $1 AND $2 GROUP BY country ORDER BY n DESC, k LIMIT 15', range),
        query('SELECT day::text AS k, sum(clicks)::int AS n FROM tool_clicks_daily WHERE day BETWEEN $1 AND $2 GROUP BY day ORDER BY day', range),
      ]);
      return { ...totals.rows[0], byTool: byTool.rows, byCountry: byCountry.rows, byDay: byDay.rows };
    },
    async analyticsRows(from, to) {
      const { rows } = await query('SELECT day::text AS day, slug, country, clicks FROM tool_clicks_daily WHERE day BETWEEN $1 AND $2 ORDER BY day, slug, country LIMIT 100000', [from, to]);
      return rows;
    },
    /** Job history, database size and table sizes for the Health page. */
    async health() {
      const [runs, size, tables] = await Promise.all([
        query('SELECT job, started_at, ended_at, ok, stats FROM job_runs ORDER BY started_at DESC LIMIT 40', []),
        query('SELECT pg_database_size(current_database())::float8 AS bytes', []),
        query(`SELECT 'tool_candidates' AS t, count(*)::int AS n FROM tool_candidates UNION ALL SELECT 'waitlist', count(*)::int FROM waitlist
               UNION ALL SELECT 'tool_clicks_daily', count(*)::int FROM tool_clicks_daily UNION ALL SELECT 'signal_snapshots', count(*)::int FROM signal_snapshots
               UNION ALL SELECT 'admin_audit', count(*)::int FROM admin_audit`, []),
      ]);
      return { runs: runs.rows.map((r) => ({ ...r, stats: parse(r.stats) })), bytes: size.rows[0].bytes, tables: tables.rows };
    },
    async get(id) {
      const { rows } = await query(`SELECT ${COLS} FROM tool_candidates WHERE id = $1`, [id]);
      return row(rows[0]) ?? null;
    },
    async saveDraft(id, draft) {
      await query(`UPDATE tool_candidates SET draft = $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(draft)]);
    },
    async approve(id, slug, login, draft) {
      await query(
        `UPDATE tool_candidates SET status = 'approved', published_slug = $2, reviewed_by = $3, draft = $4::jsonb,
         reviewed_at = now(), updated_at = now() WHERE id = $1`,
        [id, slug, login, JSON.stringify(draft)],
      );
    },
    async reject(id, reason, login) {
      await query(
        `UPDATE tool_candidates SET status = $2, reject_reason = $3, reviewed_by = $4, reviewed_at = now(), updated_at = now() WHERE id = $1`,
        [id, reason === 'duplicate' ? 'duplicate' : 'rejected', reason, login],
      );
    },
    async addEditorSeed({ url, domain, name, login }) {
      const r = await query(
        `INSERT INTO tool_candidates (url, domain, source, name, priority, reviewed_by) VALUES ($1, $2, 'editor', $3, 70, $4)
         ON CONFLICT (domain) DO NOTHING RETURNING id`,
        [url, domain, name, login],
      );
      return r.rows[0]?.id ?? null;
    },
    async lastJobs() {
      const { rows } = await query(
        `SELECT DISTINCT ON (job) job, started_at, ended_at, ok, stats FROM job_runs ORDER BY job, started_at DESC`,
        [],
      );
      return rows.map((r) => ({ ...r, stats: parse(r.stats) }));
    },
  };
}
