-- Eligibility-based offers: students, teachers, institutions, nonprofits, startups, countries.
-- Eligibility PRD, Chapter 4.4. Only widens checks and adds columns, so the live API and site
-- keep working while it runs. The full record (with eligibility, offer_window, watch) stays in
-- resources.record; the columns below exist so the API can filter in SQL.
-- Keep the CHECK lists in step with packages/schema (db/tests/db.test.mjs compares them).

ALTER TABLE resources DROP CONSTRAINT IF EXISTS resources_kind_check;
ALTER TABLE resources ADD CONSTRAINT resources_kind_check CHECK (kind IN (
  'llm_api','speech_api','embedding_api','inference_platform','gpu_notebook','cloud_credit',
  'ai_subscription','software_license','saas_plan','dev_platform','course','certification',
  'library_access','security_service','ad_grant'));

ALTER TABLE badges DROP CONSTRAINT IF EXISTS badges_type_check;
ALTER TABLE badges ADD CONSTRAINT badges_type_check CHECK (type IN (
  'age_18_plus','non_commercial','trains_on_data','eu_restricted','manual_only','not_for_production',
  'payment_method_required','auto_renews_paid','educational_use_only'));

ALTER TABLE limit_rules DROP CONSTRAINT IF EXISTS limit_rules_metric_check;
ALTER TABLE limit_rules ADD CONSTRAINT limit_rules_metric_check CHECK (metric IN (
  'rps','rpm','rpd','requests_per_month','tpm','tpd','itpm','otpm','neurons_per_day',
  'inputs_per_minute','session_hours','credit_usd','seats'));

ALTER TABLE limit_rules DROP CONSTRAINT IF EXISTS limit_rules_window_check;
ALTER TABLE limit_rules ADD CONSTRAINT limit_rules_window_check CHECK ("window" IN (
  'second','minute','day','month','session','year','one_time'));

ALTER TABLE resources
  ADD COLUMN IF NOT EXISTS status       text   NOT NULL DEFAULT 'active'
    CONSTRAINT resources_status_check CHECK (status IN ('active','paused','ended','unverified')),
  ADD COLUMN IF NOT EXISTS redeem_by    date,
  ADD COLUMN IF NOT EXISTS access_ends  date,
  ADD COLUMN IF NOT EXISTS audiences    text[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS country_mode text   NOT NULL DEFAULT 'global'
    CONSTRAINT resources_country_mode_check CHECK (country_mode IN ('global','include','exclude')),
  ADD COLUMN IF NOT EXISTS countries    text[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS resources_audiences_idx ON resources USING gin (audiences);
CREATE INDEX IF NOT EXISTS resources_countries_idx ON resources USING gin (countries);
CREATE INDEX IF NOT EXISTS resources_redeem_by_idx ON resources (redeem_by) WHERE redeem_by IS NOT NULL;

-- Phrases the nightly source check expects on each offer's source page (PRD Chapter 6).
CREATE TABLE IF NOT EXISTS watch_phrases (
  resource_id text NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  position    smallint NOT NULL,
  text        text NOT NULL CHECK (length(text) BETWEEN 3 AND 120),
  source_url  text NOT NULL,
  PRIMARY KEY (resource_id, position)
);

-- Live view of what is claimable today. Expiry by date wins over the stored status, so an
-- offer whose redeem_by (or access_ends) has passed is never shown as active, even before
-- the catalog is reloaded.
CREATE OR REPLACE VIEW resources_live AS
SELECT r.*,
  CASE
    WHEN r.status = 'active' AND (
      (r.redeem_by IS NOT NULL AND r.redeem_by < current_date) OR
      (r.access_ends IS NOT NULL AND r.access_ends < current_date)
    ) THEN 'ended'
    ELSE r.status
  END AS effective_status
FROM resources r;
