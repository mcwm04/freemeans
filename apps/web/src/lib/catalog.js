// Reads the Freemeans catalog at build time and supplies the labels the pages show.
// The site is static, so every number on freemeans.com comes from this one file:
// data/catalog/seed.json (or the file named by FREEMEANS_CATALOG).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const catalogPath = process.env.FREEMEANS_CATALOG
  ? resolve(process.env.FREEMEANS_CATALOG)
  : resolve(process.cwd(), '../../data/catalog/seed.json');

let cached;
export function loadCatalog() {
  if (!cached) cached = JSON.parse(readFileSync(catalogPath, 'utf8'));
  return cached;
}

export function resources() {
  return [...loadCatalog().resources].sort(
    (a, b) => a.provider.localeCompare(b.provider) || a.name.localeCompare(b.name),
  );
}

export function getResource(id) {
  return loadCatalog().resources.find((r) => r.id === id);
}

export const KIND_LABELS = {
  llm_api: 'LLM API',
  speech_api: 'Speech API',
  embedding_api: 'Embedding API',
  inference_platform: 'Inference platform',
  gpu_notebook: 'GPU notebook',
  cloud_credit: 'Cloud credit',
  ai_subscription: 'AI subscription',
  software_license: 'Software license',
  saas_plan: 'App plan',
  dev_platform: 'Developer platform',
  course: 'Course',
  certification: 'Certification',
  library_access: 'Library access',
  security_service: 'Security service',
  ad_grant: 'Ad grant',
};

export const TIER_LABELS = { free: 'Free tier', trial: 'Trial', credit: 'Sign-up credit' };

// Badge wording follows the brand book: say plainly what the rule means for the builder.
export const BADGES = {
  trains_on_data: { label: 'Trains on data', tone: 'warn', meaning: 'Prompts may be used to improve the provider’s products or read by reviewers. Keep client data out.' },
  non_commercial: { label: 'Non-commercial', tone: 'warn', meaning: 'Not for commercial or client work.' },
  age_18_plus: { label: '18+', tone: 'info', meaning: 'Users must be adults. Not for apps aimed at under-18s.' },
  eu_restricted: { label: 'EU-restricted', tone: 'warn', meaning: 'Apps for users in the EEA, Switzerland or UK must use the paid tier.' },
  manual_only: { label: 'Manual only', tone: 'stop', meaning: 'Use it by hand only. Freemeans never automates it.' },
  not_for_production: { label: 'Not for production', tone: 'info', meaning: 'Good for prototypes, not for a live product.' },
  payment_method_required: { label: 'Card required', tone: 'info', meaning: 'You must add a payment card even for the free part.' },
  // Red on purpose (Eligibility PRD, decision 2): the free period becomes a paid plan by itself.
  auto_renews_paid: { label: 'Charges after free period', tone: 'stop', meaning: 'Becomes a paid subscription automatically unless you cancel before the free period ends. Set a reminder.' },
  educational_use_only: { label: 'Education use only', tone: 'warn', meaning: 'Only for learning and teaching. Not for any paid, client or company work.' },
};

export const METRICS = {
  rps: 'Requests per second',
  rpm: 'Requests per minute',
  rpd: 'Requests per day',
  requests_per_month: 'Requests per month',
  tpm: 'Tokens per minute',
  tpd: 'Tokens per day',
  itpm: 'Input tokens per minute',
  otpm: 'Output tokens per minute',
  neurons_per_day: 'Neurons per day',
  inputs_per_minute: 'Inputs per minute',
  session_hours: 'Session length (hours)',
  credit_usd: 'Credit (US$)',
  seats: 'Seats (users)',
};

export const SIGNALS = {
  official_docs: { label: 'Official docs', official: true },
  official_api: { label: 'Official API', official: true },
  canary_call: { label: 'Canary call', official: true },
  third_party_snapshot: { label: 'Third-party snapshot', official: false },
  community_report: { label: 'Community report', official: false },
};

const RESETS = {
  rolling: 'rolling window',
  fixed_daily: 'resets daily',
  fixed_monthly: 'resets monthly',
  none: 'does not reset',
  unknown: 'reset not published',
};

export function resetLabel(reset) {
  if (!reset) return RESETS.unknown;
  const base = RESETS[reset.kind] ?? reset.kind;
  return reset.tz ? `${base} (${reset.tz}${reset.at ? ' ' + reset.at : ''})` : base;
}

// Numbers use the brand rule: thousands separators, no rounding, US$ for credit.
export function formatValue(rule) {
  if (rule.value === null || rule.value === undefined || rule.published === false) return 'Not published';
  const n = Number(rule.value);
  const s = Number.isFinite(n) ? n.toLocaleString('en-US') : String(rule.value);
  return rule.metric === 'credit_usd' ? `US$${s}` : s;
}

// Dates are written "22 Oct 2026" everywhere on the site (brand book: numbers and dates).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function formatDate(iso) {
  if (!iso) return 'not recorded';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

// A resource counts as officially verified only when every limit comes from an official signal.
export function isOfficial(resource) {
  return resource.limit_rules.length > 0 && resource.limit_rules.every((l) => SIGNALS[l.signal_type]?.official);
}

export function stats() {
  const list = loadCatalog().resources;
  const providers = new Set(list.map((r) => r.provider));
  const latest = list.map((r) => r.last_verified).sort().at(-1);
  return {
    resources: list.length,
    providers: providers.size,
    official: list.filter(isOfficial).length,
    latest,
    version: loadCatalog().version,
  };
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
