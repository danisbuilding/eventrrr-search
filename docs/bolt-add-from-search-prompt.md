# Bolt prompt: `add_from_search` (Eventrrr database only)

Status: not yet run. Run it in the **Eventrrr** Bolt project, then set `savingEnabled: true` in `public/config.js`.
It adds one column, two database functions and nothing else: no screens, no routes, no edge functions.

Also, in Bolt → Database → Authentication → URL configuration, add `https://search.eventrrr.com/**` to the
Redirect URLs (keep every existing entry). Without it, Google sign-in on Search returns to eventrrr.com instead.

```
I'm adding a separate site, search.eventrrr.com, where signed-in Eventrrr users can tap + on an event to save it to their own Eventrrr calendar. It signs in with this same Supabase project (same accounts) and calls two database functions. Please add only what's below. Don't change any screen, route, edge function, RLS policy or existing column.

## 1. Column
On `events`, add `scout_key text` (nullable) and a partial unique index on (user_id, scout_key) where scout_key is not null. Existing rows stay null.

## 2. Function `public.add_from_search(payload jsonb) returns jsonb`
SECURITY DEFINER, `set search_path = public`, granted to `authenticated` only (revoke from public and anon).
- `uid := auth.uid()`; if null, raise exception 'Sign in first'.
- Read ONLY these keys from payload: scout_key, title, description, starts_at, ends_at, all_day, timezone, venue, address, neighborhood, price_text, price_min, currency, url, category. Ignore every other key (user_id, status, calendars, visibility…).
- Validate exactly like the JSON import on the Paste text tab (src/lib/scoutImport.ts): non-empty title ≤ 200 chars, starts_at parses as a timestamp, url kept only if it starts with http:// or https://, category must be in the CATEGORIES list else 'Other', venue/address/neighborhood/price_text capped at 200, description at 1000, all_day default false, timezone default 'America/Mexico_City', currency default 'MXN'. scout_key is required, ≤ 200 chars.
- If an event with this (user_id = uid, scout_key) already exists, return `{"status": "exists", "event_id": <its id>}` and change nothing.
- Otherwise insert one event for uid the same way the JSON import does, except:
  - `status` = the "Interested" value, so it shows on the person's calendar right away (not "To review"),
  - `source_type` = 'import', `source_label` = 'Eventrrr Search', `scout_key` = payload.scout_key.
  Keep every other default the import uses (title_original = title, confidence 1, flagged_fields empty, etc.). Don't add it to any calendar.
- Return `{"status": "added", "event_id": <new id>}`.

## 3. Function `public.my_search_keys() returns text[]`
SECURITY DEFINER, `set search_path = public`, granted to `authenticated` only. Returns the non-null scout_key values of events where user_id = auth.uid() (deleted events excluded if the app soft-deletes). Empty array when none.

## Test, then tell me
1. As a signed-in user in the SQL editor (or via the app's client), call add_from_search with {"scout_key":"test|2026-11-14","title":"Test event","starts_at":"2026-11-14T20:00:00-06:00","category":"Music"}: returns status "added"; the event appears on my calendar as Interested with source "Eventrrr Search".
2. Call it again with the same scout_key: returns status "exists" with the same event_id; no second event.
3. Call it with "user_id" of another account and "status":"going" in the payload: the event is still mine and Interested.
4. Call it with "url":"javascript:alert(1)" and "category":"Nope": saved with no link and category Other.
5. Call it while signed out (anon): fails with 'Sign in first'.
6. my_search_keys() returns ["test|2026-11-14"] for me and [] for another account.
7. Delete the test event afterwards and tell me the migration file name.
```
