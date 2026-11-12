// Eventrrr Search — browser app. No build step: plain ES modules, one dependency (supabase-js) for sign-in and saving.
const C = window.SEARCH_CONFIG || {};
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const desktop = window.matchMedia('(min-width: 1024px)');

const state = {
  city: localStorage.getItem('search.city') || null,
  data: null,          // last /api/search response
  picks: [],           // home "Top picks this week"
  showMore: false,
  ongoingOpen: false,
  selected: null,      // key of the open event
  user: null,
  saved: new Set(),    // scout keys already in the person's Eventrrr calendar
  busy: new Set(),
  meta: null,
};

// ---------------------------------------------------------------- data
async function api(path, body) {
  const res = await fetch(path, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}
// Test mode (?test=1, kept for the visit): searches and clicks aren't logged, so quality tests don't skew usage numbers.
const TEST = (() => {
  try {
    if (new URLSearchParams(location.search).has('test')) sessionStorage.setItem('search.test', '1');
    return sessionStorage.getItem('search.test') === '1';
  } catch { return new URLSearchParams(location.search).has('test'); }
})();
if (TEST) document.addEventListener('DOMContentLoaded', () => {
  const b = document.querySelector('.brand');
  if (b) b.insertAdjacentHTML('afterend', '<span class="test-badge">Test mode</span>');
});
function logAction(action, key) {
  if (TEST) return;
  const qid = state.data && state.data.query_id;
  try { navigator.sendBeacon('/api/log', new Blob([JSON.stringify({ query_id: qid, action, event_key: key })], { type: 'application/json' })); } catch { /* ignore */ }
}
const findEvent = (key) => [...(state.data?.results || []), ...(state.data?.more || [])].find((e) => e.key === key);

// ---------------------------------------------------------------- formatting
const fmt = (iso, tz, opts) => new Intl.DateTimeFormat('en-GB', { timeZone: tz, ...opts }).format(new Date(iso));
const dayKey = (e) => fmt(e.starts_at, e.timezone, { year: 'numeric', month: '2-digit', day: '2-digit' });
function whenCol(e) {
  if (e.ongoing) return e.ends_at ? `until\n${fmt(e.ends_at, e.timezone, { day: 'numeric', month: 'short' })}` : 'ongoing';
  if (e.all_day) return 'All day';
  return fmt(e.starts_at, e.timezone, { hour: '2-digit', minute: '2-digit', hour12: false });
}
function whenLong(e) {
  if (e.ongoing) {
    const a = fmt(e.starts_at, e.timezone, { weekday: 'short', day: 'numeric', month: 'short' });
    return e.ends_at ? `${a} – ${fmt(e.ends_at, e.timezone, { weekday: 'short', day: 'numeric', month: 'short' })}` : `From ${a}`;
  }
  const d = fmt(e.starts_at, e.timezone, { weekday: 'short', day: 'numeric', month: 'short' });
  return e.all_day ? `${d}, all day` : `${d}, ${fmt(e.starts_at, e.timezone, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}
function price(e, full = false) {
  if (e.is_free || e.price_min === 0) return 'Free';
  if (e.price_text) {
    if (full) return e.price_text;
    const t = e.price_text.split(/\n|;/)[0].trim(); // rows: first price line only
    return t.length > 40 ? t.slice(0, 38) + '…' : t;
  }
  if (e.price_min != null) return `$${Math.round(e.price_min)}${e.currency ? ' ' + e.currency : ''}`;
  return null;
}
const metaLine = (e) => [e.venue, e.neighborhood, price(e)].filter(Boolean).join(' · ');
function dayLabel(sample) {
  const tz = sample.timezone;
  const k = dayKey(sample);
  const today = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const tomorrow = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 864e5));
  const long = fmt(sample.starts_at, tz, { weekday: 'long', day: 'numeric', month: 'short' });
  if (k === today) return `Today · ${long}`;
  if (k === tomorrow) return `Tomorrow · ${long}`;
  return long;
}
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; } };
const plus = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';
const check = '<svg width="18" height="18" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
const xIcon = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3L3 13"/></svg>';

// ---------------------------------------------------------------- the finder (filter-first since 2026-11-12)
// People pick When and What (Eventrrr's categories), optionally More (price, time of day, setting, kids, ongoing) and a
// keyword. Every change re-runs the search at once; no AI reads anything, so it's fast, free and predictable.
// The whole state lives in the URL (shareable, back button works). Old ?q= links are read with the keyword rules.
const CATS = ['Music', 'Clubs & Parties', 'Art & Exhibitions', 'Food & Drink', 'Creativity & Crafts', 'Talks & Learning',
  'Social & Networking', 'Film & Performance', 'Wellness & Sport', 'Markets & Design', 'Tech', 'Other'];
const WHEN = [['any', 'Next 2 weeks'], ['today', 'Today'], ['tonight', 'Tonight'], ['tomorrow', 'Tomorrow'],
  ['weekend', 'This weekend'], ['nextweek', 'Next week'], ['custom', 'Pick dates']];
const TIME_OPTS = [['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening'], ['late', 'Late night']];
const EXTRA_FIELDS = ['profile', 'neighborhood', 'venue_types', 'activities', 'max_price'];
// Ongoing runs (exhibitions and the like) are hidden unless someone picks Show ongoing.
const blank = () => ({ when: 'any', from: '', to: '', cats: [], kw: '', price: '', times: [], setting: '', kids: false, hideOngoing: true, extra: {} });
state.f = blank();
state.open = null;     // which filter dropdown is open

function fromURL() {
  const p = new URLSearchParams(location.search);
  const f = blank();
  const w = p.get('when');
  if (w && WHEN.some(([id]) => id === w)) f.when = w;
  if (f.when === 'custom') { f.from = p.get('from') || ''; f.to = p.get('to') || ''; if (!f.from || !f.to) f.when = 'any'; }
  const known = state.meta?.categories?.length ? state.meta.categories : CATS;
  f.cats = p.getAll('what').filter((c) => known.includes(c));
  f.kw = (p.get('kw') || '').slice(0, 60);
  f.price = ['free', 'paid'].includes(p.get('price')) ? p.get('price') : '';
  f.times = p.getAll('time').filter((t) => TIME_OPTS.some(([k]) => k === t));
  f.setting = ['indoor', 'outdoor'].includes(p.get('setting')) ? p.get('setting') : '';
  f.kids = p.get('kids') === '1';
  f.hideOngoing = p.get('ongoing') !== 'show';
  if (p.get('city')) state.city = p.get('city').toLowerCase().slice(0, 40);
  return f;
}
function toURL(f) {
  const p = new URLSearchParams();
  if (f.when !== 'any') p.set('when', f.when);
  if (f.when === 'custom') { p.set('from', f.from); p.set('to', f.to); }
  f.cats.forEach((c) => p.append('what', c));
  if (f.kw) p.set('kw', f.kw);
  if (f.price) p.set('price', f.price);
  f.times.forEach((t) => p.append('time', t));
  if (f.setting) p.set('setting', f.setting);
  if (f.kids) p.set('kids', '1');
  if (!f.hideOngoing) p.set('ongoing', 'show');
  if (state.city && state.city !== defaultCity()) p.set('city', state.city);
  if (TEST) p.set('test', '1');
  const s = p.toString();
  return s ? `?${s}` : location.pathname;
}
function requestFilters(f) {
  return {
    ...(f.when === 'custom' ? { from: `${f.from}T00:00`, to: `${f.to}T23:59` } : { when: f.when }),
    categories: f.cats, text: f.kw || null, free: f.price === 'free', paid: f.price === 'paid', times: f.times,
    outdoor: f.setting === 'outdoor', indoor: f.setting === 'indoor', kids: f.kids, hide_ongoing: f.hideOngoing, ...f.extra,
  };
}
// The server's filters (from an old ?q= link) → the finder's state.
function fromServer(sf, d) {
  const f = blank();
  const o = (d.when_options || []).find((x) => x.from === sf.from && x.to === sf.to);
  if (o) f.when = o.id; else { f.when = 'custom'; f.from = sf.from.slice(0, 10); f.to = sf.to.slice(0, 10); }
  f.cats = sf.categories || [];
  f.kw = sf.text || '';
  f.price = sf.free ? 'free' : sf.paid ? 'paid' : '';
  f.times = sf.times || [];
  f.setting = sf.outdoor ? 'outdoor' : sf.indoor ? 'indoor' : '';
  f.kids = !!sf.kids;
  for (const k of EXTRA_FIELDS) { const v = sf[k]; if (v && !(Array.isArray(v) && !v.length)) f.extra[k] = v; }
  return f;
}

async function initHome() {
  if (!state.city) state.city = 'cdmx';
  fetch('/config/headlines.json').then((r) => r.json()).then((h) => {
    const list = (h.headlines || []).filter(Boolean);
    $('#headline').textContent = list.length ? list[Math.floor(Math.random() * list.length)] : 'What are you in the mood for?';
  }).catch(() => { $('#headline').textContent = 'What are you in the mood for?'; });
  api('/api/meta').then((m) => {
    state.meta = m;
    const cities = m.cities || [];
    const before = state.city;
    if (!liveCities().find((c) => c.slug === state.city)) state.city = defaultCity();
    renderCity();
    renderFinder();
    if (state.city !== before) refresh({ push: false });
  }).catch(() => { /* meta is optional */ });
}
// The city menu: live cities are selectable, "soon" ones are listed as Coming soon (cities.search_status in Scout IQ).
const liveCities = () => (state.meta?.cities || []).filter((c) => c.status !== 'soon');
const defaultCity = () => liveCities()[0]?.slug || 'cdmx';
function renderCity() {
  const cities = state.meta?.cities || [];
  const cur = cities.find((c) => c.slug === state.city);
  $('#city-name').textContent = cur ? cur.name : 'Mexico City';
  const btn = $('#city-btn');
  btn.setAttribute('aria-expanded', state.open === 'city');
  btn.classList.toggle('open', state.open === 'city');
  const pop = $('#city-pop');
  pop.hidden = state.open !== 'city';
  if (state.open === 'city') {
    pop.innerHTML = '<div class="phead">City</div>' + (cities.length ? cities.map((c) => c.status === 'soon'
      ? `<div class="mopt soon" aria-disabled="true"><span class="rbox"></span>${esc(c.name)}<span class="soon-tag">Coming soon</span></div>`
      : mopt('city', c.slug, c.name, c.slug === state.city)).join('') : mopt('city', 'cdmx', 'Mexico City', true));
  }
}
function setCity(slug) {
  state.open = null;
  if (slug === state.city) { renderCity(); return; }
  state.city = slug;
  try { localStorage.setItem('search.city', slug); } catch { /* private mode */ }
  state.f = { ...state.f, extra: {} }; // a neighborhood from another city means nothing here
  renderCity();
  refresh();
}

// Filter pills. Each opens a dropdown: single-choice ones (When, Price, Setting) close on pick, multi-choice ones
// (What, Time of day) are checkboxes and stay open. Kid-friendly and Hide ongoing are on/off pills.
// Phones show When, What, Hide ongoing and "⋯" (the rest); desktop shows every pill left to right.
const chevron = '<svg class="chev-d" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
const tick = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M3 8.5l3.2 3L13 4.5"/></svg>';
// What the More dropdown holds: everything but When, Event type and Ongoing on phones; just Kid-friendly on desktop.
function moreCount(f) { return (desktop.matches ? [f.kids] : [f.price, f.times.length, f.setting, f.kids]).filter(Boolean).length; }
const anyFilter = (f) => f.when !== 'any' || f.cats.length || f.kw || f.price || f.times.length || f.setting || f.kids || !f.hideOngoing || Object.keys(f.extra).length;
function many(list, labelOf, empty) { return !list.length ? empty : list.length === 1 ? labelOf(list[0]) : `${labelOf(list[0])} +${list.length - 1}`; }
const timeLabel = (k) => (TIME_OPTS.find((o) => o[0] === k) || [, k])[1];
function pill(id, label, on, cls = '') {
  const open = state.open === id;
  return `<button type="button" class="fpill${on ? ' on' : ''}${open ? ' open' : ''}${cls ? ' ' + cls : ''}" data-pop="${id}" aria-haspopup="true" aria-expanded="${open}"><span class="pl">${esc(label)}</span>${chevron}</button>`;
}
function toggle(field, label, on, cls = '') {
  return `<button type="button" class="fpill tog${on ? ' on' : ''}${cls ? ' ' + cls : ''}" data-toggle="${field}" aria-pressed="${!!on}">${on ? tick : ''}${esc(label)}</button>`;
}
// One option row: a radio (single choice) or a checkbox (multi choice).
function mopt(attr, val, label, on, multi) {
  return `<button type="button" class="mopt" role="${multi ? 'menuitemcheckbox' : 'menuitemradio'}" aria-checked="${!!on}" data-${attr}="${esc(val)}"><span class="${multi ? 'cbox' : 'rbox'}">${on && multi ? tick : ''}</span>${esc(label)}</button>`;
}
function popBody(id) {
  const f = state.f;
  const cats = state.meta?.categories?.length ? state.meta.categories : CATS;
  const priceOpts = () => mopt('price', '', 'All prices', !f.price) + mopt('price', 'free', 'Free', f.price === 'free') + mopt('price', 'paid', 'Paid', f.price === 'paid');
  const timeOpts = () => mopt('time', '', 'All times', !f.times.length, true) + TIME_OPTS.map(([k, l]) => mopt('time', k, l, f.times.includes(k), true)).join('')
    + '<p class="fnote">Events without a start time are left out.</p>';
  const settingOpts = () => mopt('setting', '', 'Indoors and outdoors', !f.setting) + mopt('setting', 'indoor', 'Indoors', f.setting === 'indoor') + mopt('setting', 'outdoor', 'Outdoors', f.setting === 'outdoor');
  const foot = (clear) => `<div class="pfoot"><button type="button" class="linkish" data-clear="${clear}">Clear</button><button type="button" class="pdone" data-done>Done</button></div>`;
  // Each dropdown says what it filters, above its options ("All …" first).
  const head = (t) => `<div class="phead">${t}</div>`;
  if (id === 'when') {
    return head('When') + WHEN.map(([k, l]) => mopt('when', k, l, f.when === k)).join('')
      + (f.when === 'custom' ? `<div class="fdates"><input type="date" id="fd-from" aria-label="From" value="${esc(f.from)}"><span>to</span><input type="date" id="fd-to" aria-label="To" value="${esc(f.to)}"><button type="button" class="pdone" id="fd-apply">Apply</button></div>` : '');
  }
  if (id === 'what') return `${head('Event type')}${mopt('cat', '', 'All event types', !f.cats.length, true)}<div class="plist two">${cats.map((c) => mopt('cat', c, c, f.cats.includes(c), true)).join('')}</div>${foot('cats')}`;
  if (id === 'price') return head('Price') + priceOpts();
  if (id === 'time') return head('Time of day') + timeOpts() + foot('times');
  if (id === 'setting') return head('Setting') + settingOpts();
  if (id === 'ongoing') return head('Ongoing events') + mopt('ongoing', 'hide', 'Hide ongoing', f.hideOngoing) + mopt('ongoing', 'show', 'Show ongoing', !f.hideOngoing)
    + '<p class="fnote">Exhibitions and other events that run for weeks.</p>';
  const kids = mopt('toggle', 'kids', 'Kid-friendly only', f.kids, true);
  if (id === 'more' && desktop.matches) return head('More filters') + kids;
  if (id === 'more') return `${head('More filters')}<div class="pgroup"><div class="label">Price</div>${priceOpts()}</div>
    <div class="pgroup"><div class="label">Time of day</div>${timeOpts()}</div>
    <div class="pgroup"><div class="label">Setting</div>${settingOpts()}</div>
    <div class="pgroup"><div class="label">Who</div>${kids}</div>${foot('more')}`;
  return '';
}
function renderFinder() {
  const f = state.f;
  const whenL = f.when === 'custom' ? `${fmtDay(f.from)} – ${fmtDay(f.to)}` : WHEN.find(([k]) => k === f.when)[1];
  const n = moreCount(f);
  const more = pill('more', n ? `More · ${n}` : 'More', n > 0);
  $('#f-pills').innerHTML =
      pill('when', whenL, f.when !== 'any')
    + pill('what', many(f.cats, (c) => c, 'Event type'), f.cats.length > 0)
    + pill('price', f.price === 'free' ? 'Free' : f.price === 'paid' ? 'Paid' : 'Price', !!f.price, 'd-only')
    + pill('time', many(f.times, timeLabel, 'Time of day'), f.times.length > 0, 'd-only')
    + pill('setting', f.setting === 'indoor' ? 'Indoors' : f.setting === 'outdoor' ? 'Outdoors' : 'Setting', !!f.setting, 'd-only')
    + pill('ongoing', f.hideOngoing ? 'Hide ongoing' : 'Show ongoing', !f.hideOngoing)
    + (desktop.matches ? more : '');
  // Phones: More sits beside the keywords box, so When, Event type and Ongoing keep one line.
  $('#f-more-m').innerHTML = desktop.matches ? '' : more;
  const pop = $('#f-pop');
  const fopen = state.open && state.open !== 'city';
  pop.hidden = !fopen;
  if (fopen) {
    pop.dataset.pop = state.open;
    pop.innerHTML = popBody(state.open);
    // Desktop: the dropdown opens under its pill; phones: full width under the row (CSS).
    const p = [...document.querySelectorAll(`#finder [data-pop="${state.open}"]`)].find((x) => x.offsetParent);
    // Right under the pill that opened it.
    if (p) pop.style.top = `${p.offsetTop + p.offsetHeight + 6}px`;
    if (p && desktop.matches) {
      const max = $('#finder').clientWidth - pop.offsetWidth - 8;
      pop.style.left = `${Math.max(8, Math.min(p.offsetLeft, max))}px`;
    } else pop.style.left = '';
  }
  const kw = $('#kw');
  // Desktop has room for examples; phones just say "Keywords".
  const eg = { cdmx: 'jazz, Roma, Tamayo' }[state.city] || 'jazz, a venue, a neighborhood';
  kw.placeholder = desktop.matches ? `Keywords, e.g. ${eg}` : 'Keywords';
  if (document.activeElement !== kw) kw.value = f.kw;
  $('#kw-x').hidden = !kw.value;
  // Filters an old link set that the finder has no control for (a neighborhood, a vibe): removable chips.
  const ex = Object.entries(f.extra);
  $('#f-extra').innerHTML = ex.map(([k, v]) => `<span class="fchip">${esc(extraLabel(k, v))}<button type="button" data-unextra="${k}" aria-label="Remove">${xIcon.replace(/16/g, '10')}</button></span>`).join('');
  $('#f-extra').hidden = !ex.length;
}
const fmtDay = (d) => { try { return new Date(`${d}T12:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }); } catch { return d; } };
function extraLabel(k, v) {
  if (k === 'max_price') return `Under $${v}`;
  if (k === 'profile') return (state.meta?.profiles || []).find((p) => p.slug === v)?.name || v;
  if (Array.isArray(v)) return v.map((x) => String(x).replace(/_/g, ' ')).join(', ');
  return String(v).replace(/\b\p{L}/gu, (m) => m.toUpperCase());
}
function setF(patch, opts) {
  state.f = { ...state.f, ...patch };
  refresh(opts);
}

// One request at a time wins: a newer tap makes older answers irrelevant.
let seq = 0;
async function refresh({ push = true, legacyQ = null } = {}) {
  if (!legacyQ) {
    const url = toURL(state.f);
    if (url !== location.pathname + location.search) (push ? history.pushState : history.replaceState).call(history, {}, '', url);
  }
  renderFinder();
  const my = ++seq;
  const list = $('#result-list');
  list.classList.add('dim');
  state.selected = null; state.ongoingOpen = false;
  let stop = null;
  // A tiger loader only when the answer is slow (or on the very first load); quick answers just swap in.
  const lt = setTimeout(() => { if (my === seq) stop = startLoader(); }, state.data ? 700 : 0);
  try {
    const body = legacyQ
      ? { q: legacyQ, parse: 'keywords', city: state.city, test: TEST }
      : { browse: true, filters: requestFilters(state.f), city: state.city, test: TEST };
    const d = await api('/api/search', body);
    if (my !== seq) return;
    state.data = d;
    if (legacyQ) {
      state.f = fromServer(d.filters, d);
      history.replaceState({}, '', toURL(state.f));
      renderFinder();
    }
    clearTimeout(lt); if (stop) stop();
    renderResults();
  } catch (e) {
    if (my !== seq) return;
    clearTimeout(lt); if (stop) stop();
    list.innerHTML = `<div class="empty"><p>${esc(e.message)}</p><button class="toggle" type="button" id="retry">Try again</button></div>`;
  } finally {
    if (my === seq) list.classList.remove('dim');
  }
}

// ---------------------------------------------------------------- tiger animations
const ANIM_MS = { claws: 700, tilt: 720, wink: 640, snap: 620, tail: 980 };
const animReady = {
  claws: true, tilt: true,
  wink: () => imgOk('#tiger-wink'), snap: () => imgOk('#tiger-snap'), tail: () => imgOk('#tiger-tail'),
};
function imgOk(sel) { const i = $(sel); return !!(i && i.complete && i.naturalWidth > 0); }
let lastAnim = null;
function playSearchAnimation() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return Promise.resolve();
  const names = (C.animations || ['claws', 'tilt']).filter((n) => {
    const r = animReady[n];
    return typeof r === 'function' ? r() : !!r;
  });
  if (!names.length) return Promise.resolve();
  const pool = names.length > 1 ? names.filter((n) => n !== lastAnim) : names;
  const name = pool[Math.floor(Math.random() * pool.length)];
  lastAnim = name;
  const wrap = $('.home-bar');
  ['wink', 'snap', 'tail'].forEach((n) => { const el = $(`#tiger-${n}`); if (el) el.hidden = n !== name; });
  wrap.className = wrap.className.replace(/\bplay-\w+/g, '').trim();
  void wrap.offsetWidth; // restart the animation
  wrap.classList.add(`play-${name}`);
  return new Promise((res) => setTimeout(() => { wrap.classList.remove(`play-${name}`); res(); }, ANIM_MS[name]));
}

// ---------------------------------------------------------------- loading state
// A random tiger loader (Pondering / Researching / Eye of the Tiger) cycles its frames until results arrive.
// It fades in after a short delay, so fast responses don't flash it.
let lastLoader = null;
const loaderSrc = (f) => `/assets/loaders/${f}.webp`;
function preloadLoaders() {
  (C.loaders || []).forEach((l) => l.frames.forEach(([f]) => { const i = new Image(); i.src = loaderSrc(f); }));
}
function startLoader() {
  const list = C.loaders || [];
  if (!list.length) return () => {};
  const pool = list.length > 1 ? list.filter((l) => l !== lastLoader) : list;
  const l = pool[Math.floor(Math.random() * pool.length)];
  lastLoader = l;
  $('#result-list').innerHTML = `
    <div class="loader" role="status" aria-label="${esc(l.label)}">
      <p class="loader-word">${esc(l.label)}<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span></p>
      <div class="loader-art">${l.frames.map(([f], i) => `<img src="${loaderSrc(f)}" alt="" width="440" height="440"${i ? ' hidden' : ''}>`).join('')}</div>
    </div>`;
  const imgs = [...$('#result-list').querySelectorAll('.loader-art img')];
  let i = 0, timer = null;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const tick = () => {
    timer = setTimeout(() => {
      imgs[i].hidden = true;
      i = (i + 1) % imgs.length;
      imgs[i].hidden = false;
      tick();
    }, l.frames[i][1]);
  };
  if (!still && imgs.length > 1) tick();
  return () => clearTimeout(timer);
}
function renderResults() {
  const d = state.data;
  const list = [...d.results, ...(d.more || [])];
  const f = state.f;
  const anySet = anyFilter(f);
  if (!list.length) {
    $('#result-list').innerHTML = `<div class="empty"><img src="/assets/tiger-avatar.webp" alt="" width="140" height="140">
      <p>Nothing matches all of these yet. Try another day or fewer filters.</p>
      ${anySet ? '<button class="toggle" type="button" id="clear-all">Clear all filters</button>' : ''}</div>`;
    return;
  }
  const ongoing = list.filter((e) => e.ongoing);
  const dated = list.filter((e) => !e.ongoing).sort((a, b) => a.starts_at.localeCompare(b.starts_at));
  const days = [];
  for (const e of dated) {
    const k = dayKey(e);
    if (!days.length || days[days.length - 1].k !== k) days.push({ k, items: [] });
    days[days.length - 1].items.push(e);
  }
  const shownOngoing = state.ongoingOpen ? ongoing : ongoing.slice(0, 4);
  let html = `<div class="count"><span><b>${list.length}</b> event${list.length === 1 ? '' : 's'}</span>${anySet ? '<button class="linkish" type="button" id="clear-all">Clear filters</button>' : ''}</div>`;
  // The keyword matched nothing: it was dropped, everything else still applies.
  if (d.relaxed && f.kw) html += `<p class="note">No events mention “${esc(f.kw)}” with these filters, so here's everything else that fits.</p>`;
  // Dated events first, by day; long-running exhibitions after them, unless they're all there is.
  for (const day of days) html += section(dayLabel(day.items[0]), day.items, '');
  if (ongoing.length) {
    html += section(days.length ? 'Also on' : 'Ongoing', shownOngoing, '');
    if (ongoing.length > 4 && !state.ongoingOpen) html += `<button class="toggle" type="button" id="ongoing-more">Show ${ongoing.length - 4} more ongoing</button>`;
  }
  if (d.updated_at) html += `<p class="foot">Events updated ${esc(fmt(d.updated_at, d.timezone, { day: 'numeric', month: 'short' }))}.</p>`;
  $('#result-list').innerHTML = html;
  const first = dated[0] || ongoing[0];
  if (desktop.matches && first) openDetail(state.selected && findEvent(state.selected) ? state.selected : first.key, { quiet: true });
}
// ["kid-friendly", "outdoors"] → "kid-friendly or outdoors"
function listWords(a) {
  return a.length < 2 ? (a[0] ? `matched ${a[0]}` : '') : `matched ${a.slice(0, -1).join(', ')} or ${a[a.length - 1]}`;
}
function section(title, items, note) {
  return `<section class="section"><h2>${esc(title)}${note ? `<span>${esc(note)}</span>` : ''}</h2>${items.map(row).join('')}</section>`;
}
function row(e) {
  const saved = state.saved.has(e.key);
  const kind = e.kind === 'opening' ? '<span class="kind">Opening</span>' : e.kind === 'closing' ? '<span class="kind">Closing</span>' : '';
  return `<div class="row${state.selected === e.key ? ' sel' : ''}" data-row="${esc(e.key)}">
    <div class="when">${esc(whenCol(e))}</div>
    <button class="open" type="button" data-open="${esc(e.key)}">
      <div class="t">${kind}${esc(e.title)}</div>
      <div class="m">${esc(metaLine(e))}</div>
      ${e.category ? `<div class="c">${esc(e.category)}</div>` : ''}
    </button>
    <div class="c c-col">${esc(e.category || '')}</div>
    ${addButton(e.key, saved)}
  </div>`;
}
function addButton(key, saved) {
  const busy = state.busy.has(key);
  return `<button class="add${saved ? ' on' : ''}${busy ? ' busy' : ''}" type="button" data-add="${esc(key)}" aria-label="${saved ? 'In your calendar' : 'Add to my calendar'}">${saved ? check : plus}</button>`;
}

// ---------------------------------------------------------------- details
function detailHtml(e) {
  const saved = state.saved.has(e.key);
  const p = price(e, true);
  const where = [e.venue, e.address || e.neighborhood].filter(Boolean);
  return `<div class="detail">
    <div class="grab"></div>
    <div class="dhead"><span class="label">${esc([e.category, p === 'Free' ? 'Free' : null].filter(Boolean).join(' · '))}</span>
      <button class="x" type="button" data-close aria-label="Close">${xIcon}</button></div>
    <h1>${esc(e.title)}</h1>
    ${e.title_original ? `<p class="orig" lang="es">${esc(e.title_original)}</p>` : ''}
    ${e.description ? `<p class="desc">${esc(e.description)}</p>` : ''}
    <dl>
      <dt>When</dt><dd class="mono">${esc(whenLong(e))}</dd>
      ${where.length ? `<dt>Where</dt><dd>${esc(where[0])}${where[1] ? `<br><span style="color:var(--muted)">${esc(where[1])}</span>` : ''}</dd>` : ''}
      ${p ? `<dt>Price</dt><dd>${esc(p)}</dd>` : ''}
      ${e.url && host(e.url) ? `<dt>Listing</dt><dd><a href="${esc(e.url)}" target="_blank" rel="noopener" data-link="${esc(e.key)}">${esc(host(e.url))} ↗</a></dd>` : ''}
    </dl>
    <div class="spacer"></div>
    <div class="actions">
      <button class="primary${saved ? ' on' : ''}" type="button" data-add="${esc(e.key)}">${saved ? check + ' In your calendar' : plus + ' Add to my calendar'}</button>
      ${e.url ? `<a class="secondary" href="${esc(e.url)}" target="_blank" rel="noopener" data-link="${esc(e.key)}">Open listing ↗</a>` : ''}
    </div>
  </div>`;
}
function setPane(on) {
  $('#layout').classList.toggle('with-pane', on);
  $('#pane').hidden = !on;
}
function openDetail(key, { quiet } = {}) {
  const e = findEvent(key);
  if (!e) return;
  state.selected = key;
  document.querySelectorAll('.row.sel').forEach((r) => r.classList.remove('sel'));
  document.querySelector(`.row[data-row="${CSS.escape(key)}"]`)?.classList.add('sel');
  if (!quiet) logAction('open', key);
  if (desktop.matches) {
    $('#pane').innerHTML = detailHtml(e);
    setPane(true);
  } else {
    const d = $('#sheet');
    d.innerHTML = detailHtml(e);
    if (!d.open) d.showModal();
  }
}
function refreshEvent(key) {
  const e = findEvent(key);
  document.querySelectorAll(`[data-add="${CSS.escape(key)}"].add`).forEach((b) => { b.outerHTML = addButton(key, state.saved.has(key)); });
  if (state.selected === key && e) {
    if ($('#sheet').open) $('#sheet').innerHTML = detailHtml(e);
    if (!$('#pane').hidden) $('#pane').innerHTML = detailHtml(e);
  }
}

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(html, ms = 5000) {
  const t = $('#toast');
  t.innerHTML = html;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------------------------------------------------------------- accounts + saving
let sb = null;
async function supa() {
  if (sb) return sb;
  const { createClient } = await import('https://esm.sh/@supabase/supabase-js@2.112.0');
  sb = createClient(C.eventrrrUrl, C.eventrrrAnonKey, { auth: { persistSession: true, detectSessionInUrl: true, flowType: 'pkce', storageKey: 'eventrrr-search-auth' } });
  sb.auth.onAuthStateChange((_ev, session) => setUser(session?.user || null));
  return sb;
}
async function initAuth() {
  const hasSession = Object.keys(localStorage).some((k) => k.startsWith('eventrrr-search-auth')) || /[?&]code=/.test(location.search);
  if (!hasSession) return;
  const s = await supa();
  const { data } = await s.auth.getSession();
  setUser(data.session?.user || null);
}
async function setUser(user) {
  const changed = (user?.id || null) !== (state.user?.id || null);
  state.user = user;
  $('#signin-btn').hidden = !!user;
  const av = $('#avatar-btn');
  av.hidden = !user;
  if (user) av.textContent = (user.user_metadata?.full_name || user.email || '?').trim().slice(0, 2).toUpperCase();
  if (!user || !changed) return;
  if ($('#signin').open) $('#signin').close();
  if (C.savingEnabled) {
    try {
      const { data } = await sb.rpc('my_search_keys');
      state.saved = new Set(data || []);
      document.querySelectorAll('[data-add]').forEach((b) => refreshEvent(b.dataset.add));
    } catch { /* not critical */ }
  }
  const pending = sessionStorage.getItem('search.pendingAdd');
  if (pending) {
    sessionStorage.removeItem('search.pendingAdd');
    try { const e = JSON.parse(pending); if (!state.saved.has(e.key)) await save(e); } catch { /* ignore */ }
  }
}
const auth = { mode: 'signin', method: 'password', event: null };
const googleG = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.6l6.8-6.8C35.8 2.4 30.3 0 24 0 14.6 0 6.6 5.4 2.7 13.3l7.9 6.1C12.5 13.6 17.8 9.5 24 9.5z"/><path fill="#4285F4" d="M46.1 24.5c0-1.6-.1-3.1-.4-4.5H24v9h12.4c-.5 2.9-2.2 5.3-4.6 6.9l7.3 5.7c4.3-3.9 7-9.8 7-17.1z"/><path fill="#FBBC05" d="M10.6 28.6c-.5-1.4-.8-3-.8-4.6s.3-3.2.8-4.6l-7.9-6.1C1 16.6 0 20.2 0 24s1 7.4 2.7 10.7l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.5 0 11.9-2.1 15.9-5.8l-7.3-5.7c-2 1.4-4.7 2.3-8.6 2.3-6.2 0-11.5-4.1-13.4-9.8l-7.9 6.1C6.6 42.6 14.6 48 24 48z"/></svg>';
function openSignin(e) {
  auth.event = e && e.key ? e : null;
  auth.mode = 'signin'; auth.method = 'password';
  if (auth.event) sessionStorage.setItem('search.pendingAdd', JSON.stringify(auth.event));
  else sessionStorage.removeItem('search.pendingAdd');
  renderAuth();
  const d = $('#signin');
  if (!d.open) d.showModal();
}
function renderAuth() {
  const create = auth.mode === 'create';
  const link = auth.method === 'link';
  const what = auth.event ? `<b>${esc(auth.event.title)}</b>` : 'anything you find here';
  $('#signin').innerHTML = `<div class="auth">
    <img class="auth-tiger" src="/assets/tiger-lounging-lens.webp" alt="" width="600" height="254">
    <button class="auth-x" type="button" data-close aria-label="Close">${xIcon}</button>
    <h1>${create ? 'Create your calendar' : 'Sign in to save'}</h1>
    <p class="auth-sub">${create ? `Get your free Eventrrr account and save ${what} to it.` : `Save ${what} to your Eventrrr calendar. Searching stays free without an account.`}</p>
    <button class="google" type="button" id="google">${googleG}Continue with Google</button>
    <div class="or">or</div>
    <div class="seg" role="tablist" aria-label="Sign-in method">
      <button type="button" role="tab" data-method="password" aria-selected="${!link}">Password</button>
      <button type="button" role="tab" data-method="link" aria-selected="${link}">Email me a link</button>
    </div>
    <form id="auth-form" novalidate>
      <label for="au-em">Email</label>
      <input id="au-em" type="email" autocomplete="email" placeholder="you@example.com" required>
      ${link ? '' : `<label for="au-pw">Password</label>
      <input id="au-pw" type="password" autocomplete="${create ? 'new-password' : 'current-password'}" placeholder="${create ? 'At least 8 characters' : 'Your password'}" minlength="${create ? 8 : 1}" required>`}
      <button class="cta" type="submit">${link ? 'Email me a link' : create ? 'Create account' : 'Sign in'}</button>
      <p class="err" id="au-err" hidden></p>
      <p class="ok" id="au-ok" hidden></p>
    </form>
    ${create ? `<p class="auth-terms">By creating an account, you agree to Eventrrr's <a href="${esc(C.eventrrrApp)}/terms" target="_blank" rel="noopener">Terms</a> and <a href="${esc(C.eventrrrApp)}/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</p>` : ''}
    <p class="auth-switch">${create ? 'Already have an account?' : 'New to Eventrrr?'} <button type="button" data-authswitch>${create ? 'Sign in' : 'Create an account'}</button></p>
  </div>`;
}
async function submitAuth() {
  const em = $('#au-em').value.trim();
  const pw = $('#au-pw') ? $('#au-pw').value : '';
  const err = $('#au-err'), ok = $('#au-ok'), btn = $('#auth-form .cta');
  err.hidden = true; ok.hidden = true;
  if (!/^\S+@\S+\.\S+$/.test(em)) { err.textContent = 'Enter your email address.'; err.hidden = false; return; }
  if (auth.method === 'password' && auth.mode === 'create' && pw.length < 8) { err.textContent = 'Use at least 8 characters.'; err.hidden = false; return; }
  btn.disabled = true;
  try {
    const s = await supa();
    const redirect = location.href;
    let res;
    if (auth.method === 'link') {
      res = await s.auth.signInWithOtp({ email: em, options: { emailRedirectTo: redirect, shouldCreateUser: auth.mode === 'create' } });
      if (!res.error) { ok.textContent = `Check ${em} for your sign-in link.`; ok.hidden = false; }
    } else if (auth.mode === 'create') {
      res = await s.auth.signUp({ email: em, password: pw, options: { emailRedirectTo: redirect } });
      if (!res.error && !res.data.session) { ok.textContent = `Almost there: confirm your account from the email we sent to ${em}.`; ok.hidden = false; }
    } else {
      res = await s.auth.signInWithPassword({ email: em, password: pw });
    }
    if (res.error) { err.textContent = res.error.message; err.hidden = false; }
  } finally { btn.disabled = false; }
}
async function save(e) {
  if (state.busy.has(e.key)) return;
  state.busy.add(e.key); refreshEvent(e.key);
  try {
    const s = await supa();
    const { data, error } = await s.rpc('add_from_search', { payload: {
      scout_key: e.key, title: e.title, description: e.description, starts_at: e.starts_at, ends_at: e.ends_at,
      all_day: e.all_day, timezone: e.timezone, venue: e.venue, address: e.address, neighborhood: e.neighborhood,
      price_text: e.price_text, price_min: e.price_min, currency: e.currency, url: e.url, category: e.category,
    } });
    if (error) throw error;
    state.saved.add(e.key);
    logAction('add', e.key);
    toast(`<span>${data?.status === 'exists' ? 'Already in your calendar' : 'Added to your calendar'}</span><a href="${esc(C.eventrrrApp)}" target="_blank" rel="noopener">Open Eventrrr</a>`);
  } catch (err) {
    toast(`<span>Couldn't save that one. ${esc(err.message || '')}</span>`, 7000);
  } finally {
    state.busy.delete(e.key); refreshEvent(e.key);
  }
}
async function onAdd(key) {
  const e = findEvent(key);
  if (!e) return;
  if (state.saved.has(key)) { toast(`<span>Already in your calendar</span><a href="${esc(C.eventrrrApp)}" target="_blank" rel="noopener">Open Eventrrr</a>`); return; }
  if (!C.savingEnabled) { toast('<span>Saving to Eventrrr opens very soon. For now, open the listing.</span>'); return; }
  if (!state.user) { if ($('#sheet').open) $('#sheet').close(); openSignin(e); return; }
  await save(e);
}

// ---------------------------------------------------------------- events
document.addEventListener('click', async (ev) => {
  if (state.open && !ev.target.closest('#f-pop, [data-pop], #city-pop, #city-btn')) { state.open = null; renderFinder(); renderCity(); }
  const t = ev.target.closest('button, a');
  if (!t) return;
  if (t.dataset.open) { openDetail(t.dataset.open); return; }
  if (t.dataset.add) { onAdd(t.dataset.add); return; }
  if (t.dataset.link) { logAction('link', t.dataset.link); return; }
  // finder
  if (t.id === 'city-btn') { state.open = state.open === 'city' ? null : 'city'; renderCity(); renderFinder(); return; }
  if (t.dataset.city) { setCity(t.dataset.city); return; }
  if (t.dataset.pop) { state.open = state.open === t.dataset.pop ? null : t.dataset.pop; renderFinder(); renderCity(); return; }
  if (t.hasAttribute('data-done')) { state.open = null; renderFinder(); return; }
  if (t.dataset.clear) {
    const c = t.dataset.clear;
    setF(c === 'cats' ? { cats: [] } : c === 'times' ? { times: [] } : desktop.matches ? { kids: false } : { price: '', times: [], setting: '', kids: false }); return;
  }
  if (t.dataset.when !== undefined) {
    if (t.dataset.when === 'custom') {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: state.data?.timezone || 'America/Mexico_City' });
      state.f = { ...state.f, when: 'custom', from: state.f.from || today, to: state.f.to || today };
      renderFinder(); $('#fd-from').focus(); return;
    }
    state.open = null;
    setF({ when: t.dataset.when, from: '', to: '' }); return;
  }
  if (t.dataset.cat !== undefined) {
    const c = t.dataset.cat, cats = state.f.cats;
    setF({ cats: !c ? [] : cats.includes(c) ? cats.filter((x) => x !== c) : [...cats, c] }); return;
  }
  if (t.dataset.price !== undefined) { if (state.open !== 'more') state.open = null; setF({ price: t.dataset.price }); return; }
  if (t.dataset.setting !== undefined) { if (state.open !== 'more') state.open = null; setF({ setting: t.dataset.setting }); return; }
  if (t.dataset.time !== undefined) {
    const k = t.dataset.time, ts = state.f.times;
    setF({ times: !k ? [] : ts.includes(k) ? ts.filter((x) => x !== k) : [...ts, k] }); return;
  }
  if (t.dataset.ongoing) { state.open = null; setF({ hideOngoing: t.dataset.ongoing === 'hide' }); return; }
  if (t.dataset.toggle) { setF({ [t.dataset.toggle]: !state.f[t.dataset.toggle] }); return; }
  if (t.dataset.unextra) { const ex = { ...state.f.extra }; delete ex[t.dataset.unextra]; setF({ extra: ex }); return; }
  if (t.id === 'fd-apply') {
    const a = $('#fd-from').value, b = $('#fd-to').value;
    if (a && b) { state.open = null; setF({ when: 'custom', from: a <= b ? a : b, to: a <= b ? b : a }); }
    return;
  }
  if (t.id === 'kw-x') { $('#kw').value = ''; if (state.f.kw) setF({ kw: '' }); else renderFinder(); return; }
  if (t.id === 'clear-all') { state.f = blank(); state.open = null; refresh(); return; }
  if (t.id === 'retry') { refresh({ push: false }); return; }
  if (t.hasAttribute('data-close')) { t.closest('dialog')?.close(); if (!t.closest('dialog')) setPane(false); return; }
  if (t.id === 'ongoing-more') { state.ongoingOpen = true; renderResults(); return; }
  if (t.id === 'signin-btn') { openSignin(null); return; }
  if (t.id === 'avatar-btn') {
    toast(`<span>${esc(state.user?.email || '')}</span><a href="#" id="signout">Sign out</a>`, 6000);
    return;
  }
  if (t.id === 'signout') { ev.preventDefault(); await (await supa()).auth.signOut(); state.saved.clear(); setUser(null); $('#toast').hidden = true; return; }
  if (t.id === 'google') {
    const s = await supa();
    await s.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.href } });
    return;
  }
  if (t.dataset.method) { auth.method = t.dataset.method; const em = $('#au-em')?.value; renderAuth(); if (em) $('#au-em').value = em; return; }
  if (t.hasAttribute('data-authswitch')) { auth.mode = auth.mode === 'create' ? 'signin' : 'create'; const em = $('#au-em')?.value; renderAuth(); if (em) $('#au-em').value = em; return; }
});
document.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const f = ev.target;
  if (f.id === 'kw-form') {
    clearTimeout(kwTimer);
    const kw = $('#kw').value.trim().slice(0, 60);
    $('#kw').blur();
    playSearchAnimation();
    if (kw !== state.f.kw) setF({ kw });
  } else if (f.id === 'auth-form') {
    submitAuth();
  }
});
// Typing pauses count as a search too (no need to press Enter).
let kwTimer;
$('#kw').addEventListener('input', () => {
  $('#kw-x').hidden = !$('#kw').value;
  clearTimeout(kwTimer);
  kwTimer = setTimeout(() => { const kw = $('#kw').value.trim().slice(0, 60); if (kw !== state.f.kw) setF({ kw }, { push: false }); }, 800);
});
$('#sheet').addEventListener('close', () => { if (!desktop.matches) state.selected = null; });
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); }));
window.addEventListener('popstate', route);
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && state.open) { state.open = null; renderFinder(); renderCity(); } });
desktop.addEventListener('change', () => { renderFinder(); if (state.data) renderResults(); });

function route() {
  const p = new URLSearchParams(location.search);
  const q = p.get('q');
  if (q) refresh({ legacyQ: q.slice(0, 300) });
  else { state.f = fromURL(); refresh({ push: false }); }
}

initHome();
(window.requestIdleCallback || setTimeout)(preloadLoaders);
initAuth();
route();
