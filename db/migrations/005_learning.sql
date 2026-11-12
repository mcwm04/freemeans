-- Free learning (courses and certifications): Eligibility PRD, Chapter 11.
-- The learning block (format, hours, certificate, ...) stays in resources.record; the API filters
-- the full records, so no new columns are needed. Only the badge list widens, for the new
-- paid_certificate badge ("the learning is free, the certificate is not").
-- Keep this list in step with packages/schema/badge.schema.json (db/tests/db.test.mjs compares them).

ALTER TABLE badges DROP CONSTRAINT IF EXISTS badges_type_check;
ALTER TABLE badges ADD CONSTRAINT badges_type_check CHECK (type IN (
  'age_18_plus','non_commercial','trains_on_data','eu_restricted','manual_only','not_for_production',
  'payment_method_required','auto_renews_paid','educational_use_only','paid_certificate'));
