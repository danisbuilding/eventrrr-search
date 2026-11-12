// Live check of search.eventrrr.com: the mechanical half of Agent Test Protocol v2.
//   Set A  filter correctness: every result of 20 filter combinations checked against the filter rules
//   Set C  keywords: rows really mention the keyword; the no-match note appears exactly when it should
//   Set E  interface on a phone (390×844) and desktop (1440×900): pills, dropdowns, URL, back, clear, detail
//   Speed  tap → list updated, and API time per request
// The rules are written here independently of lib/ (same definitions as the protocol), so a bug in the site's
// window or filter code shows up as a violation instead of being copied. Always test mode: nothing is logged.
//
//   node tests/live/check.mjs                      # writes tests/live/out/{report.md,results.json,*.png}
//   SEARCH_BASE=http://localhost:8788 node …       # against `npm run dev`
//   CHROME_PATH=/usr/bin/google-chrome node …       # use an installed Chrome instead of Playwright's
import { mkdirSync, writeFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = (process.env.SEARCH_BASE || 'https://search.eventrrr.com').replace(/\/$/, '');
const OUT = new URL('./out/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// The API allows 30 requests a minute per address: keep well under it.
const GAP = Number(process.env.CHECK_GAP_MS || 2300);

// ---------------------------------------------------------------- time (Mexico City: UTC−6, no daylight saving)
const OFF = 6 * 3600e3;
const local = (ms) => { const d = new Date(ms - OFF); return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: d.getUTCDay() }; };
const at = (p, days, h, mi = 0) => Date.UTC(p.y, p.m, p.d + days, h, mi) + OFF; // local wall time → UTC ms
const ymd = (ms) => { const p = local(ms); return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`; };
const hourOf = (iso) => local(Date.parse(iso)).h;

function windowFor(id, now, custom) {
  const t = local(now), wd = t.wd;
  const friOff = wd === 0 ? -2 : wd === 6 ? -1 : 5 - wd;
  const nextMon = ((8 - wd) % 7) || 7;
  switch (id) {
    case 'today': return [now, at(t, 0, 23, 59)];
    case 'tonight': return t.h < 4 ? [now, at(t, 0, 4)] : [Math.max(now, at(t, 0, 18)), at(t, 1, 4)];
    case 'tomorrow': return [at(t, 1, 0), at(t, 1, 23, 59)];
    case 'weekend': return [(wd === 0 || wd === 6 || (wd === 5 && t.h >= 18)) ? now : at(t, friOff, 18), at(t, friOff + 2, 23, 59)];
    case 'nextweek': return [at(t, nextMon, 0), at(t, nextMon + 6, 23, 59)];
    case 'custom': return [Date.parse(`${custom.from}T00:00:00-06:00`), Date.parse(`${custom.to}T23:59:00-06:00`)];
    default: return [now, at(t, 14, 23, 59)];
  }
}
function inWindow(r, [from, to], now) {
  const s = Date.parse(r.starts_at);
  const e = r.ends_at ? Date.parse(r.ends_at) : null;
  if (r.ongoing) return (e ?? s + 864e5) >= from - 60e3 && s <= to + 60e3;
  if (r.all_day) return ymd(s) >= ymd(from) && ymd(s) <= ymd(to - 6 * 3600e3);
  const startedEarly = from <= now + 10 * 60e3 && (e ?? s + 4 * 3600e3) >= from;
  return s <= to + 60e3 && (s >= from - 5 * 60e3 || startedEarly);
}
const bucket = (h) => (h >= 5 && h <= 11 ? 'morning' : h >= 12 && h <= 17 ? 'afternoon' : h >= 18 && h <= 21 ? 'evening' : 'late');
const fold = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// ---------------------------------------------------------------- API
const apiTimes = [];
async function search(filters) {
  await sleep(GAP);
  const t0 = Date.now();
  const res = await fetch(`${BASE}/api/search`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ browse: true, test: true, city: 'cdmx', filters }) });
  const d = await res.json().catch(() => ({}));
  apiTimes.push(Date.now() - t0);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${d.error || ''}`);
  return d;
}

