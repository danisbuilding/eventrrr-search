// Shared bits for the Pages Functions: JSON responses, per-IP rate limiting, cached Scout IQ metadata.
import { rpc } from './search.js';

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers } });

// Best-effort per-IP limit inside one Cloudflare isolate, plus the platform rate-limit binding when configured.
const buckets = new Map();
export async function allowed(request, env, { perMinute = 30, scope = 'search' } = {}) {
  const ip = request.headers.get('cf-connecting-ip') || 'anon';
  if (env.SEARCH_LIMITER && typeof env.SEARCH_LIMITER.limit === 'function') {
    try {
      const { success } = await env.SEARCH_LIMITER.limit({ key: `${scope}:${ip}` });
      if (!success) return false;
    } catch { /* binding unavailable: fall through to the local bucket */ }
  }
  const now = Date.now();
  const key = `${scope}:${ip}`;
  const b = buckets.get(key) || { n: 0, t: now };
  if (now - b.t > 60_000) { b.n = 0; b.t = now; }
  b.n += 1;
  buckets.set(key, b);
  if (buckets.size > 5000) buckets.clear();
  return b.n <= perMinute;
}

// search_meta() changes only when Scout runs; cache it at the edge for 10 minutes.
let memo = null;
export async function getMeta(env, ctx) {
  if (memo && Date.now() - memo.t < 600_000) return memo.v;
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const key = new Request('https://search.eventrrr.com/__meta_v1');
  if (cache) {
    const hit = await cache.match(key);
    if (hit) { const v = await hit.json(); memo = { v, t: Date.now() }; return v; }
  }
  const v = await rpc(env, 'search_meta', {});
  memo = { v, t: Date.now() };
  if (cache) {
    const put = cache.put(key, new Response(JSON.stringify(v), { headers: { 'cache-control': 'max-age=600' } }));
    if (ctx && ctx.waitUntil) ctx.waitUntil(put); else await put;
  }
  return v;
}
