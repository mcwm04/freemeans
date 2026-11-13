// Catalog filtering and summaries. The `safe_for` rules mirror the local agent's policy
// engine (agent/src/freemeans/policy.py), so the website, API and router agree.

export const SAFE_FOR = {
  client: ['trains_on_data', 'non_commercial', 'manual_only'],
  commercial: ['non_commercial', 'manual_only'],
  eu: ['eu_restricted'],
  production: ['not_for_production', 'manual_only'],
  minors: ['age_18_plus'],
  automation: ['manual_only'],
};

// Audience groups for the "Free for who you are" pages (Eligibility PRD, chapter 3).
// Audiences in no group (open_source_maintainer, researcher, resident, public) are still
// reachable with ?audience=.
export const AUDIENCE_GROUPS = {
  students: ['student_k12', 'student_higher_ed', 'student_bootcamp'],
  teachers: ['educator_k12', 'educator_higher_ed'],
  institutions: ['institution_school', 'institution_university'],
  nonprofits: ['nonprofit', 'journalist_civil_society'],
  startups: ['startup_self_funded', 'startup_investor_backed'],
};
const AUDIENCES = new Set([...Object.values(AUDIENCE_GROUPS).flat(), 'open_source_maintainer', 'researcher', 'resident', 'public']);
const STATUSES = ['active', 'paused', 'ended', 'unverified'];
// Learning filters (Eligibility PRD, chapter 11). The values mirror packages/schema/learning.schema.json.
const FORMATS = ['self_paced', 'cohort', 'live', 'in_person'];
const CERTIFICATES = ['none', 'free', 'paid_optional', 'paid_required'];
const LEVELS = ['beginner', 'intermediate', 'advanced'];
const CREDENTIALS = ['completion', 'badge', 'professional_certificate', 'specialization', 'accredited_credit'];

const bad = (message) => Object.assign(new Error(message), { status: 400 });
const DAY = 86400000;

// Status at read time: a passed redeem_by or access_ends turns an active offer into ended,
// whatever is stored. Same rule as the resources_live view in db/migrations/004.
export function effectiveStatus(r, today) {
  const stored = r.status ?? 'active';
  const w = r.offer_window ?? {};
  if (stored === 'active' && ((w.redeem_by && w.redeem_by < today) || (w.access_ends && w.access_ends < today))) return 'ended';
  return stored;
}

// Offers with no eligibility block (API free tiers) are open to everyone, everywhere.
export function countryAllows(r, code) {
  const c = r.eligibility?.countries;
  if (!c || c.mode === 'global') return true;
  return c.mode === 'include' ? c.codes.includes(code) : !c.codes.includes(code);
}

