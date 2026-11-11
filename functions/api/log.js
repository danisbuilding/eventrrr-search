// POST /api/log { query_id, action: open|add|link|more, event_key } → Scout IQ search_actions
import { rpc } from '../../lib/search.js';
import { json, allowed } from '../../lib/http.js';

export async function onRequestPost({ request, env, waitUntil }) {
  if (!(await allowed(request, env, { perMinute: 120, scope: 'log' }))) return new Response(null, { status: 204 });
  let b;
  try { b = await request.json(); } catch { return new Response(null, { status: 204 }); }
  const action = ['open', 'add', 'link', 'more'].includes(b.action) ? b.action : null;
  const qid = /^[0-9a-f-]{36}$/i.test(b.query_id || '') ? b.query_id : null;
  if (action) {
    waitUntil(rpc(env, 'log_search_action', { query_id: qid, action, event_key: String(b.event_key || '').slice(0, 200) }).catch(() => null));
  }
  return new Response(null, { status: 204 });
}
