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

const OFFICIAL = new Set(['official_docs', 'official_api', 'canary_call']);

export function isOfficial(r) {
  return r.limit_rules.length > 0 && r.limit_rules.every((l) => OFFICIAL.has(l.signal_type));
}

export function parseFilters(params) {
  const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
  const safeFor = list(params.get('safe_for'));
  const unknown = safeFor.filter((s) => !SAFE_FOR[s]);
  if (unknown.length) {
    const err = new Error(`unknown safe_for value: ${unknown.join(', ')}. Use: ${Object.keys(SAFE_FOR).join(', ')}`);
    err.status = 400;
    throw err;
  }
  return {
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

export function summarize(r, siteUrl) {
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
  };
}
