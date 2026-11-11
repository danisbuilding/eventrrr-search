// Turns a plain-language question into search filters.
// First choice: OpenAI with a strict JSON schema. If that fails or times out: a keyword parser that needs no AI.
import { windows, WEEKDAYS } from './time.js';

export const CATEGORIES = ['Music', 'Clubs & Parties', 'Art & Exhibitions', 'Food & Drink', 'Creativity & Crafts',
  'Talks & Learning', 'Social & Networking', 'Film & Performance', 'Wellness & Sport', 'Markets & Design', 'Tech', 'Other'];

const FILTER_SCHEMA = (profiles, cities) => ({
  type: 'object',
  additionalProperties: false,
  required: ['city', 'from', 'to', 'text', 'categories', 'profile', 'neighborhood', 'free', 'max_price'],
  properties: {
    city: { type: ['string', 'null'], enum: [...cities, null], description: 'City slug if the person names a city, else null' },
    from: { type: 'string', description: 'Window start, local wall-clock time, YYYY-MM-DDTHH:MM' },
    to: { type: 'string', description: 'Window end, local wall-clock time, YYYY-MM-DDTHH:MM' },
    text: { type: ['string', 'null'], description: 'Only a proper name or specific keyword to match in titles/venues (an artist, venue, festival, dish). Null when categories/profile already capture the request.' },
    categories: { type: 'array', items: { type: 'string', enum: CATEGORIES } },
    profile: { type: ['string', 'null'], enum: [...profiles, null], description: 'The curator profile that best fits the mood of the request, or null' },
    neighborhood: { type: ['string', 'null'], description: 'Neighborhood or area named by the person, as written (e.g. "Roma", "Condesa", "Coyoacán")' },
    free: { type: 'boolean' },
    max_price: { type: ['number', 'null'], description: 'Upper price limit in local currency if stated' },
  },
});

function systemPrompt(meta, w, tz) {
  const prof = (meta.profiles || []).map((p) => `- ${p.slug}: ${p.name}${p.persona ? ` — ${p.persona}` : ''}`).join('\n');
  const today = w.now.slice(0, 10);
  const days = Array.from({ length: 9 }, (_, i) => {
    const d = new Date(Date.parse(today + 'T12:00:00Z') + i * 864e5);
    return `${WEEKDAYS[d.getUTCDay()]} ${d.toISOString().slice(0, 10)}${i === 0 ? ' (today)' : ''}`;
  }).join(', ');
  return `You turn a person's question about things to do into search filters for an events database. Return the fewest filters that capture what they literally asked for.
Current local time: ${w.now} (${tz}). Next days: ${days}.
Ready-made windows: tonight ${w.tonight.from} → ${w.tonight.to}; tomorrow ${w.tomorrow.from} → ${w.tomorrow.to}; this weekend ${w.weekend.from} → ${w.weekend.to}; this week ${w.week.from} → ${w.week.to}; no time mentioned → ${w.default.from} → ${w.default.to}.
A named weekday means its next date from the list above ("Friday night" = that Friday 18:00 → Saturday 04:00).
Curator profiles (set one only when the mood clearly matches: a date, kids, nightlife…):
${prof || '- (none)'}
Rules:
- categories: ONLY when the person names a kind of event (music, art, food, a workshop…). Never add categories for vague asks like "something fun", "free stuff", "plans". At most 2.
- text: names and specific things to match in titles or venues — an artist, band, venue, festival, dish, topic ("Garbage", "ceramics", "Radiohead", "tacos"). A single unfamiliar word or name is almost always text. Never put a time, a neighborhood or a generic word ("stuff", "things", "events", "plans", "algo", "cosas") in text.
- neighborhood: only an area the person named, as written. Don't repeat it in text.
- free: true for "free", "gratis", "sin costo". "Cheap"/"barato" → max_price 300 (MXN cities).
- The question may be English or Spanish.
Examples:
"free stuff this weekend" → weekend window, free=true, no categories, text null.
"something romantic friday night" → Friday 18:00 → Saturday 04:00, profile for dates, no categories.
"algo de arte en Roma" → categories ["Art & Exhibitions"], neighborhood "Roma", text null.
"garbage" → text "Garbage", no categories.
"jazz tonight" → tonight window, categories ["Music"], text "jazz".`;
}

