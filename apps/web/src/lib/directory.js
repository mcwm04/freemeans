// The AI tools directory (/tools/), read at build time from data/tools/*.json and
// data/taxonomy.json. Git is the source of truth for listings (PRD 4.4): editing a tool file
// and pushing rebuilds these pages. Files are validated by services/toolcheck in CI.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const dataDir = process.env.FREEMEANS_DATA ? resolve(process.env.FREEMEANS_DATA) : resolve(process.cwd(), '../../data');
const API = (import.meta.env?.PUBLIC_API_URL || process.env.PUBLIC_API_URL || 'https://api.freemeans.com').replace(/\/$/, '');

// Category and task pages go into search results only once they list this many tools.
// Thinner pages are built (people can browse them) but carry noindex (SEO guide 6.1).
export const MIN_TOOLS_TO_INDEX = 5;
// M3: fields not re-verified for this long get a public "Not recently verified" note.
export const STALE_PUBLIC_DAYS = 60;

let cache;
function load() {
  if (cache) return cache;
  const taxonomy = JSON.parse(readFileSync(resolve(dataDir, 'taxonomy.json'), 'utf8'));
  const dir = resolve(dataDir, 'tools');
  const all = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(readFileSync(resolve(dir, f), 'utf8')))
    : [];
  cache = { taxonomy, all };
  return cache;
}

export const taxonomy = () => load().taxonomy;
/** Published tools, A–Z. Hidden and removed tools get no page. */
export const tools = () => load().all.filter((t) => t.status === 'published').sort((a, b) => a.name.localeCompare(b.name));
export const getTool = (slug) => tools().find((t) => t.slug === slug);
export const categoryById = (id) => taxonomy().categories.find((c) => c.id === id);
export const taskById = (id) => taxonomy().tasks.find((t) => t.id === id);

export const inCategory = (id) => tools().filter((t) => t.categories.includes(id));
export const forTask = (id) => tools().filter((t) => t.tasks.includes(id));

/** Categories and tasks that have at least one published tool, with their tool counts. */
export function liveCategories() {
  return taxonomy().categories.map((c) => ({ ...c, count: inCategory(c.id).length })).filter((c) => c.count > 0);
}
export function liveTasks() {
  return taxonomy().tasks.map((t) => ({ ...t, count: forTask(t.id).length })).filter((t) => t.count > 0);
}

export const FREE_TYPES = {
  forever_free: { label: 'Forever free', short: 'Free plan', tone: 'ok' },
  credits: { label: 'Free credits', short: 'Free credits', tone: 'info' },
  trial: { label: 'Free trial', short: 'Trial only', tone: 'warn' },
  open_source: { label: 'Open source', short: 'Open source', tone: 'ok' },
  none: { label: 'No free plan', short: 'Paid only', tone: 'stop' },
};

export const PLATFORMS = {
  web: 'Web', api: 'API', ios: 'iOS', android: 'Android', windows: 'Windows', macos: 'macOS',
  linux: 'Linux', 'browser-extension': 'Browser extension', cli: 'Command line', 'self-hosted': 'Self-hosted',
};

const PERIODS = { day: 'a day', month: 'a month', once: 'once' };

/** "10,000 characters a month", or null when the provider publishes no number. */
export function quotaLabel(tool) {
  const q = tool.free_tier.quota;
  if (!q || q.value === null || q.value === undefined) return null;
  const n = Number(q.value).toLocaleString('en-US');
  return `${n} ${q.unit}${q.period ? ' ' + (PERIODS[q.period] ?? q.period) : ''}`;
}

/** One line for cards and descriptions. */
export function freeSummary(tool) {
  const ft = tool.free_tier;
  const quota = quotaLabel(tool);
  if (ft.type === 'trial') return ft.trial_days ? `${ft.trial_days}-day free trial` : 'Free trial';
  if (ft.type === 'open_source') return tool.license ? `Open source (${tool.license})` : 'Open source';
  if (ft.type === 'none') return 'No free plan';
  return quota ? `${FREE_TYPES[ft.type].label}: ${quota}` : FREE_TYPES[ft.type].label;
}

/** Yes / No / Not stated, for the free tier card. `invert` flips the tone (card required = bad). */
export function yesNo(value, { invert = false } = {}) {
  if (value === null || value === undefined) return { text: 'Not stated', tone: 'muted' };
  const good = invert ? !value : value;
  return { text: value ? 'Yes' : 'No', tone: good ? 'ok' : 'warn' };
}

/** Sort key for "Most generous free tier" (higher is better). */
export function generosity(tool) {
  const ft = tool.free_tier;
  const base = { open_source: 5, forever_free: 4, credits: 3, trial: 1, none: 0 }[ft.type] ?? 0;
  return base + (ft.card_required === false ? 1 : 0) + (ft.commercial_use === true ? 1 : 0) + (ft.watermark === false ? 0.5 : 0);
}

export function daysSince(iso, today = new Date()) {
  const then = Date.parse(`${iso}T00:00:00Z`);
  return Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - then) / 86_400_000);
}
export const isStale = (tool, today = new Date()) => daysSince(tool.free_tier.verified_at, today) > STALE_PUBLIC_DAYS;

/** Last date anything on the tool's page was checked or changed: used for lastmod and dateModified. */
export function lastModified(tool) {
  const dates = [tool.listed_at, tool.free_tier.verified_at, tool.pricing?.verified_at, ...(tool.changelog ?? []).map((c) => c.date)];
  return dates.filter(Boolean).sort().at(-1);
}

/** Outbound link: every "Visit" button goes through the API so clicks are counted (M4). */
export const goUrl = (slug) => `${API}/go/${slug}`;
/** rel for outbound links. Paid or affiliate links must say sponsored (SEO guide 6.3). */
export const outboundRel = (tool) => (tool.affiliate_url || tool.sponsor ? 'sponsored noopener' : 'nofollow noopener');

/** 3–5 alternatives: the editor's picks first, then tools sharing a task or category, most generous first. */
export function alternatives(tool, max = 5) {
  const others = tools().filter((t) => t.slug !== tool.slug);
  const picked = (tool.alternatives ?? []).map(getTool).filter(Boolean);
  const shares = (t) => t.tasks.filter((x) => tool.tasks.includes(x)).length * 2 + t.categories.filter((x) => tool.categories.includes(x)).length;
  const rest = others
    .filter((t) => !picked.includes(t) && shares(t) > 0)
    .sort((a, b) => shares(b) - shares(a) || generosity(b) - generosity(a) || a.name.localeCompare(b.name));
  return [...picked, ...rest].slice(0, max);
}

/** Filter flags a card carries, read by the in-page filter script (M2). */
export function filterFlags(tool) {
  const ft = tool.free_tier;
  const f = [];
  if (ft.card_required === false) f.push('nocard');
  if (ft.type === 'forever_free' || ft.type === 'open_source') f.push('forever');
  if (tool.open_source) f.push('oss');
  if (ft.commercial_use === true) f.push('commercial');
  if (ft.watermark === false) f.push('nowatermark');
  if (tool.platforms.includes('api')) f.push('api');
  return f.join(' ');
}

export function directoryStats() {
  const list = tools();
  return {
    tools: list.length,
    categories: liveCategories().length,
    latest: list.map(lastModified).sort().at(-1),
  };
}
