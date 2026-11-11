// The whole search flow, independent of Cloudflare so it can be tested in Node:
// question → filters (OpenAI or keywords) → Scout IQ search_events → dedupe → main / more → chips.
import { parseWithOpenAI, parseKeywords, sanitize } from './parse.js';
import { windows, zonedToDate, rangeLabel, zonedParts } from './time.js';

export const MAIN_MIN = 10;   // fill with 2s until the first screen has at least this many
export const MAIN_MAX = 40;

export async function rpc(env, fn, body, fetchImpl = fetch) {
  const res = await fetchImpl(`${env.SCOUT_IQ_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      apikey: env.SCOUT_IQ_PUBLISHABLE_KEY,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`scout-iq ${fn} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

export async function search({ q, city, overrides }, { env, meta, now = new Date(), fetchImpl = fetch, log }) {
  const started = Date.now();
  const cityRow = (meta.cities || []).find((c) => c.slug === city) || (meta.cities || [])[0] || { slug: 'cdmx', timezone: 'America/Mexico_City' };
  const tz = cityRow.timezone;
  const w = windows(now, tz);
  const profiles = (meta.profiles || []).map((p) => p.slug);
  const cities = (meta.cities || []).map((c) => c.slug);

  // 1. Understand the question.
  let filters, parser;
  if (overrides) {
    filters = sanitize({ ...overrides }, { profiles, cities, w });
    parser = 'edited';
  } else {
    try {
      if (!env.OPENAI_API_KEY) throw new Error('no key');
      filters = await parseWithOpenAI(q, { meta, tz, now, apiKey: env.OPENAI_API_KEY, model: env.OPENAI_MODEL || 'gpt-5-nano', fetchImpl });
      parser = env.OPENAI_MODEL || 'gpt-5-nano';
    } catch (e) {
      filters = parseKeywords(q, { meta, tz, now });
      parser = 'keyword';
    }
  }
  const citySlug = filters.city || cityRow.slug;

  // 2. Ask Scout IQ.
  const params = {
    city: citySlug,
    from: zonedToDate(filters.from, tz).toISOString(),
    to: zonedToDate(filters.to, tz).toISOString(),
    text: filters.text,
    categories: filters.categories,
    profile: filters.profile,
    neighborhood: filters.neighborhood,
    free: filters.free,
    max_price: filters.max_price,
    limit: 150,
  };
  let rows = await rpc(env, 'search_events', { params }, fetchImpl);

  // A text match that finds nothing gets one retry without the text, so "jazz tonight" still shows tonight.
  let relaxed = false;
  if (!rows.length && filters.text && !overrides) {
    rows = await rpc(env, 'search_events', { params: { ...params, text: null } }, fetchImpl);
    relaxed = rows.length > 0;
  }

  // 3. Dedupe and split.
  const unique = dedupe(rows);
  const top = unique.filter((r) => r.tier === 'top');
  const fill = unique.filter((r) => r.tier === 'fill');
  const rest = unique.filter((r) => r.tier === 'more');
  const main = top.slice(0, MAIN_MAX);
  const need = Math.max(0, MAIN_MIN - main.length);
  main.push(...fill.slice(0, need));
  let more = [...fill.slice(need), ...rest, ...top.slice(MAIN_MAX)];
  // Almost nothing rated for this question: show everything found rather than an empty page.
  let expanded = false;
  if (main.length < 3 && more.length) { main.push(...more.slice(0, MAIN_MAX)); more = more.slice(MAIN_MAX); expanded = true; }

  const result = {
    filters: { ...filters, city: citySlug },
    chips: chips({ ...filters, city: citySlug }, w, meta, relaxed),
    relaxed,
    expanded,
    timezone: tz,
    results: main.map(publicRow),
    more: more.map(publicRow),
    updated_at: meta.updated_at || null,
    parser,
  };

  // 4. Log (fire and forget; never blocks or breaks a search).
  result.query_id = crypto.randomUUID();
  if (log && q) {
    log(rpc(env, 'log_search', {
      id: result.query_id, q: (q || '').slice(0, 300), city: citySlug, filters: result.filters, parser,
      result_count: main.length + more.length, top_count: top.length, latency_ms: Date.now() - started,
    }, fetchImpl).catch(() => null));
  }
  return result;
}

// What the browser gets: no tier, no rank, nothing that reveals a score.
export function publicRow(r) {
  return {
    key: r.key, kind: r.occurrence_kind, title: r.title, description: r.description,
    starts_at: r.starts_at, ends_at: r.ends_at, all_day: r.all_day, timezone: r.timezone, ongoing: r.ongoing,
    venue: r.venue, address: r.address, neighborhood: r.neighborhood,
    price_text: r.price_text, price_min: r.price_min, price_max: r.price_max, currency: r.currency, is_free: r.is_free,
    url: r.url, category: r.category,
  };
}

// Same event listed twice by two sources: same local day + near-identical title words. Keep the first (best ranked).
// Same show listed by several sources: keep one per local day. A copy with a start time beats an all-day copy.
export function dedupe(rows) {
  const seen = [];
  const out = [];
  for (const r of rows) {
    const day = localDay(r);
    const words = tokens(r.title);
    const dup = seen.find((s) => s.day === day && s.kind === r.occurrence_kind && similar(s.words, words));
    if (dup) {
      if (dup.row.all_day && !r.all_day) { out[out.indexOf(dup.row)] = r; dup.row = r; }
      continue;
    }
    seen.push({ day, words, kind: r.occurrence_kind, row: r });
    out.push(r);
  }
  return out;
}
// The calendar day where the event happens (not the UTC day: 8 pm in CDMX is already tomorrow in UTC).
function localDay(r) {
  if (!r.starts_at) return '';
  const d = new Date(r.starts_at);
  if (isNaN(d)) return String(r.starts_at).slice(0, 10);
  const p = zonedParts(d, r.timezone || 'America/Mexico_City');
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}
const STOP = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'y', 'the', 'a', 'of', 'in', 'at', 'cdmx', 'se', 'presentara', 'presenta']);
function tokens(s) {
  return new Set((s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !STOP.has(x)));
}
// At least two shared words, covering 60% of the shorter title.
function similar(a, b) {
  if (!a.size || !b.size) return false;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  return n >= 2 && n / Math.min(a.size, b.size) >= 0.6;
}

// The "Searching for" chips: one per filter, in plain words. Each carries the field it removes.
export function chips(f, w, meta, relaxed) {
  const out = [];
  const when = rangeLabel(f.from, f.to, w);
  if (when && !(f.from === w.default.from && f.to === w.default.to)) out.push({ field: 'when', label: when });
  if (f.free) out.push({ field: 'free', label: 'Free' });
  if (f.max_price) out.push({ field: 'max_price', label: `Under $${f.max_price}` });
  for (const c of f.categories || []) out.push({ field: 'category', value: c, label: c });
  if (f.profile) {
    const p = (meta.profiles || []).find((x) => x.slug === f.profile);
    out.push({ field: 'profile', label: p ? p.name : f.profile });
  }
  if (f.neighborhood) out.push({ field: 'neighborhood', label: f.neighborhood.replace(/\b\p{L}/gu, (m) => m.toUpperCase()) });
  if (f.text && !relaxed) out.push({ field: 'text', label: `“${f.text}”` });
  const city = (meta.cities || []).find((c) => c.slug === f.city);
  if (city) out.push({ field: 'city', label: city.name, fixed: true });
  return out;
}