// ---------------------------------------------------------------- Set A: filter correctness
const today = local(Date.now());
const plus = (n) => ymd(at(today, n, 12));
const SET_A = [
  ['A1', 'Default (next 2 weeks, ongoing hidden)', {}],
  ['A2', 'Show ongoing', { hide_ongoing: false }],
  ['A3', 'Today', { when: 'today' }],
  ['A4', 'Tonight', { when: 'tonight' }],
  ['A5', 'Tomorrow', { when: 'tomorrow' }],
  ['A6', 'This weekend', { when: 'weekend' }],
  ['A7', 'Next week', { when: 'nextweek' }],
  ['A8', `Pick dates ${plus(3)} → ${plus(5)}`, { when: 'custom', from: plus(3), to: plus(5) }],
  ['A9', 'Music', { categories: ['Music'] }],
  ['A10', 'Music + Clubs & Parties', { categories: ['Music', 'Clubs & Parties'] }],
  ['A11', 'Art & Exhibitions, show ongoing', { categories: ['Art & Exhibitions'], hide_ongoing: false }],
  ['A12', 'Free', { free: true }],
  ['A13', 'Paid', { paid: true }],
  ['A14', 'Evening', { times: ['evening'] }],
  ['A15', 'Morning + afternoon', { times: ['morning', 'afternoon'] }],
  ['A16', 'Outdoors (tag not visible: counted only)', { outdoor: true }],
  ['A17', 'Indoors (tag not visible: counted only)', { indoor: true }],
  ['A18', 'Kid-friendly (tag not visible: counted only)', { kids: true }],
  ['A19', 'Weekend + Music + Free + Evening', { when: 'weekend', categories: ['Music'], free: true, times: ['evening'] }],
  ['A20', 'Tonight + Tech + Morning (expect none)', { when: 'tonight', categories: ['Tech'], times: ['morning'], expectEmpty: true }],
];
function requestOf(spec) {
  const { when = 'any', from, to, expectEmpty, ...rest } = spec;
  return { ...(when === 'custom' ? { from: `${from}T00:00`, to: `${to}T23:59` } : { when }), hide_ongoing: true, ...rest };
}
function violations(r, spec, win, now) {
  const v = [];
  if (!inWindow(r, win, now)) v.push('outside window');
  const hide = spec.hide_ongoing !== false;
  if (hide && r.ongoing) v.push('ongoing shown while hidden');
  if (spec.categories?.length && !spec.categories.includes(r.category)) v.push(`category ${r.category}`);
  if (spec.free && r.is_free !== true) v.push('not free');
  if (spec.paid && (r.is_free || !(Number(r.price_min) > 0 || r.price_text))) v.push('not paid');
  if (spec.times?.length) {
    if (r.all_day || r.ongoing) v.push('no start time under a time filter');
    else if (!spec.times.includes(bucket(hourOf(r.starts_at)))) v.push(`starts ${hourOf(r.starts_at)}:00`);
  }
  return v;
}
async function setA() {
  const out = [];
  for (const [id, label, spec] of SET_A) {
    const now = Date.now();
    const win = windowFor(spec.when || 'any', now, spec);
    let d;
    try { d = await search(requestOf(spec)); } catch (e) { out.push({ id, label, error: e.message }); continue; }
    const rows = [...d.results, ...(d.more || [])];
    const bad = [];
    for (const r of rows) { const v = violations(r, spec, win, now); if (v.length) bad.push({ title: r.title, starts_at: r.starts_at, all_day: r.all_day, why: v }); }
    // the window the server used vs the definition (to the minute; "now" windows within 3 minutes)
    const sf = Date.parse(`${d.filters.from}:00-06:00`), st = Date.parse(`${d.filters.to}:00-06:00`);
    const windowOk = Math.abs(sf - win[0]) <= 3 * 60e3 && Math.abs(st - win[1]) <= 3 * 60e3;
    const dupes = [];
    const seen = new Map();
    for (const r of rows) { const k = `${fold(r.title)}|${ymd(Date.parse(r.starts_at))}`; if (seen.has(k)) dupes.push(r.title); seen.set(k, 1); }
    const emptyOk = spec.expectEmpty ? rows.length === 0 : true;
    out.push({ id, label, count: rows.length, checked: rows.length, bad, windowOk, server: [d.filters.from, d.filters.to],
      expected: [new Date(win[0] - OFF).toISOString().slice(0, 16), new Date(win[1] - OFF).toISOString().slice(0, 16)], dupes, emptyOk,
      allDay: rows.filter((r) => r.all_day && !r.ongoing).length, ongoing: rows.filter((r) => r.ongoing).length });
  }
  return out;
}

