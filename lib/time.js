// Time helpers that work in a city's own time zone without any date library.

// Wall-clock parts of an instant in a time zone.
export function zonedParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
  });
  const p = Object.fromEntries(f.formatToParts(date).map((x) => [x.type, x.value]));
  return {
    year: +p.year, month: +p.month, day: +p.day, hour: +p.hour, minute: +p.minute, second: +p.second,
    weekday: p.weekday, // Mon, Tue, …
  };
}

// Offset (ms) of a time zone at an instant: local wall clock minus UTC.
export function tzOffsetMs(date, tz) {
  const p = zonedParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

// "2026-11-14T18:00" (wall clock in tz) → Date (UTC instant).
export function zonedToDate(local, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(local || '');
  if (!m) return null;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0));
  let d = new Date(guess - tzOffsetMs(new Date(guess), tz));
  // Second pass settles DST edges.
  d = new Date(guess - tzOffsetMs(d, tz));
  return d;
}

export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (p) => `${p.year}-${pad(p.month)}-${pad(p.day)}`;

// Calendar date in tz, shifted by n days (pure date arithmetic on the wall-clock date).
export function addDays(p, n) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), weekday: WEEKDAYS[d.getUTCDay()] };
}

export function weekdayIndex(p) {
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay(); // 0 = Sunday
}

// Default windows used by the keyword fallback (and as hints for the model).
export function windows(now, tz) {
  const today = zonedParts(now, tz);
  const nowLocal = `${ymd(today)}T${pad(today.hour)}:${pad(today.minute)}`;
  const wd = weekdayIndex(today);
  const friOffset = wd === 0 ? -2 : wd === 6 ? -1 : 5 - wd; // this weekend's Friday (or the one in progress)
  const fri = addDays(today, friOffset);
  const sun = addDays(fri, 2);
  const tomorrow = addDays(today, 1);
  return {
    now: nowLocal,
    today: { from: nowLocal, to: `${ymd(today)}T23:59` },
    tonight: { from: nowLocal, to: `${ymd(tomorrow)}T04:00` },
    tomorrow: { from: `${ymd(tomorrow)}T00:00`, to: `${ymd(tomorrow)}T23:59` },
    weekend: { from: wd === 0 || wd === 6 || (wd === 5 && today.hour >= 18) ? nowLocal : `${ymd(fri)}T18:00`, to: `${ymd(sun)}T23:59` },
    week: { from: nowLocal, to: `${ymd(addDays(today, 7))}T23:59` },
    default: { from: nowLocal, to: `${ymd(addDays(today, 14))}T23:59` },
  };
}

// "Sat 14 – Sun 15 Nov", "Tonight", "Thu 13 Nov"
export function rangeLabel(fromLocal, toLocal, w) {
  if (!fromLocal || !toLocal) return null;
  if (w && fromLocal === w.tonight.from && toLocal === w.tonight.to) return 'Tonight';
  const a = parse(fromLocal), b = parse(toLocal);
  if (!a || !b) return null;
  const da = `${WEEKDAYS[weekdayIndex(a)]} ${a.day}`;
  const db = `${WEEKDAYS[weekdayIndex(b)]} ${b.day}`;
  if (a.year === b.year && a.month === b.month && a.day === b.day) return `${da} ${MONTHS[a.month - 1]}`;
  // An early-morning end (before 6am) belongs to the night before.
  if (b.hour < 6) {
    const prev = addDays(b, -1);
    if (prev.year === a.year && prev.month === a.month && prev.day === a.day) return `${da} ${MONTHS[a.month - 1]}`;
  }
  return a.month === b.month ? `${da} – ${db} ${MONTHS[b.month - 1]}` : `${da} ${MONTHS[a.month - 1]} – ${db} ${MONTHS[b.month - 1]}`;
}

function parse(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  return m ? { year: +m[1], month: +m[2], day: +m[3], hour: +m[4], minute: +m[5] } : null;
}
