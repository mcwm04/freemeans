// Turns packages/brand/tokens.json (the Freemeans design system) into CSS custom properties.
// Run before every build so the site and the design system never drift apart.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, '../../../packages/brand/tokens.json');
const out = resolve(here, '../src/styles/tokens.css');
const t = JSON.parse(readFileSync(src, 'utf8'));

const resolveRef = (value, theme, all) => {
  const m = /^\{(.+)\}$/.exec(value);
  if (!m) return value;
  const ref = all.find((x) => x.name === m[1]);
  return ref ? resolveRef(ref.value[theme] ?? ref.value, theme, all) : value;
};

const colors = t.color.tokens;
const block = (theme) =>
  colors
    .map((c) => {
      const raw = typeof c.value === 'string' ? c.value : c.value[theme];
      return `  --${c.name}: ${resolveRef(raw, theme, colors)};`;
    })
    .join('\n');

const lines = [];
lines.push('/* Generated from packages/brand/tokens.json by scripts/build-tokens.mjs. Do not edit by hand. */');
lines.push(':root {');
lines.push(block('light'));
for (const [k, v] of Object.entries(t.type.families)) lines.push(`  --font-${k}: ${v};`);
for (const s of t.spacing.tokens) lines.push(`  --${s.name}: ${s.value};`);
for (const r of t.radius.tokens) lines.push(`  --${r.name}: ${r.value};`);
for (const g of t.type.groups)
  for (const s of g.styles) {
    lines.push(`  --text-${s.name}-size: ${s.fontSize};`);
    lines.push(`  --text-${s.name}-line: ${s.lineHeight};`);
  }
lines.push('  color-scheme: light;');
lines.push('}');
lines.push('@media (prefers-color-scheme: dark) {');
lines.push('  :root {');
lines.push(block('dark').replace(/^/gm, '  '));
lines.push('    color-scheme: dark;');
lines.push('  }');
lines.push('}');

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join('\n') + '\n');
console.log(`tokens.css: ${colors.length} colours, light + dark`);