export async function parseWithOpenAI(q, { meta, tz, now, apiKey, model, timeoutMs = 6000, fetchImpl = fetch }) {
  const w = windows(now, tz);
  const profiles = (meta.profiles || []).map((p) => p.slug);
  const cities = (meta.cities || []).map((c) => c.slug);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        ...(model.startsWith('gpt-5') ? { reasoning_effort: 'low' } : { temperature: 0 }),
        messages: [
          { role: 'system', content: systemPrompt(meta, w, tz) },
          { role: 'user', content: q },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'filters', strict: true, schema: FILTER_SCHEMA(profiles, cities) } },
      }),
    });
    if (!res.ok) throw new Error(`openai ${res.status}`);
    const data = await res.json();
    const out = JSON.parse(data.choices[0].message.content);
    return sanitize(out, { profiles, cities, w });
  } finally {
    clearTimeout(timer);
  }
}

// Keep only well-formed values; the model is good but the database deserves certainty.
export function sanitize(f, { profiles, cities, w }) {
  const okTime = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(s);
  let from = okTime(f.from) ? f.from : w.default.from;
  let to = okTime(f.to) ? f.to : w.default.to;
  if (to <= from) to = w.default.to;
  if (from < w.now.slice(0, 10) + 'T00:00') from = w.now; // never search the past
  const hood = typeof f.neighborhood === 'string' ? f.neighborhood.trim().toLowerCase() : '';
  if (typeof f.text === 'string' && hood && f.text.trim().toLowerCase() === hood) f.text = null;
  return {
    city: cities.includes(f.city) ? f.city : null,
    from, to,
    text: typeof f.text === 'string' && f.text.trim() ? f.text.trim().slice(0, 80) : null,
    categories: Array.isArray(f.categories) ? f.categories.filter((c) => CATEGORIES.includes(c)).slice(0, 2) : [],
    profile: profiles.includes(f.profile) ? f.profile : null,
    neighborhood: typeof f.neighborhood === 'string' && f.neighborhood.trim() ? f.neighborhood.trim().slice(0, 60) : null,
    free: f.free === true,
    max_price: typeof f.max_price === 'number' && f.max_price > 0 ? f.max_price : null,
  };
}

