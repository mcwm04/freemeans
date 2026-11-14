// Settings the console itself reads. Each has a type, bounds and a default, so a bad value can never be stored.
export const DEFS = {
  stale_days: { label: 'Days before a free tier or offer needs a re-check', min: 7, max: 180, def: 30 },
  session_hours: { label: 'Hours a sign-in lasts', min: 1, max: 72, def: 8, note: 'Applies to new sign-ins.' },
  max_failed_logins: { label: 'Failed sign-ins per IP before a 15 minute lock-out', min: 3, max: 50, def: 10 },
};

export const defaults = () => Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, d.def]));

/** Returns { ok, value } or { ok: false, error } for a raw form value. */
export function parseSetting(key, raw) {
  const d = DEFS[key];
  if (!d) return { ok: false, error: `Unknown setting "${key}".` };
  const t = String(raw ?? '').trim();
  const n = Number(t);
  if (!/^\d+$/.test(t) || !Number.isSafeInteger(n) || n < d.min || n > d.max) return { ok: false, error: `${d.label}: enter a whole number from ${d.min} to ${d.max}.` };
  return { ok: true, value: n };
}

/** Stored values over defaults; anything stored that is no longer valid falls back to the default. */
export function resolve(stored) {
  const out = defaults();
  for (const [k, v] of Object.entries(stored)) if (DEFS[k] && parseSetting(k, v).ok) out[k] = Number(v);
  return out;
}
