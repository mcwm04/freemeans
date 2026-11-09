-- AI tools directory (PRD Chapter 5.3). Daily data only: published listings live in Git
-- (data/tools/{slug}.json), and the tool's slug joins the two. Neon free plan, about
-- 150–200 MB after year 1 at 1,500 tools.

-- Candidate tools found by the discovery crawler or sent through /tools/submit.
CREATE TABLE IF NOT EXISTS tool_candidates (
  id              bigserial PRIMARY KEY,
  url             text NOT NULL,
  domain          text NOT NULL,              -- de-duplication key: registrable domain, or host/path on shared platforms
  source          text NOT NULL CHECK (source IN ('producthunt','hn','github','hf','submit','editor')),
  source_ref      text,                       -- e.g. HN story id, GitHub repo
  draft           jsonb,                      -- LLM-drafted tool record (validated against tool.schema.json)
  status          text NOT NULL DEFAULT 'new'
                  CHECK (status IN ('new','drafted','needs_manual','approved','rejected','duplicate')),
  reject_reason   text,
  submitter_email text CHECK (submitter_email IS NULL OR (submitter_email = lower(submitter_email) AND length(submitter_email) <= 254)),
  priority        int  NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 100),
  created_at      timestamptz NOT NULL DEFAULT now(),
  reviewed_at     timestamptz,
  UNIQUE (domain)
);
CREATE INDEX IF NOT EXISTS tool_candidates_queue_idx ON tool_candidates (status, priority DESC);

-- One wide row per tool per day: raw signal values. NULL = not measured (skipped in scoring),
-- never "zero". Running totals (stars, likes) are stored as totals; growth is computed later.
CREATE TABLE IF NOT EXISTS signal_snapshots (
  slug          text NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  day           date NOT NULL,              -- UTC day the values describe
  trends        real     CHECK (trends >= 0),        -- Google Trends interest (when API access exists)
  wiki_views    integer  CHECK (wiki_views >= 0),    -- Wikimedia pageviews, all platforms, user agents
  gh_stars      integer  CHECK (gh_stars >= 0),      -- total stars at end of day
  hn_points     integer  CHECK (hn_points >= 0),     -- sum of points of stories created that day
  hf_likes      integer  CHECK (hf_likes >= 0),      -- total Hugging Face likes
  hf_downloads  integer  CHECK (hf_downloads >= 0),  -- Hugging Face downloads, rolling 30 days (as the Hub reports it)
  ph_votes      integer  CHECK (ph_votes >= 0),      -- Product Hunt votes (off until Product Hunt allows commercial use)
  our_clicks    integer  CHECK (our_clicks >= 0),    -- from tool_clicks_daily
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, day)
);
CREATE INDEX IF NOT EXISTS signal_snapshots_day_idx ON signal_snapshots (day);

-- History loads that only need to happen once per tool and signal (PRD 6.5).
CREATE TABLE IF NOT EXISTS signal_backfills (
  slug        text NOT NULL,
  signal      text NOT NULL CHECK (signal IN ('wiki','hn','github')),
  status      text NOT NULL CHECK (status IN ('done','partial','too_large','failed')),
  first_day   date,
  last_day    date,
  rows_written integer NOT NULL DEFAULT 0,
  note        text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, signal)
);

-- Computed scores per window. Only the top 50 per list are kept (PRD 5.5).
CREATE TABLE IF NOT EXISTS trending_scores (
  slug          text NOT NULL,
  window_kind   text NOT NULL CHECK (window_kind IN ('day','week','month','year')),
  period        text NOT NULL,              -- 2026-11-09 | 2026-W46 | 2026-11 | 2026
  score         real NOT NULL CHECK (score BETWEEN 0 AND 100),
  rank          integer CHECK (rank >= 1),
  breakdown     jsonb NOT NULL,             -- per-signal contribution
  category      text,                       -- NULL = overall list
  method_version text NOT NULL DEFAULT '1.0',
  PRIMARY KEY (slug, window_kind, period)
);
CREATE INDEX IF NOT EXISTS trending_scores_list_idx ON trending_scores (window_kind, period, rank);

-- Outbound clicks through /go/{slug}, one row per tool, day and country (no personal data).
CREATE TABLE IF NOT EXISTS tool_clicks_daily (
  slug     text NOT NULL,
  day      date NOT NULL,
  country  char(2) NOT NULL DEFAULT 'XX' CHECK (country ~ '^[A-Z0-9]{2}$'),
  clicks   integer NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  PRIMARY KEY (slug, day, country)
);

-- Vendor claims (v2).
CREATE TABLE IF NOT EXISTS vendor_claims (
  id          bigserial PRIMARY KEY,
  slug        text NOT NULL,
  email       text NOT NULL CHECK (email = lower(email)),
  method      text NOT NULL CHECK (method IN ('dns','email')),
  token       text NOT NULL,
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Sponsorships (v2). The scorer never reads this table (PRD 6.4; enforced by a test).
CREATE TABLE IF NOT EXISTS sponsorships (
  id          bigserial PRIMARY KEY,
  slug        text NOT NULL,
  placement   text NOT NULL,                -- category:{id} | newsletter | home
  starts_on   date NOT NULL,
  ends_on     date NOT NULL,
  amount_usd  numeric(10,2) CHECK (amount_usd >= 0),
  payment_ref text,
  status      text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','ended','cancelled')),
  CHECK (ends_on >= starts_on)
);

-- Job runs, for monitoring (PRD 7.7). A run with more than 30% failures sets ok = false.
CREATE TABLE IF NOT EXISTS job_runs (
  id         bigserial PRIMARY KEY,
  job        text NOT NULL CHECK (job IN ('signals','backfill','scorer','crawler','health')),
  started_at timestamptz NOT NULL DEFAULT now(),
  ended_at   timestamptz,
  ok         boolean,
  stats      jsonb
);
CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs (job, started_at DESC);

-- The weekly email reuses the waitlist and its consent record (PRD 5.3).
ALTER TABLE waitlist ADD COLUMN IF NOT EXISTS lists text[] NOT NULL DEFAULT '{waitlist}';