// ---------------------------------------------------------------------------------------------------------
// Keyword fallback: no AI, predictable, good enough for "free tonight", "jazz", "Roma this weekend".
// ---------------------------------------------------------------------------------------------------------
const CATEGORY_WORDS = [
  ['Music', /\b(music|m[uú]sica|concierto|concert|live|en vivo|jazz|rock|band|banda|dj set|gig)\b/],
  ['Clubs & Parties', /\b(club|party|fiesta|rave|techno|house|dancing|bailar|perreo|nightlife|after)\b/],
  ['Art & Exhibitions', /\b(art|arte|exhibit\w*|exposici[oó]n|gallery|galer[ií]a|museum|museo|opening|inauguraci[oó]n)\b/],
  ['Food & Drink', /\b(food|comida|eat|comer|dinner|cena|brunch|drinks?|tasting|cata|mezcal|wine|vino|beer|cerveza|pop.?up|supper)\b/],
  ['Creativity & Crafts', /\b(workshop|taller|ceramic\w*|cer[aá]mica|craft\w*|drawing|dibujo|class|clase)\b/],
  ['Talks & Learning', /\b(talk|charla|conferencia|lecture|book|libro|reading|lectura|panel)\b/],
  ['Film & Performance', /\b(film|movie|cine|pel[ií]cula|screening|theater|theatre|teatro|dance|danza|performance|comedy|comedia)\b/],
  ['Wellness & Sport', /\b(run|running|correr|yoga|bike|bici|hike|sport|deporte|wellness)\b/],
  ['Markets & Design', /\b(market|mercado|bazaar|bazar|design|dise[nñ]o|vintage|flea)\b/],
  ['Social & Networking', /\b(networking|meetup|social|community|comunidad)\b/],
  ['Tech', /\b(tech|hackathon|startup|ai|coding)\b/],
];
const PROFILE_WORDS = [
  ['dates', /\b(date|cita|romantic|rom[aá]ntico)\b/],
  ['familykids', /\b(kids?|niñ[oa]s|family|familia|children)\b/],
  ['familybabies', /\b(bab(y|ies)|beb[eé]s?|toddler)\b/],
  ['nightlife', /\b(nightlife|vida nocturna|late night)\b/],
];
const TIME_WORDS = [
  ['tonight', /\b(tonight|esta noche|hoy en la noche)\b/],
  ['today', /\b(today|hoy)\b/],
  ['tomorrow', /\b(tomorrow|ma[nñ]ana)\b/],
  ['weekend', /\b(weekend|fin de semana|finde|saturday|sunday|s[aá]bado|domingo)\b/],
  ['week', /\b(this week|esta semana)\b/],
];
const STOP = new Set(('a an and any are at best cool do for fun find for free gratis good i in is it like me near of on or ' +
  'show some something stuff that the things this to tonight today tomorrow weekend week what where with ' +
  'algo de del el en esta este fin hay la las los para por que qué semana un una y hoy mañana noche cosas ' +
  'cheap barato barata events eventos event evento plans planes go ir do hacer want quiero ' +
  'ideas idea options opciones recommendations recomendaciones suggestions sugerencias night noche fun divertido').split(' '));

export function parseKeywords(q, { meta, tz, now }) {
  const w = windows(now, tz);
  const s = (q || '').toLowerCase();
  const cats = CATEGORY_WORDS.filter(([, re]) => re.test(s)).map(([c]) => c);
  const profiles = (meta.profiles || []).map((p) => p.slug);
  const profile = (PROFILE_WORDS.find(([slug, re]) => profiles.includes(slug) && re.test(s)) || [null])[0];
  const when = (TIME_WORDS.find(([, re]) => re.test(s)) || ['default'])[0];
  const free = /\b(free|gratis|gratuit[oa]s?|sin costo)\b/.test(s);
  const cheap = /\b(cheap|barat[oa]s?)\b/.test(s);
  const known = (meta.neighborhoods || ['roma', 'condesa', 'coyoac[aá]n', 'centro', 'ju[aá]rez', 'polanco', 'san rafael',
    'santa mar[ií]a la ribera', 'escand[oó]n', 'narvarte', 'del valle', 'tabacalera', 'doctores', 'san miguel chapultepec']);
  const hoodRe = new RegExp(`\\b(${known.join('|')})\\b`);
  const hoodMatch = hoodRe.exec(s);
  // Whatever is left after removing recognized words becomes the text match.
  let rest = s;
  for (const [, re] of [...CATEGORY_WORDS, ...PROFILE_WORDS, ...TIME_WORDS]) rest = rest.replace(new RegExp(re.source, 'g'), ' ');
  if (hoodMatch) rest = rest.replace(hoodMatch[0], ' ');
  const words = rest.split(/[^\p{L}\p{N}&'-]+/u).filter((x) => x && !STOP.has(x) && x.length > 1);
  return {
    city: null,
    from: w[when].from,
    to: w[when].to,
    text: words.length ? words.join(' ').slice(0, 80) : null,
    categories: cats.slice(0, 4),
    profile,
    neighborhood: hoodMatch ? hoodMatch[0] : null,
    free,
    max_price: cheap ? 300 : null,
  };
}
