-- Freemeans catalog + waitlist schema (Neon Postgres, free plan).
-- Mirrors packages/schema/*.schema.json. The full validated record is also kept as JSONB in
-- resources.record, so the API can serve it as-is while the columns support filtering and reports.

CREATE TABLE IF NOT EXISTS catalog_versions (
  version        text PRIMARY KEY,
  generated_at   timestamptz,
  loaded_at      timestamptz NOT NULL DEFAULT now(),
  resource_count integer NOT NULL
);

CREATE TABLE IF NOT EXISTS resources (
  id            text PRIMARY KEY CHECK (id ~ '^[a-z0-9]+(\.[a-z0-9-]+)+$'),
  provider      text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('llm_api','speech_api','embedding_api','inference_platform','gpu_notebook','cloud_credit')),
  tier_type     text NOT NULL CHECK (tier_type IN ('free','trial','credit')),
  endpoint_style text CHECK (endpoint_style IN ('openai_compatible','native','none')),
  base_url      text,
  models        text[] NOT NULL DEFAULT '{}',
  notes         text,
  last_verified date NOT NULL,
  record        jsonb NOT NULL,
  catalog_version text REFERENCES catalog_versions(version),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resources_kind_idx ON resources (kind);
CREATE INDEX IF NOT EXISTS resources_provider_idx ON resources (provider);

CREATE TABLE IF NOT EXISTS limit_rules (
  id           bigserial PRIMARY KEY,
  resource_id  text NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  position     smallint NOT NULL,
  metric       text NOT NULL CHECK (metric IN ('rps','rpm','rpd','requests_per_month','tpm','tpd','itpm','otpm','neurons_per_day','inputs_per_minute','session_hours','credit_usd')),
  value        numeric,                    -- NULL when the provider does not publish the number
  "window"     text NOT NULL CHECK ("window" IN ('second','minute','day','month','session','one_time')),
  reset_kind   text NOT NULL DEFAULT 'unknown' CHECK (reset_kind IN ('rolling','fixed_daily','fixed_monthly','none','unknown')),
  reset_tz     text,
  reset_at     text,
  scope        text,
  conditions   text,
  published    boolean NOT NULL DEFAULT true,
  verified_at  date NOT NULL,
  source_url   text NOT NULL,
  signal_type  text NOT NULL CHECK (signal_type IN ('official_docs','official_api','canary_call','third_party_snapshot','community_report')),
  UNIQUE (resource_id, position)
);
CREATE INDEX IF NOT EXISTS limit_rules_source_idx ON limit_rules (source_url);

CREATE TABLE IF NOT EXISTS badges (
  resource_id text NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  type        text NOT NULL CHECK (type IN ('age_18_plus','non_commercial','trains_on_data','eu_restricted','manual_only','not_for_production','payment_method_required')),
  note        text,
  source_url  text NOT NULL,
  PRIMARY KEY (resource_id, type)
);

CREATE TABLE IF NOT EXISTS sources (
  resource_id text NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  url         text NOT NULL,
  fetched_at  date NOT NULL,
  signal_type text NOT NULL,
  PRIMARY KEY (resource_id, url)
);

-- Waitlist: one row per email (stored lower-case). Consent is required and timestamped.
CREATE TABLE IF NOT EXISTS waitlist (
  id          bigserial PRIMARY KEY,
  email       text NOT NULL UNIQUE CHECK (email = lower(email) AND length(email) <= 254 AND position('@' in email) > 1),
  source      text NOT NULL DEFAULT 'web',
  consent_at  timestamptz NOT NULL,
  country     text,                        -- from Cloudflare's CF-IPCountry header, two letters
  created_at  timestamptz NOT NULL DEFAULT now()
);
