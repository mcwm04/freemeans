// Queue reads and writes. `query(sql, params)` resolves to { rows } (Neon serverless or PGlite in tests).
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const COLS = `id, url, domain, source, source_ref, name, category, status, priority, buzz, draft, evidence, flags,
  reject_reason, submitter_email, attempts, published_slug, reviewed_by, created_at, reviewed_at`;
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
