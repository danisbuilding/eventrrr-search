// GET /api/meta → cities, last update time (for "Events updated …"). Profiles stay server-side.
import { json, getMeta } from '../../lib/http.js';

export async function onRequestGet({ env, waitUntil }) {
  try {
    const m = await getMeta(env, { waitUntil });
    return json({ cities: m.cities, updated_at: m.updated_at }, 200, { 'cache-control': 'public, max-age=300' });
  } catch {
    return json({ cities: [], updated_at: null }, 200);
  }
}
