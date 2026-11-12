// POST /api/search  { q: "free stuff this weekend", city?: "cdmx", filters?: {…edited chips…} }
import { search } from '../../lib/search.js';
import { json, allowed, getMeta } from '../../lib/http.js';

export async function onRequestPost({ request, env, waitUntil }) {
  if (!(await allowed(request, env, { perMinute: 30 }))) {
    return json({ error: 'Too many searches in a minute. Try again shortly.' }, 429);
  }
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  const q = typeof body.q === 'string' ? body.q.trim().slice(0, 300) : '';
  const overrides = body.filters && typeof body.filters === 'object' ? body.filters : null;
  if (!q && !overrides) return json({ error: 'Type something to search for.' }, 400);
  try {
    const meta = await getMeta(env, { waitUntil });
    const result = await search({ q, city: body.city, overrides, debug: body.debug === true, tune: body.test === true && body.tune ? body.tune : null }, { env, meta, waitUntil, log: body.test === true ? null : (p) => waitUntil(p) });
    return json(result, 200, { 'cache-control': 'no-store' });
  } catch (e) {
    console.error('search failed', e && e.message);
    return json({ error: 'Search is having trouble right now. Try again in a minute.' }, 502);
  }
}

export const onRequestGet = () => json({ error: 'Use POST' }, 405);
