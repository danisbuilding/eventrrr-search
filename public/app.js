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
  try {
    const h = await fetch('/config/headlines.json').then((r) => r.json());
    const list = (h.headlines || []).filter(Boolean);
    $('#headline').textContent = list.length ? list[Math.floor(Math.random() * list.length)] : 'What are you in the mood for?';
  } catch { $('#headline').textContent = 'What are you in the mood for?'; }
  $('#suggestions').innerHTML = (C.suggestions || []).map((s) => `<a class="chip" href="?q=${encodeURIComponent(s)}">${esc(s)}</a>`).join('');
  try {
    state.meta = await api('/api/meta');
    const cities = state.meta.cities || [];
    if (!state.city || !cities.find((c) => c.slug === state.city)) state.city = cities[0]?.slug || 'cdmx';
    renderCity();
  } catch { /* meta is optional */ }
  loadPicks();
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
  $('#result-list').innerHTML = '<div class="skel"></div>'.repeat(6);
  setPane(false);
  window.scrollTo(0, 0);
  try {
    const pre = !filters && pending && pending.q === q && pending.city === state.city ? pending.promise : null;
    pending = null;
    state.data = await (pre || api('/api/search', { q, filters, city: state.city }));
    renderResults();
  } catch (e) {
    $('#result-list').innerHTML = `<div class="empty"><p>${esc(e.message)}</p><button class="toggle" type="button" id="retry">Try again</button></div>`;
    $('#retry').onclick = () => runSearch({ q, filters });
  }
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
function openSignin(e) {
  const d = $('#signin');
  d.innerHTML = `<div class="signin-body">
    <img class="signin-tiger" src="/assets/tiger-lounging.webp" alt="" width="400" height="347">
    <h1>Save it to your calendar</h1>
    <p>Sign in with your Eventrrr account to drop <b style="color:var(--ink);font-weight:500">${esc(e.title)}</b> straight into your calendar. Searching stays free without an account.</p>
    <div class="actions" id="signin-actions">
      <button class="dark" type="button" id="google">Continue with Google</button>
      <button class="secondary" type="button" id="email-toggle">Use email instead</button>
      <button class="link" type="button" data-close>Keep browsing</button>
    </div>
  </div>`;
  sessionStorage.setItem('search.pendingAdd', JSON.stringify(e));
  d.showModal();
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
  if (t.id === 'signin-btn') { openSignin({ key: '', title: 'anything you find' }); sessionStorage.removeItem('search.pendingAdd'); return; }
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
  if (t.id === 'email-toggle') {
    $('#signin-actions').innerHTML = `<form class="email-form" id="email-form">
        <label class="sr" for="em">Email</label><input id="em" type="email" autocomplete="email" placeholder="Email" required>
        <label class="sr" for="pw">Password</label><input id="pw" type="password" autocomplete="current-password" placeholder="Password" required>
        <button class="dark" type="submit">Sign in</button>
        <p class="err" id="em-err" hidden></p>
      </form>
      <a class="link" href="${esc(C.eventrrrApp)}" target="_blank" rel="noopener">No account? Create one on Eventrrr</a>
      <button class="link" type="button" data-close>Keep browsing</button>`;
    $('#em').focus();
  }
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
  } else if (f.id === 'email-form') {
    const s = await supa();
    const { error } = await s.auth.signInWithPassword({ email: $('#em').value.trim(), password: $('#pw').value });
    if (error) { const e = $('#em-err'); e.textContent = error.message; e.hidden = false; }
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
initAuth();
route();
