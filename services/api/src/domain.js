// One site = one tool. siteKey() is the de-duplication key for candidates and tools (PRD 7.1).
// The same rules live in services/crawler/crawler/domain.py; both test suites read
// packages/schema/site-key-cases.json, so they cannot drift apart.

// Code and model hosts: each repo or Space is its own tool.
const PATH_KEYED = new Set(['github.com', 'gitlab.com', 'codeberg.org', 'huggingface.co']);
// App hosts where every subdomain belongs to a different person.
const SHARED_SUFFIXES = ['vercel.app', 'netlify.app', 'github.io', 'pages.dev', 'hf.space', 'streamlit.app',
  'replit.app', 'onrender.com', 'web.app', 'firebaseapp.com', 'herokuapp.com', 'glitch.me', 'gradio.live', 'fly.dev'];
// Two-part public suffixes seen in practice (not the full Public Suffix List; good enough here).
const TWO_PART = new Set(['co.uk', 'org.uk', 'ac.uk', 'com.pk', 'org.pk', 'edu.pk', 'gov.pk', 'net.pk', 'com.au', 'co.in',
  'co.jp', 'com.br', 'co.za', 'com.cn', 'com.tr', 'co.kr', 'com.sg', 'com.mx', 'co.nz', 'com.my', 'com.ng', 'co.id']);

/** Parses a user- or crawler-supplied address. Returns a URL or null for anything that is not a public website. */
export function parseSite(input) {
  let u;
  try {
    const s = String(input ?? '').trim();
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.toLowerCase();
  if (!host.includes('.') || /^[\d.]+$/.test(host) || host.includes(':') || host === 'localhost' || host.endsWith('.local')) return null;
  return u;
}

export function siteKey(input) {
  const u = parseSite(input);
  if (!u) return null;
  let host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.toLowerCase().split('/').filter(Boolean);
  if (host === 'huggingface.co' && parts[0] === 'spaces') return [host, ...parts.slice(0, 3)].join('/');
  if (PATH_KEYED.has(host)) return [host, ...parts.slice(0, 2)].join('/');
  if (SHARED_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`))) return host;
  const labels = host.split('.');
  const n = TWO_PART.has(labels.slice(-2).join('.')) ? 3 : 2;
  return labels.slice(-n).join('.');
}
