// Public, machine-readable catalog at /catalog.json (for AI search and other tools; Chapter 8).
import { loadCatalog } from '../lib/catalog.js';

export function GET() {
  return new Response(JSON.stringify(loadCatalog(), null, 2), {
    headers: { 'content-type': 'application/json; charset=utf-8' },
  });
}
