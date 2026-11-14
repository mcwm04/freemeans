// Users, sessions, login failures and the audit log. `query(sql, params)` resolves to { rows }.
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const USER = 'id, github_login, role, active, invited_by, created_at, last_login_at';

export function accountStore(query) {
  const one = async (text, params) => (await query(text, params)).rows[0] ?? null;
  return {
    findUser: (login) => one(`SELECT ${USER} FROM admin_users WHERE lower(github_login) = lower($1)`, [login]),
    getUser: (id) => one(`SELECT ${USER} FROM admin_users WHERE id = $1`, [id]),
    async listUsers() {
      const { rows } = await query(
        `SELECT u.id, u.github_login, u.role, u.active, u.invited_by, u.created_at, u.last_login_at,
           (SELECT count(*)::int FROM admin_sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > now()) AS live_sessions
         FROM admin_users u ORDER BY u.active DESC, u.id`, []);
      return rows;
    },
    createUser: ({ login, role, invitedBy }) => one(
      `INSERT INTO admin_users (github_login, role, invited_by) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING ${USER}`, [login, role, invitedBy ?? null]),
    async setRole(id, role) { await query('UPDATE admin_users SET role = $2 WHERE id = $1', [id, role]); },
    async setActive(id, active) { await query('UPDATE admin_users SET active = $2 WHERE id = $1', [id, active]); },
    async activeOwners() {
      return (await one(`SELECT count(*)::int AS n FROM admin_users WHERE role = 'owner' AND active`, [])).n;
    },
    async touchLogin(id) { await query('UPDATE admin_users SET last_login_at = now() WHERE id = $1', [id]); },

    async createSession({ id, userId, expiresAt, ip, userAgent }) {
      await query('INSERT INTO admin_sessions (id, user_id, expires_at, ip, user_agent) VALUES ($1, $2, $3, $4, $5)',
        [id, userId, expiresAt, ip, (userAgent || '').slice(0, 200)]);
    },
    /** The live session joined with its user, or null when it is revoked, expired or the user is deactivated. */
    getSession: (id) => one(
      `SELECT s.id AS sid, s.user_id, u.github_login AS login, u.role
       FROM admin_sessions s JOIN admin_users u ON u.id = s.user_id
       WHERE s.id = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.active`, [id]),
    async revokeSession(id) { await query('UPDATE admin_sessions SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]); },
    /** Revokes every live session of a user, optionally keeping one. Returns how many were revoked. */
    async revokeAll(userId, exceptId = null) {
      const { rows } = await query(
        `UPDATE admin_sessions SET revoked_at = now()
         WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR id <> $2::uuid) RETURNING id`, [userId, exceptId]);
      return rows.length;
    },
    async listSessions(userId) {
      const { rows } = await query(
        `SELECT id, created_at, expires_at, ip, user_agent FROM admin_sessions
         WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`, [userId]);
      return rows;
    },

    async recordFailure(ip) { await query('INSERT INTO admin_login_failures (ip) VALUES ($1)', [ip]); },
    async failuresSince(ip, minutes) {
      return (await one(
        `SELECT count(*)::int AS n FROM admin_login_failures WHERE ip = $1 AND at > now() - make_interval(mins => $2)`, [ip, minutes])).n;
    },

    async getSettings() {
      const { rows } = await query('SELECT key, value FROM admin_settings', []);
      return Object.fromEntries(rows.map((r) => [r.key, parse(r.value)]));
    },
    async setSetting(key, value, login) {
      await query(
        `INSERT INTO admin_settings (key, value, updated_by) VALUES ($1, $2::jsonb, $3)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [key, JSON.stringify(value), login]);
    },
    /** Housekeeping: old ended sessions and login failures. Never touches the audit log. */
    async cleanup() {
      const sessions = await query(`DELETE FROM admin_sessions WHERE COALESCE(revoked_at, expires_at) < now() - interval '30 days' RETURNING id`, []);
      const failures = await query(`DELETE FROM admin_login_failures WHERE at < now() - interval '7 days' RETURNING id`, []);
      return { sessions: sessions.rows.length, failures: failures.rows.length };
    },
    /** How many times an action was recorded for a target in the last `seconds` (used to rate-limit controls). */
    async recentCount(action, targetId, seconds) {
      const r = await query(
        `SELECT count(*)::int AS n FROM admin_audit WHERE action = $1 AND ($2::text IS NULL OR target_id = $2) AND at > now() - make_interval(secs => $3)`,
        [action, targetId, seconds]);
      return r.rows[0].n;
    },
    async audit({ actor, action, targetType = null, targetId = null, detail = {}, ip = null }) {
      await query(
        `INSERT INTO admin_audit (actor_login, actor_role, action, target_type, target_id, detail, ip)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
        [actor?.login ?? null, actor?.role ?? null, action, targetType, targetId == null ? null : String(targetId), JSON.stringify(detail), ip]);
    },
    async listAudit({ actor = null, action = null, limit = 200 } = {}) {
      const { rows } = await query(
        `SELECT id, at, actor_login, actor_role, action, target_type, target_id, detail, ip FROM admin_audit
         WHERE ($1::text IS NULL OR lower(actor_login) = lower($1)) AND ($2::text IS NULL OR action LIKE $2 || '%')
         ORDER BY id DESC LIMIT $3`, [actor, action, Math.min(limit, 500)]);
      return rows.map((r) => ({ ...r, detail: parse(r.detail) }));
    },
  };
}
