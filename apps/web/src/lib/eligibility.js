// "Free for who you are": eligibility-based offers (Eligibility PRD, chapters 4 and 5).
// Reads data/catalog/eligibility.json at build time. The API-tier catalog (seed.json) stays in
// catalog.js; the two files are separate on purpose. Offers that are unverified, paused or
// ended never appear in live lists. Ended ones only appear on the Myths page.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const file = process.env.FREEMEANS_ELIGIBILITY
  ? resolve(process.env.FREEMEANS_ELIGIBILITY)
  : resolve(process.cwd(), '../../data/catalog/eligibility.json');

// Today at build time (UTC). Tests can pin it with FREEMEANS_TODAY=YYYY-MM-DD.
export const today = () => process.env.FREEMEANS_TODAY || new Date().toISOString().slice(0, 10);

let cached;
function load() {
  if (!cached) cached = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: null, resources: [] };
  return cached;
}

export const allOffers = () => load().resources;
export const getOffer = (id) => allOffers().find((r) => r.id === id);

// Same rule as the API (services/api/src/catalog.js) and the resources_live view: a passed
// redeem_by or access_ends turns an active offer into an ended one, whatever is stored.
export function effectiveStatus(r, day = today()) {
  const stored = r.status ?? 'active';
  const w = r.offer_window ?? {};
  if (stored === 'active' && ((w.redeem_by && w.redeem_by < day) || (w.access_ends && w.access_ends < day))) return 'ended';
  return stored;
}

// Records with no eligibility block (API free tiers) are open to everyone, everywhere.
export function countryAllows(r, code) {
  const c = r.eligibility?.countries;
  if (!c || c.mode === 'global') return true;
  return c.mode === 'include' ? c.codes.includes(code) : !c.codes.includes(code);
}

// Audience groups mirror the API (services/api/src/catalog.js).
export const AUDIENCE_GROUPS = {
  students: ['student_k12', 'student_higher_ed', 'student_bootcamp'],
  teachers: ['educator_k12', 'educator_higher_ed'],
  institutions: ['institution_school', 'institution_university'],
  nonprofits: ['nonprofit', 'journalist_civil_society'],
  startups: ['startup_self_funded', 'startup_investor_backed'],
};

export const GROUPS = {
  students: { title: 'Students', who: 'students', short: 'students', role: 'student' },
  teachers: { title: 'Teachers', who: 'teachers and educators', short: 'teachers', role: 'teacher' },
  institutions: { title: 'Schools and universities', who: 'schools and universities', short: 'schools' },
  nonprofits: { title: 'Nonprofits', who: 'nonprofits and civil society', short: 'nonprofits' },
  startups: { title: 'Startups', who: 'startups', short: 'startups' },
};

export const AUDIENCE_LABELS = {
  student_k12: 'School students (K-12)',
  student_higher_ed: 'College and university students',
  student_bootcamp: 'Bootcamp students',
  educator_k12: 'School teachers (K-12)',
  educator_higher_ed: 'University teachers',
  institution_school: 'Schools',
  institution_university: 'Universities',
  nonprofit: 'Nonprofits',
  startup_self_funded: 'Self-funded startups',
  startup_investor_backed: 'Investor-backed startups',
  open_source_maintainer: 'Open-source maintainers',
  researcher: 'Researchers',
  journalist_civil_society: 'Journalists and civil society',
  resident: 'Anyone living in the listed countries',
  public: 'Anyone',
};

export const PROOF_LABELS = {
  none: 'No proof needed',
  school_email: 'School email',
  student_id: 'Student ID',
  isic_itic: 'ISIC or ITIC card',
  official_document: 'Official document',
  teaching_license: 'Teaching license or documents',
  sheerid: 'SheerID check',
  github_education: 'GitHub Education verification',
  institution_verification: 'Verification by the institution',
  nonprofit_registration: 'Nonprofit registration',
  validation_partner: 'Check by a validation partner',
  company_website: 'Company website',
  investor_referral: 'Investor referral',
  phone: 'Phone number',
  sign_up: 'Sign-up',
};

const REVERIFY = { none: 'No re-check', monthly: 'Checked monthly', yearly: 'Checked every year', on_renewal: 'Checked at renewal', periodic: 'Checked from time to time' };
export const reverifyLabel = (v) => REVERIFY[v] ?? null;

const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
export function countryName(code) {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

// Countries that get their own pages (Pakistan first, PRD chapter 3).
export const COUNTRY_PAGES = { pakistan: { code: 'PK', name: 'Pakistan' } };

export const groupOf = (r) => Object.keys(AUDIENCE_GROUPS)
  .filter((g) => (r.eligibility?.audiences ?? []).some((a) => AUDIENCE_GROUPS[g].includes(a)));

export const liveOffers = (day = today()) => allOffers().filter((r) => effectiveStatus(r, day) === 'active');

export function offersFor({ group, country }, day = today()) {
  return liveOffers(day).filter((r) => (!group || groupOf(r).includes(group)) && (!country || countryAllows(r, country)));
}

export function endingSoon(days = 60, day = today()) {
  const limit = new Date(Date.parse(`${day}T00:00:00Z`) + days * 86400000).toISOString().slice(0, 10);
  return liveOffers(day)
    .filter((r) => r.offer_window?.redeem_by && r.offer_window.redeem_by <= limit)
    .sort((a, b) => a.offer_window.redeem_by.localeCompare(b.offer_window.redeem_by) || a.name.localeCompare(b.name));
}

// Ended offers and the misreported ones, with what replaced them (Myths page).
export const myths = (day = today()) => allOffers()
  .filter((r) => effectiveStatus(r, day) === 'ended')
  .sort((a, b) => a.name.localeCompare(b.name));

export const lastChecked = (list) => list.map((r) => r.last_verified).sort().at(-1);

export const MIN_OFFERS_TO_INDEX = 5; // thin-page rule (docs/SEO.md, chapter 6)

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export function monthYear(day = today()) {
  const [y, m] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

// Page facts shared by the "Who can get this" box, the cards and the descriptions.
export function offerFacts(r) {
  const e = r.eligibility ?? {};
  const w = r.offer_window ?? {};
  const badge = (t) => (r.badges ?? []).some((b) => b.type === t);
  const countries = e.countries ?? { mode: 'global' };
  const where = countries.mode === 'global' ? 'Worldwide'
    : countries.mode === 'include' ? `Only in ${countries.codes.map(countryName).join(', ')}`
    : `Everywhere except ${countries.codes.map(countryName).join(', ')}`;
  let howLong = null;
  if (w.duration_months) howLong = `${w.duration_months} months${w.renewable ? ', renewable' : ''}`;
  else if (w.renewable) howLong = 'Renewable';
  return {
    who: (e.audiences ?? []).map((a) => AUDIENCE_LABELS[a] ?? a),
    where,
    proof: (e.proof ?? []).map((p) => PROOF_LABELS[p] ?? p),
    card: badge('payment_method_required'),
    autoRenews: badge('auto_renews_paid') || w.after?.auto_renews === true,
    howLong,
    redeemBy: w.redeem_by ?? null,
    accessEnds: w.access_ends ?? null,
    after: w.after?.price ?? null,
    reverify: reverifyLabel(e.reverify),
    via: e.via === 'institution' ? 'The school or organization applies, not you' : null,
  };
}
