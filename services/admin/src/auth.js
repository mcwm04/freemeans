// Sign in with GitHub (chosen 9 Nov 2026 instead of Cloudflare Access, which needs a card on file).
// The session cookie is encrypted (AES-GCM) and holds the GitHub login and the user's own OAuth
// token, which is used to commit approved listings as that person. Nothing is stored server-side.

const enc = new TextEncoder();
const dec = new TextDecoder();
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

async function keyFor(secret) {
  if (!secret || secret.length < 32) throw new Error('SESSION_SECRET must be at least 32 characters.');
  const raw = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export async function seal(secret, data) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(secret), enc.encode(JSON.stringify(data)));
  return `${b64u(iv)}.${b64u(ct)}`;
}

export async function unseal(secret, value, now = Date.now()) {
  try {
    const [iv, ct] = String(value).split('.');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(iv) }, await keyFor(secret), unb64u(ct));
    const data = JSON.parse(dec.decode(plain));
    return data.exp && data.exp > now ? data : null;
  } catch {
    return null;
  }
}

export function readCookie(req, name) {
  const m = (req.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(`${name}=`));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : null;
}

export const cookie = (name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export const SESSION = 'fm_session';
export const STATE = 'fm_oauth_state';
export const SESSION_HOURS = 8;

/** GitHub OAuth web flow: https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps */
export function githubOAuth({ clientId, clientSecret, fetcher = fetch }) {
  return {
    authorizeUrl(state, redirectUri) {
      const q = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, scope: 'public_repo', state, allow_signup: 'false' });
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async exchange(code, redirectUri) {
      const res = await fetcher('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
      });
      const data = await res.json();
      if (!data.access_token) throw new Error(data.error_description || 'GitHub did not return a token.');
      return data.access_token;
    },
  };
}
