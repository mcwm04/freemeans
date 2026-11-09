-- Review queue details for the discovery crawler (PRD 7.1–7.4), the submit form (M5) and the
-- editor console (M6). Only adds columns, so it is safe on the live database.
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS name        text;      -- from the source or the submitter
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS category    text;      -- submitter's category hint
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS buzz        real;      -- HN points / star growth / likes at discovery
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS evidence    jsonb;     -- sentence each free-tier value came from (editor only)
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS flags       text[] NOT NULL DEFAULT '{}';  -- e.g. number_blanked:quota
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS attempts    integer NOT NULL DEFAULT 0;    -- drafting attempts
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS published_slug text;   -- set when approved
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now();
ALTER TABLE tool_candidates ADD COLUMN IF NOT EXISTS reviewed_by text;      -- GitHub login of the editor
-- Rejection reasons are a fixed list so the crawler can learn what to skip (PRD 3.7).
ALTER TABLE tool_candidates DROP CONSTRAINT IF EXISTS tool_candidates_reject_reason_check;
ALTER TABLE tool_candidates ADD CONSTRAINT tool_candidates_reject_reason_check
  CHECK (reject_reason IS NULL OR reject_reason IN ('duplicate','dead_site','out_of_scope','unsafe','parked','no_ai','other'));
CREATE INDEX IF NOT EXISTS tool_candidates_created_idx ON tool_candidates (created_at DESC);