// ---------------------------------------------------------------- Set C: keywords
const SET_C = [
  ['C1', 'Garbage', { expect: 'match' }],
  ['C2', 'Karol G', { expect: 'match' }],
  ['C3', 'Tamayo', { expect: 'match' }],
  ['C4', 'Roma', { expect: 'match' }],
  ['C5a', 'Coyoacán', { expect: 'match', same: 'C5b' }],
  ['C5b', 'coyoacan', { expect: 'match' }],
  // Spanish words also match the original-language description, which the page doesn't show: listed, not scored.
  ['C6', 'taller', { expect: 'any', unscored: true }],
  ['C7', 'workshop', { expect: 'any' }],
  ['C8', 'jazz roma', { expect: 'any', words: true }],
  ['C9', 'ice skating', { expect: 'none' }],
  ['C10', 'garbaje', { expect: 'any', unscored: true }],
  ['C11', 'asdfgh', { expect: 'none' }],
  ['C12', 'art', { expect: 'any', unscored: true }],
];
function mentions(r, kw, words) {
  const hay = fold([r.title, r.title_original, r.venue, r.neighborhood, r.address, r.description].join(' '));
  const k = fold(kw);
  if (hay.includes(k)) return true;
  return words && k.split(/\s+/).filter((w) => w.length >= 4).some((w) => hay.includes(w));
}
async function setC() {
  const out = [];
  for (const [id, kw, o] of SET_C) {
    for (const ongoing of [false, true]) {
      let d;
      try { d = await search({ when: 'any', text: kw, hide_ongoing: !ongoing }); } catch (e) { out.push({ id, kw, ongoing, error: e.message }); continue; }
      const rows = [...d.results, ...(d.more || [])];
      const relaxed = !!d.relaxed && (d.relaxed_by || []).some((x) => /“/.test(x));
      const hits = relaxed ? 0 : rows.filter((r) => mentions(r, kw, o.words)).length;
      const noteRight = o.expect === 'none' ? relaxed : o.expect === 'match' ? !relaxed && rows.length > 0 : true;
      out.push({ id, kw, ongoing, count: rows.length, relaxed, hits, precision: relaxed || !rows.length ? null : hits / rows.length,
        noteRight, unscored: !!o.unscored, keys: rows.map((r) => r.key + r.starts_at).sort().join(','),
        misses: relaxed ? [] : rows.filter((r) => !mentions(r, kw, o.words)).map((r) => r.title).slice(0, 5) });
    }
  }
  // accents: same results either way
  for (const ongoing of [false, true]) {
    const a = out.find((x) => x.id === 'C5a' && x.ongoing === ongoing), b = out.find((x) => x.id === 'C5b' && x.ongoing === ongoing);
    if (a && b) a.sameAsC5b = a.keys === b.keys;
  }
  return out;
}

