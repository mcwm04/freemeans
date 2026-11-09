// The few GitHub REST calls the console needs, made with the signed-in editor's own token.
const API = 'https://api.github.com';

export function githubClient(token, { repo, branch = 'main', fetcher = fetch }) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'freemeans-admin',
  };
  const b64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));
  return {
    async user() {
      const res = await fetcher(`${API}/user`, { headers });
      if (!res.ok) throw new Error(`GitHub /user answered ${res.status}`);
      return res.json();
    },
    async fileExists(path) {
      const res = await fetcher(`${API}/repos/${repo}/contents/${path}?ref=${branch}`, { headers });
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`GitHub answered ${res.status} while checking ${path}`);
      return true;
    },
    /** Creates a new file in one commit. Fails if it already exists (no sha is sent). */
    async createFile(path, content, message) {
      const res = await fetcher(`${API}/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ message, content: b64(content), branch }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message ? `GitHub: ${data.message}` : `GitHub answered ${res.status}`);
      return { commitUrl: data.commit?.html_url, sha: data.commit?.sha };
    },
  };
}
