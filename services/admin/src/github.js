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
    /** Starts a workflow that has a workflow_dispatch trigger. */
    async dispatchWorkflow(file, ref = branch) {
      const res = await fetcher(`${API}/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ ref }),
      });
      if (res.status === 204) return true;
      const data = await res.json().catch(() => ({}));
      throw new Error(data.message ? `GitHub: ${data.message}` : `GitHub answered ${res.status}`);
    },
    /** Reads a text file: { text, sha }, or null when it does not exist. */
    async readFile(path) {
      const res = await fetcher(`${API}/repos/${repo}/contents/${path}?ref=${branch}`, { headers });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`GitHub answered ${res.status} while reading ${path}`);
      const data = await res.json();
      if (data.encoding !== 'base64' || typeof data.content !== 'string') throw new Error(`GitHub did not return the content of ${path}`);
      const bytes = Uint8Array.from(atob(data.content.replace(/\s/g, '')), (c) => c.charCodeAt(0));
      return { text: new TextDecoder().decode(bytes), sha: data.sha };
    },
    /** File names in a folder. */
    async listDir(path) {
      const res = await fetcher(`${API}/repos/${repo}/contents/${path}?ref=${branch}`, { headers });
      if (!res.ok) throw new Error(`GitHub answered ${res.status} while listing ${path}`);
      return (await res.json()).filter((f) => f.type === 'file').map((f) => f.name);
    },
    /** Replaces a file in one commit. `sha` is the version the editor opened; GitHub refuses if it has changed since. */
    async updateFile(path, content, message, sha) {
      const res = await fetcher(`${API}/repos/${repo}/contents/${path}`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ message, content: b64(content), branch, sha }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 || res.status === 422) throw new Error('This file changed on GitHub after you opened it. Reload the page and apply your edit again.');
      if (!res.ok) throw new Error(data.message ? `GitHub: ${data.message}` : `GitHub answered ${res.status}`);
      return { commitUrl: data.commit?.html_url, sha: data.content?.sha };
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