// ---------------------------------------------------------------- Set E + speed: the page itself
async function setE(browser) {
  const out = [], speed = [];
  const ok = (vp, id, pass, detail = '') => out.push({ vp, id, result: pass ? 'Pass' : 'Fail', detail });
  for (const [vp, viewport, scale] of [['phone', { width: 390, height: 844 }, 2], ['desktop', { width: 1440, height: 900 }, 1]]) {
    const ctx = await browser.newContext({ viewport, deviceScaleFactor: scale });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const settle = async () => { await page.waitForFunction(() => !document.querySelector('#result-list')?.classList.contains('dim'), null, { timeout: 15000 }); await sleep(300); };
    const open = async (q = '') => { await sleep(GAP); await page.goto(`${BASE}/?test=1${q}`); await page.waitForSelector('#result-list .count, #result-list .empty', { timeout: 20000 }); await settle(); };
    const pill = (id) => page.locator(`#finder [data-pop="${id}"]:visible`).first();
    const timed = async (fn, label) => {
      await sleep(GAP);
      const t0 = Date.now();
      const resp = page.waitForResponse((r) => r.url().includes('/api/search'), { timeout: 15000 });
      await fn();
      await resp; await settle();
      speed.push({ vp, label, ms: Date.now() - t0 - 300 });
    };
    try {
      await open();
      // E1: pills on one line
      const tops = await page.$$eval('#f-pills > button', (bs) => bs.filter((b) => b.offsetParent).map((b) => [b.textContent.trim(), b.offsetTop]));
      const want = vp === 'phone' ? 3 : 7;
      ok(vp, 'E1 pills on one line', tops.length === want && new Set(tops.map((t) => t[1])).size === 1, tops.map((t) => t[0]).join(' · '));
      // E2: headings and "All" first
      const firstOf = { when: 'Next 2 weeks', what: 'All event types', price: 'All prices', time: 'All times', setting: 'Indoors and outdoors', ongoing: 'Hide ongoing' };
      for (const id of vp === 'phone' ? ['when', 'what', 'ongoing', 'more'] : ['when', 'what', 'price', 'time', 'setting', 'ongoing', 'more']) {
        await pill(id).click(); await sleep(250);
        const info = await page.$eval('#f-pop', (p) => ({ shown: !p.hidden, head: p.querySelector('.phead')?.textContent || '', first: p.querySelector('.mopt')?.textContent.trim() || '', text: p.textContent }));
        const firstOk = !firstOf[id] || info.first === firstOf[id];
        ok(vp, `E2 ${id} dropdown`, info.shown && !!info.head && firstOk, `heading "${info.head}", first "${info.first}"`);
        if (id === 'ongoing') {
          const radios = await page.$$eval('#f-pop .mopt', (m) => m.map((x) => [x.textContent.trim(), x.getAttribute('aria-checked'), x.getAttribute('role')]));
          ok(vp, 'E5 Hide/Show ongoing radios, Hide picked', radios.length === 2 && radios[0][1] === 'true' && radios.every((r) => r[2] === 'menuitemradio'), JSON.stringify(radios));
        }
        if (id === 'more') ok(vp, 'E6 Kid-friendly inside More', /Kid-friendly only/.test(info.text), '');
        // E8: Escape closes
        await page.keyboard.press('Escape'); await sleep(150);
        ok(vp, `E8 Escape closes ${id}`, await page.$eval('#f-pop', (p) => p.hidden), '');
      }
      // E3 + E4: checkboxes stay open; pill label; URL; speed
      await pill('what').click(); await sleep(250);
      await timed(() => page.click('#f-pop [data-cat="Music"]'), 'pick Music');
      const stillOpen = await page.$eval('#f-pop', (p) => !p.hidden);
      await timed(() => page.click('#f-pop [data-cat="Clubs & Parties"]'), 'pick Clubs & Parties');
      const label = (await pill('what').textContent()).trim();
      ok(vp, 'E3 Event type checkboxes stay open', stillOpen, '');
      ok(vp, 'E4 pill shows picks and turns green', label === 'Music +1' && await pill('what').evaluate((b) => b.classList.contains('on')), `"${label}"`);
      ok(vp, 'E9 address carries filters', /what=Music/.test(page.url()) && /Clubs/.test(decodeURIComponent(page.url())), page.url());
      await page.keyboard.press('Escape');
      // single choice closes (When)
      await pill('when').click(); await sleep(200);
      await timed(() => page.click('#f-pop [data-when="weekend"]'), 'pick This weekend');
      ok(vp, 'E3 When closes on pick', await page.$eval('#f-pop', (p) => p.hidden), '');
      // E9: Back restores the previous filters
      await sleep(GAP); await page.goBack(); await settle();
      ok(vp, 'E9 Back restores filters', !/when=weekend/.test(page.url()) && (await pill('when').textContent()).trim() === 'Next 2 weeks', page.url());
      // E10: Clear filters resets everything, ongoing back to hidden
      await page.goto(`${BASE}/?test=1&what=Music&ongoing=show&price=free`); await page.waitForSelector('#result-list .count, #result-list .empty'); await settle();
      await timed(() => page.click('#clear-all'), 'clear filters');
      ok(vp, 'E10 Clear filters resets', page.url().endsWith('?test=1') && (await pill('ongoing').textContent()).trim() === 'Hide ongoing', page.url());
      // E7: keywords placeholder and size
      const kw = await page.$eval('#kw', (i) => ({ ph: i.placeholder, w: i.closest('form').offsetWidth }));
      ok(vp, 'E7 Keywords box', vp === 'phone' ? kw.ph === 'Keywords' && kw.w <= 180 : /^Keywords, e\.g\./.test(kw.ph) && kw.w <= 320, `"${kw.ph}", ${kw.w}px`);
      await timed(async () => { await page.fill('#kw', 'Garbage'); await page.press('#kw', 'Enter'); }, 'keyword Enter');
      ok(vp, 'C keyword in the page finds Garbage', (await page.textContent('#result-list')).includes('Garbage'), '');
      await page.click('#kw-x'); await sleep(GAP); await settle();
      // E11: city menu
      await page.click('#city-btn'); await sleep(200);
      const city = await page.$eval('#city-pop', (p) => ({ shown: !p.hidden, head: p.querySelector('.phead')?.textContent, opts: p.querySelectorAll('.mopt').length }));
      ok(vp, 'E11 city menu', city.shown && city.head === 'City' && city.opts >= 1, JSON.stringify(city));
      await page.keyboard.press('Escape');
      // E12: detail with the original title (a Spanish-titled event)
      await open('&kw=taller');
      const row = page.locator('#result-list [data-open]').first();
      if (await row.count()) {
        await row.click(); await sleep(600);
        const det = await page.evaluate(() => {
          const scope = document.querySelector('#pane:not([hidden]) , dialog[open]') || document;
          return { h1: scope.querySelector('h1')?.textContent || '', orig: scope.querySelector('.orig')?.textContent || '', link: !!scope.querySelector('a[href^="http"]') };
        });
        ok(vp, 'E12 detail: English title, original below, listing link', !!det.h1 && det.link, `"${det.h1}" / "${det.orig}"`);
        await page.keyboard.press('Escape');
      } else ok(vp, 'E12 detail', false, 'no row for "taller"');
      // E13: empty state
      await open('&when=tonight&what=Tech&time=morning');
      ok(vp, 'E13 empty state offers Clear all filters', await page.locator('#result-list .empty #clear-all').count() === 1, '');
      // E14: nothing wider than the screen
      await open();
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      ok(vp, 'E14 no sideways scroll', wide <= 1, `${wide}px over`);
      // count line matches rows
      const cnt = await page.evaluate(() => ({ said: Number(document.querySelector('#result-list .count b')?.textContent || -1), rows: document.querySelectorAll('#result-list [data-open]').length }));
      ok(vp, 'Count matches rows shown', cnt.said === cnt.rows, JSON.stringify(cnt));
      await page.screenshot({ path: `${OUT}${vp}.png` });
      ok(vp, 'No page errors', errors.length === 0, errors.slice(0, 2).join(' | '));
    } catch (e) {
      ok(vp, 'Run', false, e.message.split('\n')[0]);
      await page.screenshot({ path: `${OUT}${vp}-error.png` }).catch(() => {});
    }
    await ctx.close();
  }
  return { out, speed };
}

