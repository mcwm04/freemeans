-- Admin dashboard, phase 1: invited users with roles, server-side sessions, login failures and an
-- append-only audit log. Only adds tables, so it is safe on the live database.
CREATE TABLE IF NOT EXISTS admin_users (
  id            bigserial PRIMARY KEY,
  github_login  text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','admin','editor','viewer')),
  active        boolean NOT NULL DEFAULT true,
  invited_by    text,                                   -- login of the person who invited them, null for bootstrap owner
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS admin_users_login_idx ON admin_users (lower(github_login));

CREATE TABLE IF NOT EXISTS admin_sessions (
  id          uuid PRIMARY KEY,
  user_id     bigint NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  ip          text,
  user_agent  text
);
CREATE INDEX IF NOT EXISTS admin_sessions_user_idx ON admin_sessions (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS admin_login_failures (
  id  bigserial PRIMARY KEY,
  ip  text NOT NULL,
  at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS admin_login_failures_idx ON admin_login_failures (ip, at DESC);

-- Who did what, when, from where. Rows can be added but never changed or removed.
CREATE TABLE IF NOT EXISTS admin_audit (
  id           bigserial PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_login  text,
  actor_role   text,
  action       text NOT NULL,                            -- e.g. login, queue.approve, user.role
  target_type  text,
  target_id    text,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,       -- before/after values; never secrets or tokens
  ip           text
);
CREATE INDEX IF NOT EXISTS admin_audit_at_idx ON admin_audit (at DESC);
CREATE INDEX IF NOT EXISTS admin_audit_actor_idx ON admin_audit (actor_login, at DESC);

CREATE OR REPLACE FUNCTION admin_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit is append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS admin_audit_no_change ON admin_audit;
CREATE TRIGGER admin_audit_no_change BEFORE UPDATE OR DELETE ON admin_audit
  FOR EACH ROW EXECUTE FUNCTION admin_audit_immutable();
