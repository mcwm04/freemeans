// Static build for Cloudflare Pages: every page is plain HTML in dist/.
// No server adapter is needed, so static requests stay unlimited on the free plan.
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: process.env.SITE_URL || 'https://freemeans.com',
  output: 'static',
  trailingSlash: 'always',
  build: { format: 'directory' },
});
