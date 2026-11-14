// Eligibility offers and free courses (data/catalog/eligibility.json and learning.json): checks before a
// record is committed, and the "needs a look" flags. Same rules as agent/src/freemeans/catalog.py, which CI
// runs again after the commit. @cfworker/json-schema is used because Workers forbid Ajv's code generation.
import { Validator } from '@cfworker/json-schema';
import resource from '../../../packages/schema/resource.schema.json' with { type: 'json' };
import eligibility from '../../../packages/schema/eligibility.schema.json' with { type: 'json' };
import learning from '../../../packages/schema/learning.schema.json' with { type: 'json' };
import limitRule from '../../../packages/schema/limit_rule.schema.json' with { type: 'json' };
import badge from '../../../packages/schema/badge.schema.json' with { type: 'json' };

export const OFFER_FILES = [
  { path: 'data/catalog/eligibility.json', label: 'Eligibility offers' },
  { path: 'data/catalog/learning.json', label: 'Free learning' },
];

const validator = new Validator(resource, '2020-12', false);
for (const s of [eligibility, learning, limitRule, badge]) validator.addSchema(s);

// Kinds the local agent routes to; every other kind must say who qualifies.
const API_KINDS = new Set(['llm_api', 'speech_api', 'embedding_api', 'inference_platform', 'gpu_notebook', 'cloud_credit']);
const LEARNING_KINDS = new Set(['course', 'certification']);
export const STALE_DAYS = 30;
export const ENDING_DAYS = 30;

/** Problems with one record; an empty list means it can be committed. `otherIds` are ids in other records. */
export function checkOffer(r, { otherIds = [], today = new Date().toISOString().slice(0, 10) } = {}) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) return ['the record must be a JSON object'];
  const errors = [];
  const res = validator.validate(r);
  if (!res.valid) {
    for (const e of res.errors) {
      if (['properties', '$ref', 'allOf', 'items', 'if', 'then'].includes(e.keyword)) continue;
      errors.push(`${e.instanceLocation.replace(/^#\/?/, '') || '(root)'}: ${e.error}`);
    }
  }
  const badges = new Set((r.badges ?? []).map((b) => b?.type));
  const after = r.offer_window?.after ?? {};
  if (r.kind && !API_KINDS.has(r.kind) && !r.eligibility) errors.push(`kind "${r.kind}" needs an eligibility block`);
  if (after.auto_renews && !badges.has('auto_renews_paid')) errors.push('offer auto-renews into a paid plan, so it needs the auto_renews_paid badge');
  if (badges.has('auto_renews_paid') && !after.auto_renews) errors.push('auto_renews_paid badge needs offer_window.after.auto_renews = true');
  if (r.replaced_by && r.status !== 'ended') errors.push('replaced_by is only for ended offers');
  if (r.replaced_by && r.replaced_by === r.id) errors.push('replaced_by points to itself');
  if (LEARNING_KINDS.has(r.kind) && !r.learning && !['unverified', 'ended'].includes(r.status)) errors.push(`kind "${r.kind}" needs a learning block (format and certificate)`);
  if (r.learning && !LEARNING_KINDS.has(r.kind)) errors.push('a learning block is only for kinds course and certification');
  const hasPaidCert = badges.has('paid_certificate');
  if (r.learning?.certificate === 'paid_required' && !hasPaidCert) errors.push('a certificate that costs money needs the paid_certificate badge');
  if (hasPaidCert && r.learning?.certificate !== 'paid_required') errors.push('paid_certificate badge needs learning.certificate = paid_required');
  const urls = new Set((r.sources ?? []).map((s) => s?.url));
  for (const w of r.watch ?? []) if (!urls.has(w?.source_url)) errors.push(`watch phrase "${w?.text}" uses a URL that is not in sources`);
  if (typeof r.last_verified === 'string' && r.last_verified > today) errors.push(`last_verified: ${r.last_verified} is in the future`);
  if (r.id && otherIds.includes(r.id)) errors.push(`id: "${r.id}" is already used by another record`);
  return [...new Set(errors)];
}

const daysBetween = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

/** Short flags that tell an editor why a record needs attention. */
export function offerFlags(r, today, staleDays = STALE_DAYS) {
  const flags = [];
  if (r.status === 'unverified') flags.push('unverified');
  if (r.status === 'ended') flags.push('ended');
  const by = r.offer_window?.redeem_by;
  if (by && r.status !== 'ended') {
    if (by < today) flags.push('past redeem date');
    else if (daysBetween(today, by) <= ENDING_DAYS) flags.push(`ends in ${daysBetween(today, by)} days`);
  }
  if (r.status !== 'ended' && r.last_verified && daysBetween(r.last_verified, today) > staleDays) flags.push('re-check');
  return flags;
}

export const needsLook = (flags) => flags.some((f) => f !== 'ended');
