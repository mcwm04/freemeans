// Free learning: courses and certifications (Eligibility PRD, chapter 11).
// Courses live in two files: data/catalog/learning.json, and the two older course records that sit in
// data/catalog/eligibility.json (DigiSkills, AWS Educate). Both kinds are read here as one list.
// The same status rules as every other offer apply: only active courses are listed.
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { allOffers, effectiveStatus, countryAllows, today } from './eligibility.js';

const file = process.env.FREEMEANS_LEARNING
  ? resolve(process.env.FREEMEANS_LEARNING)
  : resolve(process.cwd(), '../../data/catalog/learning.json');

let cached;
function load() {
  if (!cached) cached = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: null, resources: [] };
  return cached;
}

const isCourse = (r) => r.kind === 'course' || r.kind === 'certification';

// Each id once, with the eligibility.json copy winning if an id ever appears in both files.
export function allCourses() {
  const fromEligibility = allOffers().filter(isCourse);
  const seen = new Set(fromEligibility.map((r) => r.id));
  return [...fromEligibility, ...load().resources.filter((r) => isCourse(r) && !seen.has(r.id))];
}

export const liveCourses = (day = today()) => allCourses().filter((r) => effectiveStatus(r, day) === 'active');

// A "free certificate" is a certificate that costs nothing. A free badge is not a certificate.
export const hasFreeCertificate = (r) => r.learning?.certificate === 'free';
export const certificateCostsMoney = (r) => ['paid_optional', 'paid_required'].includes(r.learning?.certificate);

export const coursesFor = ({ country } = {}, day = today()) =>
  liveCourses(day).filter((r) => !country || countryAllows(r, country));

export const FORMAT_LABELS = { self_paced: 'Self-paced', cohort: 'Cohort (starts on set dates)', live: 'Live classes', in_person: 'In person' };
export const LEVEL_LABELS = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced' };
export const CREDENTIAL_LABELS = {
  completion: 'Completion certificate', badge: 'Digital badge', professional_certificate: 'Professional certificate',
  specialization: 'Specialization', accredited_credit: 'Credit that counts toward a degree',
};
export const CERTIFICATE_LABELS = {
  none: 'No certificate', free: 'Free certificate', paid_optional: 'Certificate costs money (optional)', paid_required: 'Certificate costs money',
};
export const VOUCHER_LABELS = { none: 'No exam voucher', free: 'Free exam voucher', discounted: 'Discounted exam voucher' };

const languageNames = new Intl.DisplayNames(['en'], { type: 'language' });
export const languageName = (code) => {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
};

const titleCase = (slug) => slug.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');

// The facts shown in the "What you get" box and on cards.
export function learningFacts(r) {
  const l = r.learning ?? {};
  return {
    format: FORMAT_LABELS[l.format] ?? null,
    hours: l.hours ?? null,
    level: LEVEL_LABELS[l.level] ?? null,
    languages: (l.languages ?? []).map(languageName),
    certificate: CERTIFICATE_LABELS[l.certificate] ?? null,
    certificatePrice: l.certificate_price ?? null,
    credential: CREDENTIAL_LABELS[l.credential] ?? null,
    voucher: l.exam_voucher && l.exam_voucher !== 'none' ? VOUCHER_LABELS[l.exam_voucher] : null,
    roles: (l.roles ?? []).map(titleCase),
  };
}
