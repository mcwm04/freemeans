// Unit tests for src/lib/directory.js (no build needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freeSummary, quotaLabel, yesNo, generosity, isStale, daysSince, alternatives, getTool, filterFlags, lastModified } from '../src/lib/directory.js';

const base = (ft = {}, extra = {}) => ({
  slug: 'x', name: 'X', platforms: ['web'], open_source: false, license: null, tasks: ['text-to-image'], categories: ['image'],
  listed_at: '2026-11-01', changelog: [],
  free_tier: { type: 'forever_free', quota: null, card_required: null, signup_required: null, watermark: null, commercial_use: null, source_url: 'https://x.ai/pricing', verified_at: '2026-11-09', ...ft },
  ...extra,
});

test('quota and summary never invent a number', () => {
  assert.equal(quotaLabel(base()), null);
  assert.equal(freeSummary(base()), 'Forever free');
  const credits = base({ type: 'credits', quota: { value: 10000, unit: 'characters', period: 'month' } });
  assert.equal(quotaLabel(credits), '10,000 characters a month');
  assert.equal(freeSummary(credits), 'Free credits: 10,000 characters a month');
  assert.equal(freeSummary(base({ type: 'trial', trial_days: 14 })), '14-day free trial');
  assert.equal(freeSummary(base({ type: 'open_source' }, { license: 'MIT' })), 'Open source (MIT)');
  assert.equal(freeSummary(base({ type: 'none' })), 'No free plan');
});

test('yes / no / not stated, with "card required" as the bad answer', () => {
  assert.deepEqual(yesNo(null), { text: 'Not stated', tone: 'muted' });
  assert.deepEqual(yesNo(true, { invert: true }), { text: 'Yes', tone: 'warn' });
  assert.deepEqual(yesNo(false, { invert: true }), { text: 'No', tone: 'ok' });
});

test('M3: a free tier is stale after 60 days', () => {
  const today = new Date(Date.UTC(2026, 11, 31));
  assert.equal(daysSince('2026-11-01', today), 60);
  assert.equal(isStale(base({ verified_at: '2026-11-01' }), today), false);
  assert.equal(isStale(base({ verified_at: '2026-10-31' }), today), true);
});

test('generosity orders open source and no-card plans first', () => {
  const oss = base({ type: 'open_source', card_required: false, commercial_use: true });
  const trial = base({ type: 'trial', card_required: true });
  const free = base({ type: 'forever_free', card_required: false });
  assert.ok(generosity(oss) > generosity(free) && generosity(free) > generosity(trial));
});

test('filter flags and last-modified date', () => {
  const t = base({ type: 'open_source', card_required: false, commercial_use: true, watermark: false }, { open_source: true, platforms: ['api', 'linux'] });
  assert.deepEqual(filterFlags(t).split(' ').sort(), ['api', 'commercial', 'forever', 'nocard', 'nowatermark', 'oss']);
  assert.equal(lastModified(base({}, { changelog: [{ date: '2026-11-12', field: 'x', note: 'y' }] })), '2026-11-12');
});

test('alternatives: editor picks first, never the tool itself', () => {
  const ollama = getTool('ollama');
  const alts = alternatives(ollama).map((t) => t.slug);
  assert.equal(alts[0], 'llama-cpp');
  assert.ok(!alts.includes('ollama'));
});