const addDays = (today, n) => new Date(Date.parse(`${today}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);

const OFFICIAL = new Set(['official_docs', 'official_api', 'canary_call']);

export function isOfficial(r) {
  return r.limit_rules.length > 0 && r.limit_rules.every((l) => OFFICIAL.has(l.signal_type));
}

export function parseFilters(params, today = new Date().toISOString().slice(0, 10)) {
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const safeFor = list(params.get('safe_for'));
  const unknown = safeFor.filter((s) => !SAFE_FOR[s]);
  if (unknown.length) {
    const err = new Error(`unknown safe_for value: ${unknown.join(', ')}. Use: ${Object.keys(SAFE_FOR).join(', ')}`);
    err.status = 400;
    throw err;
  }

  const groups = list(params.get('group'));
  const badGroup = groups.filter((g) => !AUDIENCE_GROUPS[g]);
  if (badGroup.length) throw bad(`unknown group value: ${badGroup.join(', ')}. Use: ${Object.keys(AUDIENCE_GROUPS).join(', ')}`);
  const audiences = list(params.get('audience'));
  const badAudience = audiences.filter((a) => !AUDIENCES.has(a));
  if (badAudience.length) throw bad(`unknown audience value: ${badAudience.join(', ')}`);

  const country = (params.get('country') || '').trim().toUpperCase();
  if (country && !/^[A-Z]{2}$/.test(country)) throw bad('country must be a two-letter ISO code, for example PK');

  const statuses = list(params.get('status'));
  const badStatus = statuses.filter((s) => !STATUSES.includes(s));
  if (badStatus.length) throw bad(`unknown status value: ${badStatus.join(', ')}. Use: ${STATUSES.join(', ')}`);
  // Default: only live offers. include_ended=true adds ended ones (Myths page). Unverified
  // and paused offers appear only when asked for with ?status=.
  const status = statuses.length ? statuses : params.get('include_ended') === 'true' ? ['active', 'ended'] : ['active'];

  // Each learning filter takes a comma list (any of). A record with no `learning` block never matches one.
  const oneOf = (name, allowed) => {
    const values = list(params.get(name));
    const unknown = values.filter((v) => !allowed.includes(v));
    if (unknown.length) throw bad(`unknown ${name} value: ${unknown.join(', ')}. Use: ${allowed.join(', ')}`);
    return values;
  };
  const languages = list(params.get('language')).map((l) => l.toLowerCase());
  if (languages.some((l) => !/^[a-z]{2,3}$/.test(l))) throw bad('language must be a two- or three-letter code, for example en or ur');
  const roles = list(params.get('role')).map((r) => r.toLowerCase());
  if (roles.some((r) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(r))) throw bad('role must be a slug such as data-analyst');
  const learning = {
    format: oneOf('format', FORMATS),
    certificate: oneOf('certificate', CERTIFICATES),
    level: oneOf('level', LEVELS),
    credential: oneOf('credential', CREDENTIALS),
    languages,
    roles,
    freeCertificate: params.get('free_certificate') === 'true',
  };

  let endingWithin = null;
  if (params.get('ending_within_days') != null) {
    const n = Number(params.get('ending_within_days'));
    if (!Number.isInteger(n) || n < 1 || n > 3650) throw bad('ending_within_days must be a whole number from 1 to 3650');
    endingWithin = n;
  }

  return {
    today,
    audience: new Set([...audiences, ...groups.flatMap((g) => AUDIENCE_GROUPS[g])]),
    country,
    status,
    endingWithin,
    learning,
    q: (params.get('q') || '').trim().toLowerCase(),
    kind: list(params.get('kind')),
    tier: list(params.get('tier')),
    provider: list(params.get('provider')).map((p) => p.toLowerCase()),
    exclude: new Set([...list(params.get('exclude_badges')), ...safeFor.flatMap((s) => SAFE_FOR[s])]),
    officialOnly: params.get('official') === 'true',
    full: params.get('full') === 'true',
  };
}

export function filterResources(resources, f) {
  return resources.filter((r) => {
    if (!f.status.includes(effectiveStatus(r, f.today))) return false;
    if (f.audience.size && !(r.eligibility?.audiences ?? []).some((a) => f.audience.has(a))) return false;
    if (f.country && !countryAllows(r, f.country)) return false;
    if (!learningMatches(r.learning, f.learning)) return false;
    if (f.endingWithin) {
      const end = r.offer_window?.redeem_by ?? r.offer_window?.access_ends;
      if (!end || end < f.today || end > addDays(f.today, f.endingWithin)) return false;
    }
    if (f.kind.length && !f.kind.includes(r.kind)) return false;
    if (f.tier.length && !f.tier.includes(r.tier_type)) return false;
    if (f.provider.length && !f.provider.includes(r.provider.toLowerCase())) return false;
    if (r.badges.some((b) => f.exclude.has(b.type))) return false;
    if (f.officialOnly && !isOfficial(r)) return false;
    if (f.q) {
      const text = `${r.id} ${r.provider} ${r.name} ${(r.models ?? []).join(' ')}`.toLowerCase();
      if (!text.includes(f.q)) return false;
    }
    return true;
  });
}

// A learning filter is on when any of its values is set. Records with no learning block, or with
// the field missing, never match an active filter: unknown is not a match.
export function learningMatches(l, f) {
  const on = f.format.length || f.certificate.length || f.level.length || f.credential.length
    || f.languages.length || f.roles.length || f.freeCertificate;
  if (!on) return true;
  if (!l) return false;
  if (f.format.length && !f.format.includes(l.format)) return false;
  if (f.certificate.length && !f.certificate.includes(l.certificate)) return false;
  if (f.freeCertificate && l.certificate !== 'free') return false;
  if (f.level.length && !f.level.includes(l.level)) return false;
  if (f.credential.length && !f.credential.includes(l.credential)) return false;
  if (f.languages.length && !(l.languages ?? []).some((x) => f.languages.includes(x))) return false;
  if (f.roles.length && !(l.roles ?? []).some((x) => f.roles.includes(x))) return false;
  return true;
}

export function summarize(r, siteUrl, today = new Date().toISOString().slice(0, 10)) {
  const status = effectiveStatus(r, today);
  const offer = r.eligibility
    ? { status, audiences: r.eligibility.audiences, redeem_by: r.offer_window?.redeem_by ?? null }
    : status !== 'active' ? { status } : {};
  return {
    id: r.id,
    provider: r.provider,
    name: r.name,
    kind: r.kind,
    tier_type: r.tier_type,
    badges: r.badges.map((b) => b.type),
    limits: r.limit_rules.length,
    official: isOfficial(r),
    last_verified: r.last_verified,
    url: `${siteUrl}/resources/${r.id}/`,
    ...offer,
    ...(r.learning ? { learning: summarizeLearning(r.learning) } : {}),
  };
}

// The fields people filter and compare on, without the longer notes.
function summarizeLearning(l) {
  const out = { format: l.format, certificate: l.certificate };
  for (const k of ['hours', 'level', 'languages', 'credential', 'certificate_price']) if (l[k] !== undefined) out[k] = l[k];
  return out;
}
