// The whole search flow, independent of Cloudflare so it can be tested in Node:
// question → filters (OpenAI or keywords) → Scout IQ search_events → dedupe → main / more → chips.
import { parseWithOpenAI, parseKeywords, enforceWhen, sanitize, VENUE_LABELS, ACTIVITY_LABELS, TIME_LABELS } from './parse.js';
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

// browse: the filter-first page (search.eventrrr.com since 2026-11-12). People pick When / What / More and may add a
// keyword; no AI reads anything, every match is shown (grouped by day in the browser), and a keyword that matches
// nothing is dropped with a note. The sentence-reading path below (q without filters) is kept but no longer used by the page.
export async function search({ q, city, overrides, browse = false, keywordsOnly = false, debug, tune }, { env, meta, now = new Date(), fetchImpl = fetch, log, waitUntil }) {
  const started = Date.now();
  // Only live cities can be searched ("Coming soon" ones are listed in the menu but not selectable); else the first live one.
  const live = (meta.cities || []).filter((c) => c.status !== 'soon');
  const cityRow = live.find((c) => c.slug === city) || live[0] || { slug: 'cdmx', timezone: 'America/Mexico_City' };
  const tz = cityRow.timezone;
  const w = windows(now, tz);
  const profiles = (meta.profiles || []).map((p) => p.slug);
  const cities = live.map((c) => c.slug);

  // Timings per step, returned with debug. tune (test traffic only) lets the quality runs compare models.
  const t0 = Date.now();
  const timing = {};
  const TUNE_MODELS = ['gpt-5-nano', 'gpt-5-mini', 'gpt-4.1-nano', 'gpt-4.1-mini']; // cheap ones only
  const model = (tune && TUNE_MODELS.includes(tune.model) && tune.model) || env.OPENAI_MODEL || 'gpt-4.1-mini';
  const effort = (tune && ['minimal', 'low'].includes(tune.effort) && tune.effort) || env.OPENAI_EFFORT || 'low';

  // 1. Understand the question.
  let filters, parser;
  if (overrides) {
    const o = { ...overrides };
    // A When preset by name ("weekend"): resolved here, so the page never computes dates itself.
    const preset = typeof o.when === 'string' && whenOptions(w).find((x) => x.id === o.when);
    if (preset) { o.from = preset.from; o.to = preset.to; }
    filters = sanitize(o, { profiles, cities, w, overlap: false, maxCats: browse ? 20 : 2 });
    parser = browse ? 'browse' : 'edited';
  } else if (keywordsOnly) {
    // Old ?q= links on the filter-first page: read them with the keyword rules (no AI) and show the filters they set.
    filters = enforceWhen(parseKeywords(q, { meta, tz, now }), q, { tz, now });
    parser = 'keyword';
  } else {
    // Same question in the same city within 15 minutes: reuse the AI's reading (Cloudflare's cache; free).
    const cacheKey = `https://parse.cache/${encodeURIComponent(cityRow.slug)}/${encodeURIComponent(model)}/${encodeURIComponent((q || '').trim().toLowerCase())}`;
    const cache = !tune && typeof caches !== 'undefined' ? caches.default : null;
    try {
      const hit = cache ? await cache.match(cacheKey) : null;
      if (hit) {
        const c = await hit.json();
        filters = enforceWhen(sanitize(c.filters, { profiles, cities, w }), q, { tz, now });
        parser = `${model} (cached)`;
      } else {
        if (!env.OPENAI_API_KEY) throw new Error('no key');
        filters = await parseWithOpenAI(q, { meta, tz, now, apiKey: env.OPENAI_API_KEY, model, effort, fetchImpl });
        filters = enforceWhen(filters, q, { tz, now });
        parser = model;
        if (cache && waitUntil) waitUntil(cache.put(cacheKey, new Response(JSON.stringify({ filters }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'max-age=900' } })));
      }
    } catch (e) {
      filters = enforceWhen(parseKeywords(q, { meta, tz, now }), q, { tz, now });
      parser = 'keyword';
    }
  }
  timing.parse = Date.now() - t0;
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
    indoor: filters.indoor,
    times: filters.times,
    venue_types: filters.venue_types,
    activities: filters.activities,
    limit: 150,
  };
  let t1 = Date.now();
  const vec = filters.topic ? await embed(filters.topic, env, fetchImpl) : null;
  timing.embed = Date.now() - t1;
  if (vec) { params.embedding = vec; params.topic_min = TOPIC_MIN; }
  timing.rpc = [];
  const ask = async (p) => { const a = Date.now(); const r = await rpc(env, 'search_events_v3', { params: p }, fetchImpl); timing.rpc.push(Date.now() - a); return r; };
  let rows = await ask(params);

  // Too few events are clearly about the topic: keep the other filters, rank everything by closeness instead.
  // If none were close and the topic names something the filters can't (the "dance" in "dance classes"), say so.
  const relaxedBy = [];
  if (vec && rows.length < 3) {
    const close = rows.length;
    rows = await ask({ ...params, topic_min: null });
    if (!close && rows.length && specificWords(filters.topic).length) relaxedBy.push(`“${filters.topic}”`);
  }

  // A keyword of several words that matches nothing as a whole: any of its words will do ("jazz roma").
  if (browse && !rows.length && filters.text) {
    // Short and filler words would match inside other words ("ice" in "price"), so only words of 4+ letters count.
    const FILLER = new Set(['this', 'that', 'with', 'near', 'from', 'para', 'with', 'some', 'cerca', 'algo', 'como', 'events', 'event']);
    const words = [...new Set(filters.text.toLowerCase().split(/\s+/).filter((x) => x.length >= 4 && !FILLER.has(x)))].slice(0, 4);
    if (words.length > 1) {
      const seen = new Set();
      for (const part of await Promise.all(words.map((x) => ask({ ...params, text: x })))) {
        for (const r of part) if (!seen.has(r.key + r.starts_at)) { seen.add(r.key + r.starts_at); rows.push(r); }
      }
      rows.sort((a, b) => Number(b.rank) - Number(a.rank));
    }
  }
  // Nothing at all: drop the narrowest filters, one step at a time, and say which ones were dropped.
  if (!rows.length && filters.text) {
    rows = await ask({ ...params, topic_min: null, text: null });
    relaxedBy.push(`“${filters.text}”`);
  }
  // Time of day and indoors the AI read into the question: most listings have no start time, so drop them next.
  if (!overrides && !rows.length && ((filters.times || []).length || filters.indoor)) {
    rows = await ask({ ...params, topic_min: null, text: null, times: [], indoor: false });
    relaxedBy.push(...(filters.times || []).map((t) => TIME_LABELS[t].toLowerCase()), ...(filters.indoor ? ['indoors'] : []));
  }
  // First the kind-of-thing filters (activity, venue, category), keeping who/where (kids, outdoors); then those too.
  const kinds = { venue_types: filters.venue_types || [], activities: filters.activities || [], categories: filters.categories || [] };
  // Filters a person picked by hand stay as picked: an empty result then says so instead of guessing.
  if (!overrides && !rows.length && (kinds.venue_types.length || kinds.activities.length || kinds.categories.length)) {
    rows = await ask({ ...params, topic_min: null, text: null, times: [], indoor: false, venue_types: [], activities: [], categories: [] });
    relaxedBy.push(...tagLabels({ ...kinds }));
  }
  if (!overrides && !rows.length && (filters.kids || filters.outdoor)) {
    rows = await ask({ ...params, topic_min: null, text: null, times: [], indoor: false, venue_types: [], activities: [], categories: [], kids: false, outdoor: false });
    relaxedBy.push(...tagLabels({ kids: filters.kids, outdoor: filters.outdoor }));
  }
  const relaxed = rows.length > 0 && relaxedBy.length > 0;
  // A question with words in it that produced no filter at all ("asdfgh"): say it wasn't understood.
  const unclear = !overrides && !!(q && /\p{L}{2}/u.test(q)) && !filters.text && !filters.topic && !filters.profile
    && !filters.neighborhood && !filters.free && !filters.paid && !filters.max_price && !filters.kids && !filters.outdoor
    && !filters.indoor && !(filters.times || []).length && !(filters.categories || []).length
    && !(filters.venue_types || []).length && !(filters.activities || []).length
    && filters.from === w.default.from && filters.to === w.default.to;

  // 3. Dedupe and split.
  // Paid = a stated price, or a listing that says it costs something ("Prices on the listing"); unknown prices drop out.
  const isPaid = (r) => !r.is_free && (Number(r.price_min) > 0 || !!(r.price_text && r.price_text.trim()));
  const kept = rows.filter((r) => (!filters.hide_ongoing || !r.ongoing) && (!filters.paid || isPaid(r)));
  const unique = dedupe(kept);
  const browsing = browse || keywordsOnly;
  const top = unique.filter((r) => r.tier === 'top');
  const fill = unique.filter((r) => r.tier === 'fill');
  const rest = unique.filter((r) => r.tier === 'more');
  const main = top.slice(0, MAIN_MAX);
  const need = Math.max(0, MAIN_MIN - main.length);
  main.push(...fill.slice(0, need));
  let more = [...fill.slice(need), ...rest, ...top.slice(MAIN_MAX)];
  // Almost nothing rated for this question: show everything found rather than an empty page.
  let expanded = false;
  if (browsing) { main.length = 0; main.push(...unique.slice(0, 200)); more = []; }
  else if (main.length < 3 && more.length) { main.push(...more.slice(0, MAIN_MAX)); more = more.slice(MAIN_MAX); expanded = true; }

  const result = {
    filters: { ...filters, city: citySlug },
    chips: chips({ ...filters, city: citySlug }, w, meta, relaxed),
    relaxed,
    relaxed_by: relaxed ? relaxedBy : [],
    unclear,
    when_label: rangeLabel(filters.from, filters.to, w),
    when_options: whenOptions(w),
    categories: meta.categories || [],
    expanded,
    timezone: tz,
    results: main.map(publicRow),
    more: more.map(publicRow),
    updated_at: meta.updated_at || null,
    parser,
    topic: filters.topic || null,
    ...(debug ? { debug: { timing: { ...timing, total: Date.now() - t0 }, embedded: !!vec, matches: [...main, ...more].map((r) => [r.title, Number(r.match)]) } } : {}),
  };

  // 4. Log (fire and forget; never blocks or breaks a search).
  result.query_id = crypto.randomUUID();
  if (log && (q || browsing)) {
    log(rpc(env, 'log_search', {
      id: result.query_id, q: (q || (filters.text ? `kw:${filters.text}` : '')).slice(0, 300), city: citySlug, filters: result.filters, parser,
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
    price_text: r.is_free && (r.price_text || '').length > 40 ? 'Free' : r.price_text, price_min: r.price_min, price_max: r.price_max, currency: r.currency, is_free: r.is_free,
    url: r.url, category: r.category,
    ...(r.title_original && r.title_original !== r.title ? { title_original: r.title_original } : {}),
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
      const better = (dup.row.all_day && !r.all_day) || (dup.row.all_day === r.all_day && dup.row.price_min == null && r.price_min != null);
      if (better) { out[out.indexOf(dup.row)] = r; dup.row = r; }
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
const STOP = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'y', 'the', 'a', 'of', 'in', 'at', 'cdmx', 'se', 'presentara', 'presenta',
  'precios', 'sold', 'out', 'llegara', 'dara', 'show', 'tour', 'mexico']);
// Words too general to identify a show on their own ("Concierto" must not swallow every concert).
const GENERIC = new Set(['concierto', 'taller', 'talleres', 'exposicion', 'festival', 'fiesta', 'feria', 'musica', 'cine', 'proyeccion',
  'evento', 'noche', 'party', 'live', 'workshop', 'exhibition', 'concert', 'gratis', 'free', 'apertura', 'inauguracion']);
function tokens(s) {
  return new Set((s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !STOP.has(x)));
}
// At least two shared words covering 60% of the shorter title, or the shorter title's words all inside the longer one
// with at least one specific word ("Pignoise" vs "PRECIOS: Pignoise se presentará en el Foro Indie Rocks!").
function similar(a, b) {
  if (!a.size || !b.size) return false;
  let n = 0; for (const x of a) if (b.has(x)) n++;
  if (n >= 2 && n / Math.min(a.size, b.size) >= 0.6) return true;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  return [...small].every((x) => big.has(x)) && [...small].some((x) => x.length >= 4 && !GENERIC.has(x));
}

// The When filter's presets, as exact local ranges for this moment.
export function whenOptions(w) {
  return [
    ['today', 'Today', w.today],
    ['tonight', 'Tonight', w.tonight],
    ['tomorrow', 'Tomorrow', w.tomorrow],
    ['weekend', 'This weekend', w.weekend],
    ['nextweek', 'Next week', w.nextweek],
    ['any', 'Next 2 weeks', w.default],
  ].map(([id, label, r]) => ({ id, label, from: r.from, to: r.to }));
}

// Words in a topic that no filter covers ("dance" in "dance classes"); empty when tags and categories say it all.
const COVERED = new Set(('outdoor outdoors outside open air indoor indoors activities activity things thing stuff events event ideas plans ' +
  'kids kid children child family families friendly museum museums gallery galleries park parks workshop workshops class classes ' +
  'tour tours concert concerts live music party parties exhibition exhibitions art arts culture cultural free cheap film films movie ' +
  'movies talk talks lecture lectures market markets food drink drinks show shows theater theatre rainy rain day for the and of in at to ' +
  'with on do something some fun night evening morning afternoon weekend week today tonight tomorrow affordable budget pesos under ' +
  'mexico city cdmx a an or new local nearby near').split(' '));
export function specificWords(topic) {
  return (topic || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/).filter((x) => x.length > 2 && !COVERED.has(x) && !/^\d+$/.test(x));
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
  if (f.paid) out.push({ field: 'paid', label: 'Paid' });
  if (f.max_price) out.push({ field: 'max_price', label: `Under $${f.max_price}` });
  if (f.kids) out.push({ field: 'kids', label: 'Kid-friendly' });
  if (f.outdoor) out.push({ field: 'outdoor', label: 'Outdoors' });
  if (f.indoor) out.push({ field: 'indoor', label: 'Indoors' });
  for (const t of f.times || []) out.push({ field: 'times', value: t, label: TIME_LABELS[t] || t });
  if (f.hide_ongoing) out.push({ field: 'hide_ongoing', label: 'No ongoing exhibitions' });
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
