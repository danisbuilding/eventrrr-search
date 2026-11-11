// The whole search flow, independent of Cloudflare so it can be tested in Node:
// question → filters (OpenAI or keywords) → Scout IQ search_events → dedupe → main / more → chips.
import { parseWithOpenAI, parseKeywords, sanitize, VENUE_LABELS, ACTIVITY_LABELS } from './parse.js';
import { windows, zonedToDate, rangeLabel, zonedParts } from './time.js';

export const MAIN_MIN = 10;   // fill with 2s until the first screen has at least this many
export const MAIN_MAX = 40;
// Meaning match (cosine similarity, text-embedding-3-small at 512 dims) an event needs to count as "about" the topic.
// Below it, events still show if too few pass, ranked by how close they are. Tune with the search-quality eval.
export const TOPIC_MIN = 0.3;

// The question's topic as a 512-number embedding. Null on any failure: search then works without it.
export async function embed(text, env, fetchImpl = fetch, timeoutMs = 3000) {
  if (!text || !env.OPENAI_API_KEY) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/embeddings', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: env.EMBED_MODEL || 'text-embedding-3-small', input: text.slice(0, 300), dimensions: 512 }),
    });
    if (!res.ok) return null;
    const d = await res.json();
    const v = d?.data?.[0]?.embedding;
    return Array.isArray(v) && v.length === 512 ? v.map((x) => Math.round(x * 1e6) / 1e6) : null;
  } catch { return null; } finally { clearTimeout(timer); }
}

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

export async function search({ q, city, overrides, debug }, { env, meta, now = new Date(), fetchImpl = fetch, log }) {
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
    kids: filters.kids,
    outdoor: filters.outdoor,
    venue_types: filters.venue_types,
    activities: filters.activities,
    limit: 150,
  };
  const vec = filters.topic ? await embed(filters.topic, env, fetchImpl) : null;
  if (vec) { params.embedding = vec; params.topic_min = TOPIC_MIN; }
  const ask = (p) => rpc(env, 'search_events_v2', { params: p }, fetchImpl);
  let rows = await ask(params);

  // Too few events are clearly about the topic: keep the other filters, rank everything by closeness instead.
  if (vec && rows.length < 3) rows = await ask({ ...params, topic_min: null });

  // Nothing at all: drop the narrowest filters, one step at a time, and say which ones were dropped.
  const relaxedBy = [];
  if (!rows.length && filters.text) {
    rows = await ask({ ...params, topic_min: null, text: null });
    relaxedBy.push(`“${filters.text}”`);
  }
  const tagged = filters.kids || filters.outdoor || filters.venue_types?.length || filters.activities?.length || filters.categories?.length;
  if (!rows.length && tagged) {
    rows = await ask({ ...params, topic_min: null, text: null, kids: false, outdoor: false, venue_types: [], activities: [], categories: [] });
    relaxedBy.push(...tagLabels(filters));
  }
  const relaxed = rows.length > 0 && relaxedBy.length > 0;

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
    relaxed_by: relaxed ? relaxedBy : [],
    when_label: rangeLabel(filters.from, filters.to, w),
    expanded,
    timezone: tz,
    results: main.map(publicRow),
    more: more.map(publicRow),
    updated_at: meta.updated_at || null,
    parser,
    topic: filters.topic || null,
    ...(debug ? { debug: { embedded: !!vec, matches: [...main, ...more].map((r) => [r.title, Number(r.match)]) } } : {}),
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

// Plain-words names for the tag filters, for "Nothing matched kid-friendly, outdoors…".
export function tagLabels(f) {
  const out = [];
  if (f.kids) out.push('kid-friendly');
  if (f.outdoor) out.push('outdoors');
  for (const v of f.venue_types || []) out.push((VENUE_LABELS[v] || v).toLowerCase());
  for (const a of f.activities || []) out.push((ACTIVITY_LABELS[a] || a).toLowerCase());
  for (const c of f.categories || []) out.push(c);
  return out;
}

// The "Searching for" chips: one per filter, in plain words. Each carries the field it removes.
export function chips(f, w, meta, relaxed) {
  const out = [];
  const when = rangeLabel(f.from, f.to, w);
  if (when && !(f.from === w.default.from && f.to === w.default.to)) out.push({ field: 'when', label: when });
  if (f.free) out.push({ field: 'free', label: 'Free' });
  if (f.max_price) out.push({ field: 'max_price', label: `Under $${f.max_price}` });
  if (f.kids) out.push({ field: 'kids', label: 'Kid-friendly' });
  if (f.outdoor) out.push({ field: 'outdoor', label: 'Outdoors' });
  for (const v of f.venue_types || []) out.push({ field: 'venue_types', value: v, label: VENUE_LABELS[v] || v });
  for (const a of f.activities || []) out.push({ field: 'activities', value: a, label: ACTIVITY_LABELS[a] || a });
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
