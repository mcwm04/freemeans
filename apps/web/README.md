# apps/web: freemeans.com

A static Astro site, built from `data/catalog/seed.json` and served by Cloudflare as a static-assets Worker (`wrangler.jsonc`; free, unlimited static requests).

| Page | Built from |
| --- | --- |
| `/` | Hero, tagline (English + Urdu), catalog stats, waitlist form |
| `/catalog/` | Every resource as a card, with search, type filter, and "Safe for client work" / "Serves EU users" filters that use the same badge rules as the agent |
| `/resources/{id}/` | One page per resource: usage rules, limits ledger (value, reset, checked date, source, signal), models, sources, plus JSON-LD |
| `/catalog.json` | The whole catalog, for tools and AI search |
| `/sitemap.txt`, `/robots.txt`, `/404.html`, `_headers` | SEO and Cloudflare Pages settings |

The brand comes from `packages/brand/tokens.json`. `npm run tokens` turns it into `src/styles/tokens.css` (light and dark), and every build runs it first. Fonts are self-hosted through Fontsource (Bricolage Grotesque, IBM Plex Sans, IBM Plex Mono, Noto Nastaliq Urdu), so the site makes no third-party font requests.

```bash
npm ci
npm run dev        # http://localhost:4321
npm test           # build + 9 checks on dist/
```

Environment variables: `PUBLIC_API_URL` sets where the waitlist form posts (default `https://api.freemeans.com`). `SITE_URL` sets the canonical address (default `https://freemeans.com`). `FREEMEANS_CATALOG` points the build at a different catalog file.

Limits with no published number (for example Gemini's free tier) show "Not published", never 0.
