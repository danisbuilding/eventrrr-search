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
function logAction(action, key) {
  const qid = state.data && state.data.query_id;
  try { navigator.sendBeacon('/api/log', new Blob([JSON.stringify({ query_id: qid, action, event_key: key })], { type: 'application/json' })); } catch { /* ignore */ }
}
const findEvent = (key) => [...(state.data?.results || []), ...(state.data?.more || []), ...state.picks].find((e) => e.key === key);

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
function price(e) {
  if (e.is_free || e.price_min === 0) return 'Free';
  if (e.price_text) return e.price_text;
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

// ---------------------------------------------------------------- home
async function initHome() {
  // Picks, headline and meta load in parallel; picks don't wait on the others.
  if (!state.city) state.city = 'cdmx';
  const picks = loadPicks();
  $('#suggestions').innerHTML = (C.suggestions || []).map((s) => `<a class="chip" href="?q=${encodeURIComponent(s)}">${esc(s)}</a>`).join('');
  const headline = fetch('/config/headlines.json').then((r) => r.json()).then((h) => {
    const list = (h.headlines || []).filter(Boolean);
    $('#headline').textContent = list.length ? list[Math.floor(Math.random() * list.length)] : 'What are you in the mood for?';
  }).catch(() => { $('#headline').textContent = 'What are you in the mood for?'; });
  const meta = api('/api/meta').then((m) => {
    state.meta = m;
    const cities = m.cities || [];
    const before = state.city;
    if (!cities.find((c) => c.slug === state.city)) state.city = cities[0]?.slug || 'cdmx';
    renderCity();
    if (state.city !== before) loadPicks();
  }).catch(() => { /* meta is optional */ });
  await Promise.all([picks, headline, meta]);
}
function renderCity() {
  const cities = state.meta?.cities || [];
  const cur = cities.find((c) => c.slug === state.city);
  $('#city-name').textContent = cur ? cur.name : 'Mexico City';
  const btn = $('#city-btn');
  btn.onclick = cities.length > 1 ? () => {
    const i = cities.findIndex((c) => c.slug === state.city);
    state.city = cities[(i + 1) % cities.length].slug;
    localStorage.setItem('search.city', state.city);
    renderCity(); loadPicks();
  } : null;
  btn.title = cities.length > 1 ? 'Change city' : '';
}
async function loadPicks() {
  const box = $('#picks');
  box.innerHTML = '<div class="skel"></div><div class="skel"></div><div class="skel"></div>';
  try {
    const r = await api('/api/search', { filters: { to: null }, city: state.city });
    state.picks = (r.results || []).filter((e) => !e.ongoing).slice(0, 3);
    if (state.picks.length < 3) state.picks.push(...(r.results || []).filter((e) => e.ongoing).slice(0, 3 - state.picks.length));
    box.innerHTML = state.picks.map((e) => `
      <button class="pick" type="button" data-open="${esc(e.key)}">
        <span class="when">${esc(fmt(e.starts_at, e.timezone, { weekday: 'short', day: 'numeric' }).toUpperCase())}\n${esc(whenCol(e).replace('\n', ' '))}</span>
        <span><span class="t" style="display:block">${esc(e.title)}</span><span class="m" style="display:block">${esc(metaLine(e))}</span></span>
        <svg class="chev" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg>
      </button>`).join('') || '<p class="foot">Fresh picks are on their way.</p>';
  } catch { box.innerHTML = '<p class="foot">Picks will be back in a moment.</p>'; }
}

// ---------------------------------------------------------------- search
function go(q, { push = true } = {}) {
  const url = new URL(location.href);
  url.search = q ? `?q=${encodeURIComponent(q)}` : '?all=1';
  if (push) history.pushState({}, '', url); else history.replaceState({}, '', url);
  route();
}
// Start the request while the tiger animates, so the animation costs no extra wait.
let pending = null;
function prefetch(q) {
  pending = { q, city: state.city, promise: api('/api/search', { q, city: state.city }) };
  pending.promise.catch(() => {});
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

async function runSearch({ q, filters }) {
  $('#home').hidden = true;
  $('#results').hidden = false;
  $('#q-results').value = q || '';
  state.showMore = false; state.ongoingOpen = false; state.selected = null;
  $('#searching').innerHTML = '';
  setPane(false);
  window.scrollTo(0, 0);
  const stopLoader = startLoader();
  try {
    const pre = !filters && pending && pending.q === q && pending.city === state.city ? pending.promise : null;
    pending = null;
    state.data = await (pre || api('/api/search', { q, filters, city: state.city }));
    stopLoader();
    renderResults();
  } catch (e) {
    stopLoader();
    $('#result-list').innerHTML = `<div class="empty"><p>${esc(e.message)}</p><button class="toggle" type="button" id="retry">Try again</button></div>`;
    $('#retry').onclick = () => runSearch({ q, filters });
  }
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
function removeChip(field, value) {
  const f = { ...state.data.filters };
  if (field === 'when') { f.from = null; f.to = null; }
  else if (field === 'category') f.categories = (f.categories || []).filter((c) => c !== value);
  else if (field === 'free') f.free = false;
  else f[field] = null;
  runSearch({ q: $('#q-results').value, filters: f });
}

function renderResults() {
  const d = state.data;
  const chips = d.chips || [];
  $('#searching').innerHTML = chips.length ? `
    <div class="label">Searching for</div>
    <div class="filters">${chips.map((c, i) => c.fixed
      ? `<span class="fchip fixed">${esc(c.label)}</span>`
      : `<span class="fchip">${esc(c.label)}<button type="button" data-chip="${i}" aria-label="Remove ${esc(c.label)}">${xIcon.replace('16', '10').replace('16', '10')}</button></span>`).join('')}
    </div>` : '';
  const list = state.showMore ? [...d.results, ...d.more] : d.results;
  if (!list.length) {
    $('#result-list').innerHTML = `<div class="empty"><img src="/assets/tiger-avatar.webp" alt="" width="140" height="140"><p>Nothing found for that yet. Try fewer words, another day, or remove a filter above.</p></div>`;
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
  let html = `<div class="count"><span><b>${list.length}</b> event${list.length === 1 ? '' : 's'}</span></div>`;
  if (d.relaxed) html += `<p class="note">Nothing matched those words exactly, so here's everything else for those dates.</p>`;
  if (d.expanded) html += `<p class="note">Not much has been picked for this yet, so here's everything we found.</p>`;
  if (ongoing.length) {
    html += section('Ongoing', shownOngoing, '');
    if (ongoing.length > 4 && !state.ongoingOpen) html += `<button class="toggle" type="button" id="ongoing-more">Show ${ongoing.length - 4} more ongoing</button>`;
  }
  for (const day of days) html += section(dayLabel(day.items[0]), day.items, '');
  if (!state.showMore && d.more.length) html += `<button class="more-btn" type="button" id="more-btn">Show ${d.more.length} more</button>`;
  html += `<p class="foot">Not quite it? Try “cheaper”, “closer to Roma” or “just Sunday”.${d.updated_at ? `<br>Events updated ${esc(fmt(d.updated_at, d.timezone, { day: 'numeric', month: 'short' }))}.` : ''}</p>`;
  $('#result-list').innerHTML = html;
  if (desktop.matches && list.length) openDetail(state.selected && findEvent(state.selected) ? state.selected : list[0].key, { quiet: true });
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
  const p = price(e);
  const where = [e.venue, e.address || e.neighborhood].filter(Boolean);
  return `<div class="detail">
    <div class="grab"></div>
    <div class="dhead"><span class="label">${esc([e.category, p === 'Free' ? 'Free' : null].filter(Boolean).join(' · '))}</span>
      <button class="x" type="button" data-close aria-label="Close">${xIcon}</button></div>
    <h1>${esc(e.title)}</h1>
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
  if (desktop.matches && !$('#results').hidden) {
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
  const t = ev.target.closest('button, a');
  if (!t) return;
  if (t.dataset.open) { openDetail(t.dataset.open); return; }
  if (t.dataset.add) { onAdd(t.dataset.add); return; }
  if (t.dataset.link) { logAction('link', t.dataset.link); return; }
  if (t.dataset.chip) { const c = state.data.chips[+t.dataset.chip]; removeChip(c.field, c.value); return; }
  if (t.hasAttribute('data-close')) { t.closest('dialog')?.close(); if (!t.closest('dialog')) setPane(false); return; }
  if (t.id === 'more-btn') { state.showMore = true; logAction('more', null); renderResults(); return; }
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
  if (f.id === 'home-form' || f.id === 'results-form') {
    const q = f.q.value.trim();
    if (!q) return;
    f.q.blur();
    prefetch(q);
    if (f.id === 'home-form') await playSearchAnimation();
    else { const a = $('.bar-avatar'); a.classList.remove('nudge'); void a.offsetWidth; a.classList.add('nudge'); }
    go(q);
  } else if (f.id === 'auth-form') {
    submitAuth();
  }
});
$('#clear-btn').addEventListener('click', () => { $('#q-results').value = ''; $('#q-results').focus(); });
$('#sheet').addEventListener('close', () => { if (!desktop.matches) state.selected = null; });
document.querySelectorAll('dialog').forEach((d) => d.addEventListener('click', (ev) => { if (ev.target === d) d.close(); }));
window.addEventListener('popstate', route);
desktop.addEventListener('change', () => { if (state.data && !$('#results').hidden) renderResults(); });

function route() {
  const p = new URLSearchParams(location.search);
  const q = p.get('q');
  if (q) runSearch({ q });
  else if (p.get('all')) runSearch({ q: '', filters: { to: null } });
  else {
    $('#results').hidden = true;
    $('#home').hidden = false;
    setPane(false);
  }
}

initHome();
(window.requestIdleCallback || setTimeout)(preloadLoaders);
initAuth();
route();
