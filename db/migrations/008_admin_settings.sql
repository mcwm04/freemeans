-- Console settings the owner can change without a deploy (dashboard phase 4). Only adds a table.
CREATE TABLE IF NOT EXISTS admin_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