// ---------------------------------------------------------------- report
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(1)}%` : '—');
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
function report(A, C, E, speed, started) {
  const checked = A.reduce((n, a) => n + (a.checked || 0), 0);
  const tagOnly = new Set(['A16', 'A17', 'A18']);
  const scored = A.filter((a) => !tagOnly.has(a.id));
  const badRows = scored.reduce((n, a) => n + (a.bad?.length || 0), 0);
  const scoredRows = scored.reduce((n, a) => n + (a.checked || 0), 0);
  const winBad = A.filter((a) => a.windowOk === false);
  const Cs = C.filter((c) => !c.unscored && !c.error);
  const noteOk = Cs.filter((c) => c.noteRight).length;
  const precRows = Cs.filter((c) => c.precision != null);
  const hits = precRows.reduce((n, c) => n + c.hits, 0), shown = precRows.reduce((n, c) => n + c.count, 0);
  const eFail = E.filter((e) => e.result === 'Fail');
  const taps = speed.map((s) => s.ms);
  const L = [];
  L.push(`# Search live check — ${new Date(started - OFF).toISOString().slice(0, 16).replace('T', ' ')} Mexico City`, '');
  L.push(`${BASE}, test mode. Mechanical half of Agent Test Protocol v2 (Sets A, C, E and speed).`, '');
  L.push('| Measure | Result | Target |', '| --- | --- | --- |');
  L.push(`| Filter correctness (Set A, ${scored.length} combinations) | ${pct(scoredRows - badRows, scoredRows)} of ${scoredRows} rows | 100% |`);
  L.push(`| Windows match the definitions | ${A.length - winBad.length}/${A.length} | all |`);
  L.push(`| Duplicates (same title, same day) | ${A.reduce((n, a) => n + (a.dupes?.length || 0), 0)} | 0 |`);
  L.push(`| Keyword notes right (Set C) | ${noteOk}/${Cs.length} | all |`);
  L.push(`| Keyword precision (rows whose shown text has the word) | ${pct(hits, shown)} of ${shown} rows | 95% |`);
  L.push(`| Interface (Set E) | ${E.length - eFail.length}/${E.length} pass | 0 fails |`);
  L.push(`| Speed: tap → list | median ${median(taps)} ms, slowest ${Math.max(...taps, 0)} ms (${taps.length} taps) | < 1000 / < 3000 |`);
  L.push(`| Speed: API | median ${median(apiTimes)} ms, slowest ${Math.max(...apiTimes, 0)} ms (${apiTimes.length} calls) | — |`);
  L.push('', '## Set A: filter correctness', '', '| # | Filters | Rows | All-day | Ongoing | Violations | Window (server vs rule) |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const a of A) {
    if (a.error) { L.push(`| ${a.id} | ${a.label} | error | | | ${a.error} | |`); continue; }
    const v = tagOnly.has(a.id) ? 'not checkable (tag hidden)' : a.bad.length ? a.bad.length : (a.emptyOk ? '0' : 'expected none');
    L.push(`| ${a.id} | ${a.label} | ${a.count} | ${a.allDay} | ${a.ongoing} | ${v} | ${a.windowOk ? 'match' : `server ${a.server.join(' → ')} / rule ${a.expected.join(' → ')}`} |`);
  }
  const allBad = scored.flatMap((a) => (a.bad || []).map((b) => `- ${a.id}: ${b.title} (${b.all_day ? 'all day ' : ''}${b.starts_at.slice(0, 16)}): ${b.why.join(', ')}`));
  if (allBad.length) L.push('', '**Violations**', '', ...allBad.slice(0, 40));
  const d = A.flatMap((a) => (a.dupes || []).map((t) => `- ${a.id}: ${t}`));
  if (d.length) L.push('', '**Duplicates**', '', ...d.slice(0, 20));
  L.push('', '## Set C: keywords', '', '| # | Keyword | Ongoing | Rows | No-match note | Note right | Rows mentioning it |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const c of C) {
    if (c.error) { L.push(`| ${c.id} | ${c.kw} | ${c.ongoing ? 'shown' : 'hidden'} | error: ${c.error} | | | |`); continue; }
    L.push(`| ${c.id}${c.unscored ? ' (not scored)' : ''} | ${c.kw} | ${c.ongoing ? 'shown' : 'hidden'} | ${c.count} | ${c.relaxed ? 'yes' : 'no'} | ${c.noteRight ? 'yes' : 'NO'} | ${c.relaxed ? '—' : `${c.hits}/${c.count}`}${c.misses.length ? ` (not found in shown text: ${c.misses.join('; ')})` : ''}${c.sameAsC5b === false ? ' · differs from "coyoacan"' : ''} |`);
  }
  L.push('', 'A row "not found in shown text" may still match the original-language description, which the page does not show; check before calling it a false hit.');
  L.push('', '## Set E: interface', '', '| Viewport | Check | Result | Detail |', '| --- | --- | --- | --- |');
  for (const e of E) L.push(`| ${e.vp} | ${e.id} | ${e.result} | ${String(e.detail).replace(/\|/g, '/').slice(0, 160)} |`);
  L.push('', '## Speed', '', '| Viewport | Action | ms |', '| --- | --- | --- |', ...speed.map((s) => `| ${s.vp} | ${s.label} | ${s.ms} |`));
  return { md: L.join('\n'), fails: badRows + winBad.length + (Cs.length - noteOk) + eFail.length };
}

const started = Date.now();
const A = await setA();
const C = await setC();
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH, args: ['--no-sandbox'] } : {});
const { out: E, speed } = await setE(browser);
await browser.close();
const { md, fails } = report(A, C, E, speed, started);
writeFileSync(`${OUT}report.md`, md);
writeFileSync(`${OUT}results.json`, JSON.stringify({ base: BASE, started: new Date(started).toISOString(), A, C, E, speed, apiTimes }, null, 2));
console.log(md);
console.log(`\n${fails} failing checks`);
process.exitCode = fails ? 1 : 0;
