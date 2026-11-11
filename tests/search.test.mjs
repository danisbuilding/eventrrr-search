// Unit tests for the parts that need no network: time windows, keyword parsing, dedupe, chips, and the
// whole search() flow with Scout IQ and OpenAI mocked. Run: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windows, zonedToDate, rangeLabel } from '../lib/time.js';
import { parseKeywords, sanitize } from '../lib/parse.js';
import { dedupe, chips, search, MAIN_MIN } from '../lib/search.js';

const TZ = 'America/Mexico_City';
const NOW = new Date('2026-11-11T15:30:00Z'); // Wed 09:30 in Mexico City
const META = {
  cities: [{ slug: 'cdmx', name: 'Mexico City', timezone: TZ, currency: 'MXN' }],
  profiles: [{ slug: 'dates', name: 'Date Night' }, { slug: 'nightlife', name: 'Nightlife & Bars' }],
};

test('weekend window runs Friday 18:00 to Sunday night', () => {
  const w = windows(NOW, TZ);
  assert.equal(w.weekend.from, '2026-11-13T18:00');
  assert.equal(w.weekend.to, '2026-11-15T23:59');
  assert.equal(w.tonight.to, '2026-11-12T04:00');
});

test('local wall-clock converts to the right UTC instant', () => {
  assert.equal(zonedToDate('2026-11-14T20:00', TZ).toISOString(), '2026-11-15T02:00:00.000Z');
});

test('range labels read like the mock', () => {
  const w = windows(NOW, TZ);
  assert.equal(rangeLabel('2026-11-14T00:00', '2026-11-15T23:59', w), 'Sat 14 – Sun 15 Nov');
  assert.equal(rangeLabel(w.tonight.from, w.tonight.to, w), 'Tonight');
});

test('keyword parser: free + weekend + neighborhood', () => {
  const f = parseKeywords('algo gratis este fin de semana en Roma', { meta: META, tz: TZ, now: NOW });
  assert.equal(f.free, true);
  assert.equal(f.neighborhood, 'roma');
  assert.equal(f.from, '2026-11-13T18:00');
  assert.equal(f.text, null);
});

test('keyword parser: category and profile, leftover words become text', () => {
  const f = parseKeywords('date night jazz', { meta: META, tz: TZ, now: NOW });
  assert.equal(f.profile, 'dates');
  assert.deepEqual(f.categories, ['Music']);
});

test('sanitize drops unknown values and never searches the past', () => {
  const w = windows(NOW, TZ);
  const f = sanitize({ from: '2020-01-01T00:00', to: 'nope', categories: ['Music', 'Bogus'], profile: 'x', free: 'yes' },
    { profiles: ['dates'], cities: ['cdmx'], w });
  assert.equal(f.from, w.now);
  assert.equal(f.to, w.default.to);
  assert.deepEqual(f.categories, ['Music']);
  assert.equal(f.profile, null);
  assert.equal(f.free, false);
});

test('dedupe keeps the first of two listings of the same show on the same day', () => {
  const rows = [
    { key: 'a', title: 'Garbage /// Zócalo Capitalino', starts_at: '2026-11-15T02:00:00Z', occurrence_kind: 'run' },
    { key: 'b', title: 'Garbage gratis en el Zócalo', starts_at: '2026-11-15T02:00:00Z', occurrence_kind: 'run' },
    { key: 'c', title: 'Something else entirely', starts_at: '2026-11-15T02:00:00Z', occurrence_kind: 'run' },
  ];
  assert.deepEqual(dedupe(rows).map((r) => r.key), ['a', 'c']);
});

test('chips: one per filter, city fixed', () => {
  const w = windows(NOW, TZ);
  const c = chips({ from: w.weekend.from, to: w.weekend.to, free: true, categories: ['Music'], city: 'cdmx' }, w, META, false);
  assert.deepEqual(c.map((x) => x.label), ['Fri 13 – Sun 15 Nov', 'Free', 'Music', 'Mexico City']);
  assert.equal(c.at(-1).fixed, true);
});

// ---- whole flow with mocks
const row = (key, tier, extra = {}) => ({
  key, occurrence_kind: 'run', title: `Event ${key}`, description: null, starts_at: '2026-11-14T02:00:00Z', ends_at: null,
  all_day: false, timezone: TZ, ongoing: false, venue: 'V', address: null, neighborhood: 'Roma Norte', price_text: null,
  price_min: 0, price_max: null, currency: 'MXN', is_free: true, url: null, category: 'Music', tier, rank: 300, ...extra,
});
function mockFetch({ rows, openai }) {
  const calls = [];
  const f = async (url, opts) => {
    const body = opts && opts.body ? JSON.parse(opts.body) : null;
    calls.push({ url, body });
    if (url.includes('openai.com')) {
      if (!openai) return new Response('nope', { status: 500 });
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(openai) } }] }));
    }
    if (url.endsWith('/rpc/search_events')) return new Response(JSON.stringify(typeof rows === 'function' ? rows(body.params) : rows));
    if (url.endsWith('/rpc/log_search')) return new Response(JSON.stringify(body.id));
    return new Response('null');
  };
  f.calls = calls;
  return f;
}
const ENV = { SCOUT_IQ_URL: 'https://iq', SCOUT_IQ_PUBLISHABLE_KEY: 'pk', OPENAI_API_KEY: 'sk' };

test('3s first, 2s fill to the minimum, the rest under more; nothing reveals scores', async () => {
  const rows = [row('t1', 'top'), row('t2', 'top'), ...Array.from({ length: 15 }, (_, i) => row(`f${i}`, 'fill')), row('m1', 'more')];
  // distinct titles so dedupe keeps them
  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo'];
  rows.forEach((r, i) => { r.title = `${words[i]} night`; });
  const fetchImpl = mockFetch({ rows, openai: { city: null, from: '2026-11-13T18:00', to: '2026-11-15T23:59', text: null, categories: [], profile: null, neighborhood: null, free: true, max_price: null } });
  const logs = [];
  const r = await search({ q: 'free this weekend' }, { env: ENV, meta: META, now: NOW, fetchImpl, log: (p) => logs.push(p) });
  await Promise.all(logs);
  assert.equal(r.results.length, MAIN_MIN);
  assert.deepEqual(r.results.slice(0, 2).map((x) => x.key), ['t1', 't2']);
  assert.equal(r.more.length, 8);
  assert.ok(r.results.every((x) => !('tier' in x) && !('rank' in x)));
  assert.equal(r.parser, 'gpt-5-nano');
  assert.ok(fetchImpl.calls.some((c) => c.url.endsWith('/rpc/log_search') && c.body.id === r.query_id));
});

test('OpenAI failure falls back to keywords and still returns results', async () => {
  const fetchImpl = mockFetch({ rows: [row('a', 'top')], openai: null });
  const r = await search({ q: 'free tonight' }, { env: ENV, meta: META, now: NOW, fetchImpl });
  assert.equal(r.parser, 'keyword');
  assert.equal(r.filters.free, true);
  assert.equal(r.results.length, 1);
});

test('a text search with no matches retries without the text', async () => {
  const fetchImpl = mockFetch({ rows: (p) => (p.text ? [] : [row('x', 'top')]), openai: null });
  const r = await search({ q: 'zzqx tonight' }, { env: ENV, meta: META, now: NOW, fetchImpl });
  assert.equal(r.relaxed, true);
  assert.equal(r.results.length, 1);
});
