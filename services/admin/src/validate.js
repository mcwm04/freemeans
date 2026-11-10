// Checks a listing before it is committed. The same rules as services/toolcheck (which runs again
// in CI after the commit): JSON Schema, taxonomy ids, wording, word count, free-tier logic.
// @cfworker/json-schema is used because Workers forbid the code generation Ajv relies on.
import { Validator } from '@cfworker/json-schema';
import schema from '../../../packages/schema/tool.schema.json' with { type: 'json' };
import taxonomy from '../../../data/taxonomy.json' with { type: 'json' };

const validator = new Validator(schema, '2020-12', false);
const CATS = new Set(taxonomy.categories.map((c) => c.id));
const TASKS = new Set(taxonomy.tasks.map((t) => t.id));
const BANNED = ['best', 'revolutionary', 'ultimate', '#1', 'number one', "world's", 'worlds', 'game-changing', 'game changer',
  'cutting-edge', 'leading', 'unparalleled', 'amazing', 'incredible', 'powerful', 'seamless', 'next-gen', 'groundbreaking'];
export const RESERVED = new Set(['c', 't', 'submit', 'search', 'top-10', 'category', 'task', 'compare', 'go', 'api', 'admin']);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export { taxonomy };

export function wordCount(text) {
  return (String(text).match(/[\w'’-]+/gu) || []).length;
}

/** Returns a list of problems; an empty list means the listing can be published. */
export function checkTool(tool, today = new Date().toISOString().slice(0, 10)) {
  const errors = [];
  const res = validator.validate(tool);
  if (!res.valid) {
    for (const e of res.errors) {
      // Keep the leaf messages; the library also reports every parent that failed because of them.
      if (e.keyword === 'properties' || e.keyword === '$ref' || e.keyword === 'allOf') continue;
      errors.push(`${e.instanceLocation.replace(/^#\/?/, '') || '(root)'}: ${e.error}`);
    }
  }
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return errors.length ? errors : ['the listing must be a JSON object'];

  if (RESERVED.has(tool.slug)) errors.push(`slug: "${tool.slug}" is reserved for a site page`);
  for (const c of tool.categories ?? []) if (!CATS.has(c)) errors.push(`categories: unknown category "${c}"`);
  for (const t of tool.tasks ?? []) if (!TASKS.has(t)) errors.push(`tasks: unknown task "${t}"`);
  const tagline = String(tool.tagline ?? '').toLowerCase();
  for (const w of BANNED) if (new RegExp(`(?<![\\w-])${esc(w)}(?![\\w-])`).test(tagline)) errors.push(`tagline: uses the marketing word "${w}"`);
  const n = wordCount(tool.description ?? '');
  if (n < 80 || n > 150) errors.push(`description: has ${n} words; it needs 80–150`);
  const ft = tool.free_tier ?? {};
  if (ft.type === 'none' && ft.quota) errors.push('free_tier: type is "none" but a quota is set');
  if (ft.type !== 'trial' && ft.trial_days) errors.push('free_tier: trial_days is set but type is not "trial"');
  if (ft.type === 'open_source' && tool.open_source !== true) errors.push('free_tier: type is "open_source" but open_source is not true');
  if (tool.open_source === true && !tool.repo_url) errors.push('repo_url: required when open_source is true');
  for (const [label, d] of [['listed_at', tool.listed_at], ['free_tier.verified_at', ft.verified_at], ['pricing.verified_at', tool.pricing?.verified_at]]) {
    if (typeof d === 'string' && d > today) errors.push(`${label}: ${d} is in the future`);
  }
  if ((tool.alternatives ?? []).includes(tool.slug)) errors.push('alternatives: a tool cannot list itself');
  return [...new Set(errors)];
}

// Postgres jsonb does not keep key order. Put keys back in the schema's order, so committed files
// read like every other file in data/tools/ and diffs stay small.
function orderBy(props, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !props) return value;
  const out = {};
  for (const k of Object.keys(props)) if (k in value) out[k] = value[k];
  for (const k of Object.keys(value)) if (!(k in out)) out[k] = value[k];
  return out;
}
export function ordered(tool) {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool;
  const t = orderBy(schema.properties, tool);
  const defs = schema.$defs;
  if (t.free_tier && typeof t.free_tier === 'object') {
    t.free_tier = orderBy(defs.free_tier.properties, t.free_tier);
    if (t.free_tier.quota && typeof t.free_tier.quota === 'object') t.free_tier.quota = orderBy(defs.free_tier.properties.quota.properties, t.free_tier.quota);
  }
  if (t.pricing && typeof t.pricing === 'object') t.pricing = orderBy(schema.properties.pricing.properties, t.pricing);
  if (t.signals && typeof t.signals === 'object') t.signals = orderBy(defs.signals.properties, t.signals);
  return t;
}
